#!/usr/bin/env python3
"""Build the four Overwolf store icon files from one master logo.

There is no PIL and no ImageMagick on this machine, so everything is written by
hand: a PNG decoder and encoder, a DIB encoder for the ICO entries, and a
box-filter resampler.

The master is cropped to the mark's bounding box and re-padded to a centred square
first. The generated art arrives with asymmetric margins - the master used here
had 172 px on the left against 157 on the right - which would make the icon look
off-centre in the dock, where it is drawn at 37 px.

Every ICO entry is a straight downscale, including 16 and 24 px. See SIMPLIFY_AT
for why the ring is not removed from the tiny entries.

Usage: build-store-icons.py <master.png> <out-dir>
"""
import os
import struct
import sys
import zlib


def read_chunks(data):
    offset = 8
    while offset < len(data):
        length, ctype = struct.unpack(">I4s", data[offset: offset + 8])
        body = data[offset + 8: offset + 8 + length]
        yield ctype, body
        offset += 12 + length


def paeth(left, up, up_left):
    p = left + up - up_left
    pa, pb, pc = abs(p - left), abs(p - up), abs(p - up_left)
    if pa <= pb and pa <= pc:
        return left
    if pb <= pc:
        return up
    return up_left


def decode(path):
    """Decode a non-interlaced 8-bit PNG to RGB, handling RGB, RGBA and palette."""
    data = open(path, "rb").read()
    idat = b""
    palette = b""
    width = height = depth = ctype = None
    for kind, body in read_chunks(data):
        if kind == b"IHDR":
            width, height, depth, ctype, _comp, _filt, interlace = struct.unpack(">IIBBBBB", body)
            if interlace:
                raise SystemExit(f"{path}: interlaced PNG is not supported here")
        elif kind == b"PLTE":
            palette = body
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break

    channels = {2: 3, 3: 1, 6: 4}.get(ctype)
    if depth != 8 or channels is None:
        raise SystemExit(f"{path}: expected 8-bit RGB, RGBA or palette, got depth={depth} colour={ctype}")

    raw = zlib.decompress(idat)
    stride = width * channels
    pixels = bytearray(height * stride)
    previous = bytearray(stride)
    position = 0
    for row in range(height):
        filt = raw[position]
        position += 1
        line = bytearray(raw[position: position + stride])
        position += stride
        for index in range(stride):
            left = line[index - channels] if index >= channels else 0
            up = previous[index]
            up_left = previous[index - channels] if index >= channels else 0
            if filt == 1:
                line[index] = (line[index] + left) & 0xFF
            elif filt == 2:
                line[index] = (line[index] + up) & 0xFF
            elif filt == 3:
                line[index] = (line[index] + ((left + up) >> 1)) & 0xFF
            elif filt == 4:
                line[index] = (line[index] + paeth(left, up, up_left)) & 0xFF
        pixels[row * stride: (row + 1) * stride] = line
        previous = line

    if ctype != 3:
        return width, height, channels, bytes(pixels)

    expanded = bytearray(width * height * 3)
    for pixel in range(width * height):
        entry = pixels[pixel] * 3
        expanded[pixel * 3: pixel * 3 + 3] = palette[entry: entry + 3]
    return width, height, 3, bytes(expanded)

# Exactly the sizes Overwolf requires for launcher_icon, and no others. Their
# release guide is explicit: "Make sure that your icon's layer sizes include all of
# (and only) the above sizes (16x16, 32x32, 48x48, 256x256)". An earlier build of
# this script used six sizes (adding 24 and 64, which is the usual Windows
# practice) and so violated the "only" half of that rule.
ICO_SIZES = [256, 48, 32, 16]
MARK_FILL = 0.80  # fraction of the canvas the mark should occupy

# Every ICO entry is a straight downscale of the master, including 16 and 24 px.
# Two attempts at dropping the orbit ring for the tiny entries both failed, and
# measurably so:
#
#  - keeping the largest connected component changes nothing, because by 24 px the
#    ring has blurred into the letter and the two are a single blob;
#  - morphological opening does remove the ring, but 3x3 is the smallest kernel
#    there is and at 16 px the letter's strokes are only 3-4 px wide, so erosion
#    leaves one sliver of the letter and nothing else.
#
# A genuinely clean 16 px entry needs simplified ART - the letter drawn on its own,
# without the ring - which is a design decision, not a filter. Until that exists,
# the ring is faint but present at 16 px, and the letter still reads.
SIMPLIFY_AT = set()


# --- encoding -----------------------------------------------------------------

def png_encode(width, height, rgba):
    """Encode 8-bit RGBA as a PNG (filter type 0 on every scanline)."""
    raw = bytearray()
    stride = width * 4
    for row in range(height):
        raw.append(0)
        raw.extend(rgba[row * stride:(row + 1) * stride])

    def chunk(kind, body):
        return (
            struct.pack(">I", len(body))
            + kind
            + body
            + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"pHYs", phys_chunk())
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def phys_chunk(dpi=72):
    """A pHYs chunk declaring the image resolution.

    Overwolf's asset requirements say the icons must be "256x256 pixels with at
    least 72 PPI". A PNG without pHYs has no declared resolution at all, so a
    reviewer checking that line has nothing to read. 72 DPI is the documented
    minimum and what the spec asks for.
    """
    per_metre = int(round(dpi / 0.0254))
    return struct.pack(">IIB", per_metre, per_metre, 1)


def corner_radius(size):
    """22% of the side - the usual proportion for an app-icon corner.

    Floored at 2 px so the 16 px layer still reads as rounded rather than square.
    """
    return max(2, int(round(size * 0.22)))


def round_corners(rgba, size, radius):
    """Set alpha outside a rounded rectangle, so the icon has transparent corners.

    Two documented requirements meet here. The dock icons are described as
    "rounded" while the window icon is "squared", and the launcher icon is "a
    256x256 transparent .png converted into an .ico" - a fully opaque square has
    no transparency at all. Rounding the dock icons and the launcher satisfies
    both readings at once, and keeps the launcher looking like the dock icon as
    the guide also asks.

    Edge pixels get partial alpha so the corner is antialiased rather than jagged.
    """
    out = bytearray(rgba)
    for y in range(size):
        for x in range(size):
            # Distance to the nearest corner centre, 0 in the straight sections.
            dx = 0
            if x < radius:
                dx = radius - x
            elif x > size - 1 - radius:
                dx = x - (size - 1 - radius)
            dy = 0
            if y < radius:
                dy = radius - y
            elif y > size - 1 - radius:
                dy = y - (size - 1 - radius)
            if dx == 0 or dy == 0:
                continue
            distance = (dx * dx + dy * dy) ** 0.5
            if distance <= radius - 0.5:
                continue
            coverage = max(0.0, min(1.0, radius + 0.5 - distance))
            index = (y * size + x) * 4 + 3
            out[index] = int(out[index] * coverage)
    return bytes(out)


def quantize(rgba, max_colors=64):
    """Median-cut the image down to a palette.

    A straight RGBA PNG of this art is 46 KB, over Overwolf's 30 KB limit, because
    the antialiased edges blend the amber into the dark background and produce
    hundreds of near-identical shades. The mark is really two colours plus a ramp,
    so a small palette is visually lossless here and compresses far better.
    """
    # Two lists on purpose. Median cut sorts its boxes in place, and the first box
    # IS the pixel list, so building the index stream from it afterwards would walk
    # the pixels in sorted order instead of image order - which scrambles the
    # picture into a smear. `ordered` keeps the original raster order for the final
    # pass; `working` is what the splitting may reorder.
    ordered = [
        (rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3])
        for i in range(0, len(rgba), 4)
    ]
    working = list(ordered)
    boxes = [working]
    while len(boxes) < max_colors:
        target = None
        widest = -1
        for box in boxes:
            if len(box) < 2:
                continue
            # Alpha is a dimension too: the rounded corners add a transparency
            # ramp that a colour-only split would quantise into visible steps.
            for channel in range(4):
                values = [p[channel] for p in box]
                spread = max(values) - min(values)
                if spread > widest:
                    widest, target = spread, (box, channel)
        if target is None or widest == 0:
            break
        box, channel = target
        box.sort(key=lambda p: p[channel])
        middle = len(box) // 2
        boxes.remove(box)
        boxes.append(box[:middle])
        boxes.append(box[middle:])

    palette = []
    for box in boxes:
        if not box:
            continue
        count = len(box)
        palette.append(
            (
                sum(p[0] for p in box) // count,
                sum(p[1] for p in box) // count,
                sum(p[2] for p in box) // count,
                sum(p[3] for p in box) // count,
            )
        )
    while len(palette) < 2:
        palette.append((0, 0, 0, 255))

    cache = {}
    indices = bytearray()
    for pixel in ordered:
        found = cache.get(pixel)
        if found is None:
            best, best_distance = 0, 1 << 30
            for position, entry in enumerate(palette):
                distance = (
                    (pixel[0] - entry[0]) ** 2
                    + (pixel[1] - entry[1]) ** 2
                    + (pixel[2] - entry[2]) ** 2
                    + (pixel[3] - entry[3]) ** 2
                )
                if distance < best_distance:
                    best, best_distance = position, distance
            found = best
            cache[pixel] = found
        indices.append(found)
    return palette, bytes(indices)


def png_encode_palette(width, height, indices, palette):
    """Colour-type 3 PNG: one byte per pixel, a palette, and alpha when needed.

    Palette entries are (r, g, b, a). Transparency travels in a tRNS chunk, which
    is why the rounded corners can still ship as a palette PNG - an RGBA PNG of
    this art is 46 KB, over the 30 KB the store allows.
    """
    raw = bytearray()
    for row in range(height):
        raw.append(0)
        raw.extend(indices[row * width:(row + 1) * width])

    def chunk(kind, body):
        return (
            struct.pack(">I", len(body))
            + kind
            + body
            + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
        )

    plte = b"".join(bytes(entry[:3]) for entry in palette)
    alphas = [entry[3] for entry in palette]
    while alphas and alphas[-1] == 255:
        alphas.pop()
    header = struct.pack(">IIBBBBB", width, height, 8, 3, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"PLTE", plte)
        + (chunk(b"tRNS", bytes(alphas)) if alphas else b"")
        + chunk(b"pHYs", phys_chunk())
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def dib_encode(width, height, rgba):
    """Encode one ICO entry as a 32-bit bottom-up DIB plus its AND mask."""
    pixels = bytearray()
    for y in range(height - 1, -1, -1):
        for x in range(width):
            index = (y * width + x) * 4
            r, g, b, a = rgba[index], rgba[index + 1], rgba[index + 2], rgba[index + 3]
            pixels += bytes((b, g, r, a))

    mask_stride = ((width + 31) // 32) * 4
    mask = bytearray()
    for y in range(height - 1, -1, -1):
        row = bytearray()
        for x in range(width):
            alpha = rgba[(y * width + x) * 4 + 3]
            row.append(0 if alpha >= 128 else 1)
        bits = bytearray(mask_stride)
        for x, opaque_bit in enumerate(row):
            if opaque_bit:
                bits[x // 8] |= 0x80 >> (x % 8)
        mask += bits

    header = struct.pack("<IiiHHIIiiII", 40, width, height * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    return header + bytes(pixels) + bytes(mask)


def ico_encode(entries):
    """entries: list of (width, height, payload). PNG is used only at 256."""
    count = len(entries)
    directory = b""
    offset = 6 + 16 * count
    blobs = b""
    for width, height, payload in entries:
        directory += struct.pack(
            "<BBBBHHII",
            width if width < 256 else 0,
            height if height < 256 else 0,
            0,
            0,
            1,
            32,
            len(payload),
            offset,
        )
        blobs += payload
        offset += len(payload)
    return struct.pack("<HHH", 0, 1, count) + directory + blobs


# --- image operations ---------------------------------------------------------

def load_master(path):
    width, height, channels, pixels = decode(path)
    rgb = bytearray(width * height * 3)
    for index in range(width * height):
        source = index * channels
        target = index * 3
        rgb[target] = pixels[source]
        rgb[target + 1] = pixels[source + 1]
        rgb[target + 2] = pixels[source + 2]
    return width, height, rgb


def bounding_box(width, height, rgb):
    corner = (rgb[0], rgb[1], rgb[2])

    def is_mark(x, y):
        index = (y * width + x) * 3
        return (
            abs(rgb[index] - corner[0])
            + abs(rgb[index + 1] - corner[1])
            + abs(rgb[index + 2] - corner[2])
            > 40
        )

    min_x, min_y, max_x, max_y = width, height, -1, -1
    for y in range(height):
        for x in range(width):
            if is_mark(x, y):
                min_x, min_y = min(min_x, x), min(min_y, y)
                max_x, max_y = max(max_x, x), max(max_y, y)
    return min_x, min_y, max_x, max_y


def recentre(width, height, rgb):
    """Crop to the mark, then centre it in a square at MARK_FILL of the width."""
    min_x, min_y, max_x, max_y = bounding_box(width, height, rgb)
    mark_w, mark_h = max_x - min_x + 1, max_y - min_y + 1
    side = int(round(max(mark_w, mark_h) / MARK_FILL))
    left = (side - mark_w) // 2
    top = (side - mark_h) // 2
    corner = (rgb[0], rgb[1], rgb[2])

    out = bytearray()
    for y in range(side):
        for x in range(side):
            sx, sy = min_x + x - left, min_y + y - top
            if 0 <= sx < width and 0 <= sy < height:
                index = (sy * width + sx) * 3
                out += bytes((rgb[index], rgb[index + 1], rgb[index + 2]))
            else:
                out += bytes(corner)
    return side, side, out


def resample(width, height, rgb, target):
    """Area-weighted box filter: every source pixel contributes by its overlap."""
    scale = width / target
    out = bytearray()
    for ty in range(target):
        y0, y1 = ty * scale, (ty + 1) * scale
        for tx in range(target):
            x0, x1 = tx * scale, (tx + 1) * scale
            r = g = b = area = 0.0
            for sy in range(int(y0), min(int(y1) + 1, height)):
                cover_y = min(sy + 1, y1) - max(sy, y0)
                if cover_y <= 0:
                    continue
                for sx in range(int(x0), min(int(x1) + 1, width)):
                    cover_x = min(sx + 1, x1) - max(sx, x0)
                    if cover_x <= 0:
                        continue
                    weight = cover_x * cover_y
                    index = (sy * width + sx) * 3
                    r += rgb[index] * weight
                    g += rgb[index + 1] * weight
                    b += rgb[index + 2] * weight
                    area += weight
            if area == 0:
                out += bytes((0, 0, 0, 255))
            else:
                out += bytes(
                    (
                        int(r / area + 0.5),
                        int(g / area + 0.5),
                        int(b / area + 0.5),
                        255,
                    )
                )
    return bytes(out)


def desaturate(rgb):
    """Desaturate 3-channel RGB data.

    The stride must be 3: `recentre` and `resample` work in RGB, and an earlier
    version of this stepped by 4 as if it were RGBA, which mixed the channels
    together and produced a grey icon that was measurably still coloured.
    """
    out = bytearray(rgb)
    for index in range(0, len(out), 3):
        grey = int(
            0.299 * out[index] + 0.587 * out[index + 1] + 0.114 * out[index + 2] + 0.5
        )
        out[index] = out[index + 1] = out[index + 2] = grey
    return bytes(out)


def main():
    master, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    width, height, rgb = load_master(master)
    side, _, square = recentre(width, height, rgb)
    print(f"master {width}x{height} -> recentred square {side}x{side}")

    color = {size: resample(side, side, square, size) for size in ICO_SIZES}
    grey_square = desaturate(square)
    grey = {size: resample(side, side, grey_square, size) for size in ICO_SIZES}

    # Rounded, with transparent corners: the dock icons and the launcher.
    rounded_color = {size: round_corners(color[size], size, corner_radius(size)) for size in ICO_SIZES}
    rounded_grey = {size: round_corners(grey[size], size, corner_radius(size)) for size in ICO_SIZES}

    written = []
    for name, data, size in (
        ("IconMouseOver.png", rounded_color[256], 256),
        ("IconMouseNormal.png", rounded_grey[256], 256),
        # The window icon is squared on purpose - the guide says the dock icons
        # are rounded "while this taskbar icon should be squared".
        ("WindowIcon.png", color[256], 256),
    ):
        path = os.path.join(out_dir, name)
        palette, indices = quantize(data)
        blob = png_encode_palette(size, size, indices, palette)
        open(path, "wb").write(blob)
        written.append((name, len(blob), len(palette)))

    entries = []
    for size in ICO_SIZES:
        data = rounded_color[size]
        # PNG entry only for 256, DIB everywhere else: that is what Windows shells
        # expect and what every icon tool writes.
        if size == 256:
            palette, indices = quantize(data)
            payload = png_encode_palette(size, size, indices, palette)
        else:
            payload = dib_encode(size, size, data)
        entries.append((size, size, payload))
    ico = ico_encode(entries)
    path = os.path.join(out_dir, "launcher_icon.ico")
    open(path, "wb").write(ico)
    written.append(("launcher_icon.ico", len(ico), 0))

    for name, size, colors in written:
        suffix = f"  ({colors} colours)" if colors else ""
        print(f"  wrote {name:24s} {size/1024:7.1f} KB{suffix}")


if __name__ == "__main__":
    main()

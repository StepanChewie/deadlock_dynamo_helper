#!/usr/bin/env python3
"""Pack the Overwolf client into an .opk for store submission.

Per Overwolf's release guide: "ZIP all your files together (make sure to use normal
compression rate and not the highest rate), and then manually change the file
extension from .zip to .opk. Make sure to pack the manifest and all the files and
folders in the root of the package."

So the archive root must be the contents of `public/`, not the `public` directory
itself - zipping the parent would put manifest.json one level down and the package
would not install.

The source is always the repository's `public/`, never the folder Overwolf loads
the app from: that one accumulates test artefacts and orphans from earlier file
names, and everything in it ships.

Usage: build-opk.py <out.opk> [version]
"""
import json
import os
import sys
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "public"))

# Normal compression, not the highest - the guide asks for it explicitly.
COMPRESS_LEVEL = 6

# Files that must be present at the archive root for the package to install.
REQUIRED_AT_ROOT = ["manifest.json"]


def collect(public_dir):
    entries = []
    for root, _dirnames, filenames in os.walk(public_dir):
        for name in filenames:
            absolute = os.path.join(root, name)
            relative = os.path.relpath(absolute, public_dir).replace(os.sep, "/")
            entries.append((absolute, relative))
    return sorted(entries, key=lambda entry: entry[1])


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: build-opk.py <out.opk> [version]")
    out_path = os.path.abspath(sys.argv[1])

    manifest_path = os.path.join(PUBLIC_DIR, "manifest.json")
    if not os.path.isfile(manifest_path):
        raise SystemExit(f"manifest not found: {manifest_path}")
    manifest = json.load(open(manifest_path, encoding="utf-8"))

    version = sys.argv[2] if len(sys.argv) > 2 else manifest["meta"]["version"]

    entries = collect(PUBLIC_DIR)
    names = [relative for _absolute, relative in entries]

    for required in REQUIRED_AT_ROOT:
        if required not in names:
            raise SystemExit(f"{required} is not at the archive root")

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=COMPRESS_LEVEL) as archive:
        for absolute, relative in entries:
            archive.write(absolute, relative)

    # Read the archive back rather than trusting the write: an OPK that does not
    # list its own manifest is the failure this whole script exists to prevent.
    with zipfile.ZipFile(out_path) as archive:
        written = archive.namelist()
        if "manifest.json" not in written:
            raise SystemExit("the written archive has no manifest.json at its root")
        bad = archive.testzip()
        if bad is not None:
            raise SystemExit(f"the written archive is corrupt at {bad}")

    size = os.path.getsize(out_path)
    print(f"{out_path}")
    print(f"  app {manifest['meta']['name']} {version}, {len(written)} files, {size/1024/1024:.1f} MB")
    for name in sorted(written):
        print(f"    {name}")


if __name__ == "__main__":
    main()

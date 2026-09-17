import { resolveWindowPlacement } from './window-placement';

describe('resolveWindowPlacement', () => {
  const primary = { left: 0, top: 0, width: 1920, height: 1080 };
  const windowSize = { width: 1100, height: 680 };

  it('centres a window that fits', () => {
    expect(resolveWindowPlacement(primary, windowSize)).toEqual({
      left: 410,
      top: 200,
    });
  });

  it('centres inside a work area that does not start at the origin', () => {
    // A taskbar on the left, or a display arranged above the primary one.
    expect(
      resolveWindowPlacement({ left: 80, top: 40, width: 1840, height: 1000 }, windowSize),
    ).toEqual({ left: 450, top: 200 });
  });

  it('centres onto a display placed to the left of the primary one', () => {
    // Negative origins are normal for a second monitor; the arithmetic must not
    // assume the area starts at 0,0 or the window lands on the wrong display.
    expect(
      resolveWindowPlacement({ left: -1280, top: 0, width: 1280, height: 1024 }, windowSize),
    ).toEqual({ left: -1190, top: 172 });
  });

  it('anchors an oversized window to the origin instead of centring it off-screen', () => {
    // Centring here would compute a negative offset and hide the title bar.
    expect(
      resolveWindowPlacement({ left: 0, top: 0, width: 800, height: 600 }, windowSize),
    ).toEqual({ left: 0, top: 0 });
  });

  it('still centres on the axis a window does not fill', () => {
    // Exactly as wide as the area, but shorter: the oversized guard must not
    // fire, or the window would be pinned to the top instead of centred.
    expect(
      resolveWindowPlacement({ left: 10, top: 20, width: 1100, height: 1000 }, windowSize),
    ).toEqual({ left: 10, top: 180 });
  });

  it('pins a window of unknown size to the top-left of the area', () => {
    expect(resolveWindowPlacement(primary, null)).toEqual({ left: 0, top: 0 });
    expect(resolveWindowPlacement(primary, { width: 0, height: 0 })).toEqual({
      left: 0,
      top: 0,
    });
  });

  it('refuses to place a window when the working area is unusable', () => {
    // Returning null is what stops the caller from moving the window to a
    // coordinate it invented; the hotkey then only restores and focuses.
    expect(resolveWindowPlacement({ left: 0, top: 0, width: 0, height: 1080 })).toBeNull();
    expect(resolveWindowPlacement({ left: 0, top: 0, width: 1920, height: 0 })).toBeNull();
    expect(
      resolveWindowPlacement({ left: 0, top: 0, width: Number.NaN, height: 1080 }),
    ).toBeNull();
    expect(
      resolveWindowPlacement({ left: 0, top: 0, width: -1920, height: -1080 }),
    ).toBeNull();
  });

  it('falls back to the origin for a non-finite offset', () => {
    expect(
      resolveWindowPlacement(
        { left: Number.NaN, top: Number.POSITIVE_INFINITY, width: 1920, height: 1080 },
        windowSize,
      ),
    ).toEqual({ left: 410, top: 200 });
  });
});

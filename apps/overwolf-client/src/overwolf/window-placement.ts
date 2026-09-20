/**
 * Placement maths for the desktop build window.
 *
 * Kept pure and separate from the Overwolf calls so the geometry can be tested
 * directly. The failure this exists to fix is a window left with coordinates on
 * a display that is no longer connected: it stays "open" and stays off every
 * screen, and bringing it to the front does not help because there is nowhere
 * visible for it to come to the front *on*.
 */

/** A display's usable area, in screen pixels, excluding taskbars and docks. */
export interface WorkArea {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The size of the window being placed, in screen pixels. */
export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

export interface WindowPlacement {
  readonly left: number;
  readonly top: number;
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Places a window inside a working area, centred when it fits.
 *
 * Returns `null` when the working area is unusable, so the caller can skip the
 * move entirely rather than send the window to a coordinate it made up. A
 * missing window size is not an error: the window is pinned to the top-left of
 * the area instead, which is still fully visible.
 *
 * Centring is what "reset" means here — Overwolf centres a window that declares
 * no `start_position`, and the desktop window declares none.
 */
export function resolveWindowPlacement(
  workArea: WorkArea,
  windowSize?: WindowSize | null,
): WindowPlacement | null {
  if (!isPositive(workArea?.width) || !isPositive(workArea?.height)) {
    return null;
  }

  const left = Number.isFinite(workArea.left) ? workArea.left : 0;
  const top = Number.isFinite(workArea.top) ? workArea.top : 0;

  if (!isPositive(windowSize?.width) || !isPositive(windowSize?.height)) {
    return { left, top };
  }

  // A window larger than the display cannot be centred into view; anchoring it
  // to the origin at least puts its title bar and top-left corner on screen.
  // Strictly greater: a window that exactly fills one axis still centres on the
  // other, and centring is a zero offset on the axis it fills.
  if (windowSize.width > workArea.width || windowSize.height > workArea.height) {
    return { left, top };
  }

  return {
    left: left + Math.floor((workArea.width - windowSize.width) / 2),
    top: top + Math.floor((workArea.height - windowSize.height) / 2),
  };
}

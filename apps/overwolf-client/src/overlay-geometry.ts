/**
 * Geometry constants for the in-game overlay window.
 *
 * Overwolf's submission test procedure opens the app on a 1366x720 screen and
 * requires every window to stay inside the screen borders. The overlay is
 * anchored `OVERLAY_TOP_OFFSET` px from the top edge, so the maximum height it
 * may grow to is bounded by that same screen height.
 */
export const OVERLAY_MIN_HEIGHT = 190;
export const OVERLAY_TOP_OFFSET = 80;
export const OVERLAY_MAX_HEIGHT = 620;

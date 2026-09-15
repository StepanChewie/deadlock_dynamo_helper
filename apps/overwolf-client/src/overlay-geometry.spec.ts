import { OVERLAY_MAX_HEIGHT, OVERLAY_TOP_OFFSET } from './overlay-geometry';

const OVERWOLF_TEST_SCREEN_HEIGHT = 720;

it('keeps the overlay inside the smallest Overwolf test screen', () => {
  expect(OVERLAY_TOP_OFFSET + OVERLAY_MAX_HEIGHT).toBeLessThanOrEqual(
    OVERWOLF_TEST_SCREEN_HEIGHT,
  );
});

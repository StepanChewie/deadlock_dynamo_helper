import { InGameOverlayLifecycle } from './in-game-overlay-lifecycle';

/**
 * These cases cover the restore path, so they state the auto-show decision
 * explicitly. The constructor defaults to refusing to auto-show, so omitting
 * the predicate here would silently turn every assertion below into "nothing
 * happened".
 */
const autoShowOn = () => true;

describe('InGameOverlayLifecycle', () => {
  test('restores the in-game overlay when a match becomes active', () => {
    const restore = jest.fn((done: (success: boolean) => void) => done(true));
    const lifecycle = new InGameOverlayLifecycle(restore, autoShowOn);

    lifecycle.sync('103088762');

    expect(restore).toHaveBeenCalledTimes(1);
  });

  test('does not repeatedly restore for every event after a successful restore', () => {
    const restore = jest.fn((done: (success: boolean) => void) => done(true));
    const lifecycle = new InGameOverlayLifecycle(restore, autoShowOn);

    lifecycle.sync('103088762');
    lifecycle.sync('103088762');
    lifecycle.sync('103088762');

    expect(restore).toHaveBeenCalledTimes(1);
  });

  test('restores again after match end or when a new match starts', () => {
    const restore = jest.fn((done: (success: boolean) => void) => done(true));
    const lifecycle = new InGameOverlayLifecycle(restore, autoShowOn);

    lifecycle.sync('103088762');
    lifecycle.sync('');
    lifecycle.sync('103088999');

    expect(restore).toHaveBeenCalledTimes(2);
  });

  test('retries the same match after a failed restore attempt', () => {
    let attempts = 0;
    const restore = jest.fn((done: (success: boolean) => void) => {
      attempts += 1;
      done(attempts >= 2);
    });
    const lifecycle = new InGameOverlayLifecycle(restore, autoShowOn);

    lifecycle.sync('103088762');
    lifecycle.sync('103088762');

    expect(restore).toHaveBeenCalledTimes(2);
  });

  describe('auto-show gate', () => {
    test('leaves the window alone when auto-show is off', () => {
      const restore = jest.fn();
      const lifecycle = new InGameOverlayLifecycle(restore, () => false);

      lifecycle.sync('103088762');
      lifecycle.sync('103088762');

      expect(restore).not.toHaveBeenCalled();
    });

    test('fails closed when no predicate is supplied', () => {
      const restore = jest.fn();
      const lifecycle = new InGameOverlayLifecycle(restore);

      lifecycle.sync('103088762');

      expect(restore).not.toHaveBeenCalled();
    });

    test('does not pop a window when auto-show is switched on mid-match', () => {
      let autoShow = false;
      const restore = jest.fn((done: (success: boolean) => void) => done(true));
      const lifecycle = new InGameOverlayLifecycle(restore, () => autoShow);

      lifecycle.sync('103088762');
      autoShow = true;
      lifecycle.sync('103088762');

      expect(restore).not.toHaveBeenCalled();
    });

    test('applies a mid-match switch from the next match onwards', () => {
      let autoShow = false;
      const restore = jest.fn((done: (success: boolean) => void) => done(true));
      const lifecycle = new InGameOverlayLifecycle(restore, () => autoShow);

      lifecycle.sync('103088762');
      autoShow = true;
      lifecycle.sync('103088762');
      lifecycle.sync('');
      lifecycle.sync('103088999');

      expect(restore).toHaveBeenCalledTimes(1);
    });

    test('consults the gate once per match rather than once per event', () => {
      const shouldAutoShow = jest.fn(() => false);
      const restore = jest.fn();
      const lifecycle = new InGameOverlayLifecycle(restore, shouldAutoShow);

      lifecycle.sync('103088762');
      lifecycle.sync('103088762');
      lifecycle.sync('103088762');

      // `sync` runs on every GEP event, and the predicate reads localStorage.
      // Asking it per event would put a synchronous storage read on the hot path.
      expect(shouldAutoShow).toHaveBeenCalledTimes(1);
    });
  });
});

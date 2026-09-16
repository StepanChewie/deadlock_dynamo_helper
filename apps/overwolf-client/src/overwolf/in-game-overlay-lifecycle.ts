type RestoreOverlay = (onComplete: (success: boolean) => void) => void;

export class InGameOverlayLifecycle {
  private activeMatchId = '';
  private pendingMatchId = '';

  constructor(
    private readonly restoreOverlay: RestoreOverlay,
    /**
     * Whether a new match may put the overlay on screen by itself.
     *
     * Defaults to false, and that default is deliberate: a future call site
     * that forgets to pass a predicate should fail closed rather than start
     * auto-showing. The recommendation is built in the background either way —
     * this gate only controls the window, and the hotkey still opens it.
     */
    private readonly shouldAutoShow: () => boolean = () => false,
  ) {}

  sync(matchId: string): void {
    const normalizedMatchId = matchId.trim();

    if (!normalizedMatchId) {
      this.activeMatchId = '';
      this.pendingMatchId = '';
      return;
    }

    if (
      this.activeMatchId === normalizedMatchId
      || this.pendingMatchId === normalizedMatchId
    ) {
      return;
    }

    if (!this.shouldAutoShow()) {
      // Record the match so the gate is not re-evaluated on every subsequent
      // event, and so turning auto-show on mid-match does not make a window
      // appear for a match the player is already in. The next match is
      // governed by the new setting. The hotkey remains the way to see this
      // one.
      this.activeMatchId = normalizedMatchId;
      return;
    }

    this.pendingMatchId = normalizedMatchId;
    this.restoreOverlay((success) => {
      if (this.pendingMatchId !== normalizedMatchId) {
        return;
      }

      this.pendingMatchId = '';
      if (success) {
        this.activeMatchId = normalizedMatchId;
      }
    });
  }
}

# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Deadlock players who need a legible purchase decision without leaving the match, plus the same players reviewing the fuller recommendation in the Overwolf desktop window.

## Product Purpose

Dynamo Lab turns live match state and verified build evidence into a clear next purchase and a legal forward build path. Success means the player can identify the next item at a glance and understand the next five planned actions without decoding planner internals.

## Positioning

The interface presents a live, transaction-aware Deadlock build recommendation rather than a static build list: the current action and its legal sequence are the product truth.

## Operating Context

The in-game overlay runs beside active Deadlock gameplay at 340px wide and must remain readable under time pressure. The resizable desktop window provides the same recommendation with more explanation and plan detail.

## Capabilities and Constraints

- Preserve the existing Overwolf window lifecycle and adaptive recommendation data flow.
- Preserve a visible connection state and a manual Refresh action.
- Treat the desktop window as an extensible application, not as an enlarged build widget.
- Plan navigation around Overview, Live Build, Matches, Match Analysis, and Settings; only Live Build is implemented in the current scope.
- Future sections may be represented in design and information architecture, but must not ship fake data or test controls as working functionality.
- The overlay shows the current recommendation and the next five plan actions.
- Desktop may show the full plan and supporting reasons.
- Remove developer-facing telemetry and decision-debug presentation from user-facing windows.
- Item recommendations must show recognizable Deadlock shop artwork with a graceful fallback when artwork is unavailable.
- Recommendation legality remains authoritative; presentation must not invent or reorder transactions.

## Brand Commitments

Do not use Statlocker as the user-facing product name. Use a simple Dynamo-related identity, with the existing Dynamo artwork as the primary character reference, and use real Deadlock item artwork. Do not imply affiliation or invent claims that are not present in the product.

## Evidence on Hand

- Current desktop and in-game surfaces: `public/desktop.html` and `public/in_game.html`.
- Current rendering and recommendation state: `src/ui.ts` and `src/adaptive-recommendation-presentation.ts`.
- Generated item identity catalog: `src/generated/adaptive-item-catalog.ts`.
- Canonical Deadlock item metadata is available from the existing Deadlock assets ingestion path.

## Product Principles

- Next purchase first.
- Legality before decoration.
- Recognizable item identity at a glance.
- Detail belongs in desktop; urgency belongs in overlay.
- Technical diagnostics stay out of player-facing UI.

## Accessibility & Inclusion

Keep essential actions keyboard reachable, preserve readable contrast, and never encode recommendation status by color alone.

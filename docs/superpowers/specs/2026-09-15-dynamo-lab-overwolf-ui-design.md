# Dynamo Lab Overwolf UI Design

## Status

Approved visual direction: **Resonance Blueprint**. The accepted mockup is the visual source of truth. This specification defines how that design is transferred into the real Overwolf desktop and in-game windows without changing recommendation legality or lifecycle behavior.

## Goal

Replace the developer-oriented Overwolf surfaces with a clean Dynamo-themed player UI that makes one legal purchase and the next four purchases readable at a glance. The desktop must feel like an extensible application shell; the overlay must be a compact five-row purchase aid during play.

## Scope

### In scope

- Rename the player-facing product to **Dynamo Lab**.
- Implement the approved desktop shell with navigation for Overview, Live Build, Matches, Match Analysis, and Settings.
- Keep Live Build as the only active feature. Future destinations are visibly unavailable and must not contain fake data or controls.
- Render exactly five purchase rows when data permits: one current action plus four subsequent legal plan actions.
- Show the Deadlock item icon, item name, numeric price, and category label for every row.
- Use semantic category colors for Weapon, Vitality, and Spirit while retaining text labels.
- Keep connection state and a manually accessible **Refresh** action in the desktop top bar.
- Keep a compact 340 px in-game overlay with smaller row spacing and larger price numerals.
- Preserve the existing Overwolf background controller, window lifecycle, hotkeys, polling, last-safe-recommendation behavior, and planner data ordering.
- Remove decision traces, event counters, API send counters, confidence meters, test controls, and other developer telemetry from the player-facing windows.

### Out of scope

- Implementing Overview, Matches, Match Analysis, or Settings behavior.
- Changing planner scoring, transaction legality, recommendation ordering, API contracts, or polling cadence.
- Adding a build editor, account system, match history storage, or new analytics.
- Reworking the separate Dynamo warning window.

## Visual Contract

The desktop keeps the approved Resonance Blueprint composition:

- dark blue-green blueprint surface;
- fixed left navigation with Dynamo portrait/line-art identity;
- restrained amber instrument accents;
- compact top bar with connection status and Refresh;
- a single aligned central Build Route, not separate oversized current/next panels;
- a narrow right-side overlay preview at desktop widths that can support it.

The build route is one vertical grid. Every row uses the same columns: sequence, icon, item name/status, price, and category. The current row differs only through a subtle amber outline/background and a short `Buy now`, `Hold`, `Wait`, or equivalent action label. It is not enlarged into a separate card.

The overlay uses the same information hierarchy but omits desktop chrome and explanatory panels. It has five compact rows, minimal vertical padding, and price digits visually stronger than secondary labels.

No additional visual direction, ornamental panel, or shell redesign is part of implementation. Pixel-level adjustments may be made only to keep the approved composition aligned across supported window sizes.

## Information Architecture

Desktop navigation contains:

1. Overview — unavailable in this release.
2. Live Build — selected and functional.
3. Matches — unavailable in this release.
4. Match Analysis — unavailable in this release.
5. Settings — unavailable in this release.

Unavailable destinations are rendered as disabled navigation items with an accessible `Coming soon` description. They do not switch to empty fake pages.

## Recommendation Projection

`buildAdaptiveRecommendationPresentation()` remains the boundary between backend recommendation data and player UI. It will expose enough item identity and current-action metadata for a dedicated five-row route renderer.

The route projection follows these rules:

1. The first row represents the authoritative `nextAction` and its resolved target item.
2. Subsequent rows preserve the order supplied by the semantic plan projection.
3. Owned and completed actions are not purchase rows.
4. The exact semantic action already represented by the current row is omitted once, by action identity rather than by item ID.
5. Up to four remaining rows are shown. Repeated legitimate transactions for the same item remain distinct.
6. The renderer never creates a BUY, SELL, replacement, price, or category that is absent from the presentation/catalog data.
7. If fewer than five legal rows exist, the UI renders only the available rows and does not invent placeholders.

## Item Artwork

Each row renders the official Deadlock item artwork by numeric item ID using the Deadlock UI `dl-item-card` icon variant. The component is loaded once per document and configured without tooltips or tier badges for the compact route.

Artwork sits over a category-colored fallback tile. If the component or remote asset cannot load, the fallback remains visible and the item name/category still identify the purchase. Recommendation text and metadata continue to come from the committed local catalog, so an artwork outage does not make the route unreadable.

The Overwolf manifest allowlist must include only the origins required by the Deadlock UI component and asset API.

## States

- **Initializing:** Dynamo Lab shell is visible; connection state says `Connecting`; build area says `Waiting for match data`.
- **Connected, no match:** shell remains usable; build area explains that a route appears when a match is detected.
- **Live recommendation:** current action and up to four next actions are rendered.
- **Refresh pending:** Refresh is disabled briefly and exposes a busy state without clearing the last safe route.
- **Connection interrupted with cached recommendation:** retain the last safe route and change connection state to `Reconnecting`.
- **No cached recommendation after error:** show a concise recovery message and retain Refresh.

## Accessibility and Interaction

- Refresh is a native button with visible keyboard focus and an accessible busy state.
- Disabled navigation uses native disabled semantics or `aria-disabled` without acting on click.
- Category is expressed with both color and a text label.
- Prices use tabular numerals.
- Item artwork has a useful accessible label; decorative Dynamo artwork has empty alternative text.
- Desktop content reflows rather than clipping at the declared 600 px minimum width.
- Overlay remains legible and unclipped at 340 px.
- Reduced-motion users receive no nonessential animation.

## File Boundaries

- `public/desktop.html`: approved desktop shell and desktop-specific styles.
- `public/in_game.html`: approved compact overlay structure and overlay-specific styles.
- `src/ui.ts`: DOM projection, route selection, artwork elements, state rendering, and Refresh state.
- `src/adaptive-recommendation-presentation.ts`: presentation-only fields required to identify the current semantic action and local item metadata.
- `src/*.spec.ts`: route projection, icon attributes/fallback, five-row limit, repeated-item preservation, player-facing copy, and error-state coverage.
- `public/manifest.json`: Dynamo Lab metadata, window sizing, and required external origins.

The existing background controller in `src/index.ts` changes only where necessary to expose truthful connection/refresh state. Polling, event ingestion, recommendation publication, overlay restoration, and hotkeys remain intact.

## Verification

Implementation is complete only after all of the following pass:

- focused presentation and DOM tests, including a witnessed failing test before each behavior change;
- the full Overwolf Jest suite;
- TypeScript/webpack production build;
- release validation;
- Graphify incremental update;
- real Chromium renders at desktop 600x600 and 1440x900 plus overlay 340 px width;
- visual inspection confirms five aligned rows, real item artwork, larger price numerals, compact overlay spacing, and correctly placed Refresh;
- keyboard focus, disabled navigation, empty state, reconnect state, and artwork fallback are exercised.

## Acceptance Criteria

- No player-facing `Statlocker` branding or developer telemetry remains in desktop or overlay.
- Desktop presents Dynamo Lab as a full app shell with Live Build selected and future navigation safely disabled.
- A live recommendation produces one current purchase plus no more than four next purchases, in authoritative order.
- Every available row shows name, price, category text/color, and official Deadlock artwork or a readable fallback.
- Current purchase is highlighted but uses the same row grid and approximate height as the next purchases.
- Overlay fits at 340 px, uses tighter spacing than desktop, and makes numeric prices more prominent.
- Connected/Reconnecting state and Refresh remain visible and functional.
- Existing lifecycle, hotkeys, polling, and last-safe recommendation behavior continue to pass regression tests.

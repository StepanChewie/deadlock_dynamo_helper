# Dynamo Lab — Privacy Policy

**Effective date:** 16 September 2026
**Applies to:** the Dynamo Lab Overwolf application and the recommendation service it talks to.

## Who we are

Dynamo Lab is an independently developed Overwolf application that shows a live Deadlock build route: the purchase you should make now, plus the next four legal purchases for the running match.

The data controller is **StepanChewbacca**. Because Dynamo Lab has no accounts and no sign-in, there is no in-app way to identify you — which also means the fastest way to reach us about your data is the support channel listed at the bottom of this page.

## What Dynamo Lab sends

Dynamo Lab sends data to its own server in exactly three situations. This list is exhaustive.

| What | Why | Contains |
|---|---|---|
| Game events | To know the current match state | The raw game events Overwolf's game events provider reports, plus an app-generated client id |
| Recommendation request | To build your build route | The match id, and your **Steam ID** |
| Feedback vote | To find out whether the route was useful | App version, match id, your yes/no answer, an optional reason, and a request id |

**About the Steam ID.** A Deadlock match contains ten players. The Steam ID is sent so the server can tell which of them is you — otherwise it cannot know whose inventory to build a route for. It is used for that purpose and nothing else.

**About feedback.** The post-match prompt is optional and you can skip it. A feedback record stores no account, no Steam ID and no player identifier of any kind. Feedback is a product signal only: it is never fed into the recommendation model or used to train it.

## What Dynamo Lab does not do

- No account, no sign-in, no email address, no password.
- No payment processing. The app is free and carries no paid tier.
- No advertising identifiers, no third-party analytics, no crash reporting.
- No access to your chat, your friends list, your files, or your browser history.
- No reading of your messages on any platform.

## Third parties

Dynamo Lab does not sell data, and does not share it except as described here.

- **Overwolf** — the app runs inside Overwolf and uses its game events provider. Overwolf processes data under its own privacy policy.
- **unpkg.com** — item artwork is loaded from this public CDN, so it sees your IP address when the artwork is fetched. If you would rather not make that request, the app falls back to a text placeholder when artwork cannot be loaded.
- **Discord** — only if you choose to press *Join Discord*. Discord's own privacy policy then applies. Pressing it is entirely optional.

## How long data is kept

- **Raw game event logs** are kept as the newest **32 log files** and older files are deleted automatically.
- **Recommendation history** (the record of what was recommended during a match) is deleted after **30 days**.

## Data stored on your own machine

The app keeps a local diagnostic store on your computer. It is used to show connection state and to build the diagnostics block. **It is never uploaded on its own.** The diagnostics block leaves your machine only when you press *Copy diagnostics*, and even then it goes to your clipboard, not to us.

## Your choices

- **Skip the feedback prompt.** No vote is recorded.
- **Do not press *Join Discord*.** Nothing is shared with Discord.
- **Ask us to delete your match data.** Write to us in the support channel and tell us the match id — the diagnostics block shows it. We will delete the records for that match.

If you are in a jurisdiction that grants you rights over your personal data — for example access, correction, deletion or objection — you can exercise them through the same support channel. We will respond there.

## Children

Dynamo Lab is not directed at children. It is a companion app for Deadlock, which has its own age rating, and it should not be used by anyone below the age required to play that game.

## Changes

If this policy changes in a way that affects what is collected, the effective date above will change and the new version will be published at this address. Continuing to use the app after that means you accept the updated policy.

## Contact

Support channel: **https://discord.gg/yR4TNN2GDH** — post in `#support`.

This is also the address to use for data requests, including deletion.

---

Dynamo Lab is not affiliated with, endorsed by, or sponsored by Valve Corporation or Overwolf Ltd. *Deadlock* is a trademark of Valve Corporation.

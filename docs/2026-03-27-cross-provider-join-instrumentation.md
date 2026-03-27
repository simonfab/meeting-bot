# Cross-Provider Join Instrumentation

Date: 2026-03-27

## Objective

Extend the Zoom-style failure instrumentation to Google Meet and Microsoft Teams so future join failures produce actionable evidence instead of a single generic timeout.

This work is intentionally narrow:

- no broad shared join-state framework
- no recording pipeline redesign
- no attempt to normalize all provider flows into one abstraction

The goal is better evidence at the join boundary.

## Why

Zoom already demonstrated that provider join flows can fail for variant-specific reasons.

Google Meet and Microsoft Teams have the same risk profile:

- admission and waiting-room states
- evolving pre-join and in-meeting UI
- partial joins where visible controls and actual state can diverge
- ended-by-host or removed states that can be mistaken for generic timeout

Without targeted instrumentation, future failures would be harder to classify and slower to debug.

## Implemented

### Google Meet

Added targeted join snapshots in `src/bots/GoogleMeetBot.ts`.

Captured at the join wait boundary:

- sanitized page URL
- body text excerpt
- visible dialog text
- visible button labels
- participant-count signal from the People control

Classified states:

- joined
- waiting on host
- request timed out
- denied by participant
- ended before recording

Failure behavior:

- logs structured diagnostics before throwing
- uploads a best-effort `google-join-timeout` screenshot when debug artifacts are enabled and object storage is configured
- throws `MeetingEndedError` when Meet ends before recording starts

### Microsoft Teams

Added targeted join snapshots in `src/bots/MicrosoftTeamsBot.ts`.

Captured at the join wait boundary:

- sanitized page URL
- body text excerpt
- visible dialog text
- visible button labels

Classified states:

- joined
- waiting to be admitted
- denied access
- ended before recording

Failure behavior:

- logs structured diagnostics before throwing
- uploads a best-effort `teams-join-timeout` screenshot when debug artifacts are enabled and object storage is configured
- throws `MeetingEndedError` when Teams ends before recording starts

## Verification

Completed:

- `npm run build`

Not yet completed:

- live validation against known Google Meet variants
- live validation against known Microsoft Teams variants
- regression coverage around provider-specific join-state classification

## Files Changed

- `src/bots/GoogleMeetBot.ts`
- `src/bots/MicrosoftTeamsBot.ts`

## Next Recommended Step

Exercise one live meeting per provider and confirm the new diagnostic logs are informative for:

- normal join success
- timeout or admission wait
- ended-by-host before recording

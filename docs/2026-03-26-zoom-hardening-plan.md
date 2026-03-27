# Zoom Hardening Plan

Date: 2026-03-26

## Objective

Make Zoom joins reliable across the variants observed on 2026-03-26 without changing the recording architecture unnecessarily.

This plan assumes the main problem is Zoom UI variability, especially:

- serial pre-join media prompts
- app-page vs iframe/PWA rendering
- narrow joined-state detection
- weak failure diagnostics

## Non-Goals

This plan does not prioritize:

- PulseAudio redesign
- recording pipeline redesign
- broad cross-platform refactors

Those are not where the current evidence points.

## Success Criteria

The Zoom bot should:

- join meetings that render either directly on the page or inside `iframe#webclient`
- dismiss serial media prompts before attempting to join
- recognize joined state even when Zoom shows onboarding overlays
- distinguish waiting room timeouts from ended-by-host and other non-lobby states
- produce actionable diagnostics when join still fails
- stop logging full meeting secrets

## Progress Update

Date updated: 2026-03-26

Completed in the first implementation pass:

- Phase 1 core work
  - Zoom pre-join prompt dismissal was added
- Phase 2 partial work
  - app vs iframe state is now captured more explicitly during join polling
- Phase 3 core work
  - joined-state detection now has control-based fallbacks in addition to footer parsing
  - ended-by-host is no longer treated as a generic lobby timeout
- Phase 4 partial work
  - richer join diagnostics are now logged on failure
- Phase 5 partial work
  - meeting URLs and webhook logs are now redacted in the main identified logging paths

Verified:

- `npm run build` after the initial Zoom hardening work and again after the 2026-03-27 Google Meet and Microsoft Teams instrumentation extension

Not yet completed:

- live post-change validation across the observed Zoom variants
- regression coverage
- ECS task protection cleanup
- browser-log shutdown cleanup

Cross-provider follow-on completed on 2026-03-27:

- targeted join-path diagnostics were added to `GoogleMeetBot`
- targeted join-path diagnostics were added to `MicrosoftTeamsBot`
- both now capture structured failure evidence before throwing join/admission errors
- both now use best-effort timeout screenshots when debug artifacts are enabled and object storage is configured
- both now distinguish ended-before-recording from generic lobby timeout

Debug-artifact storage follow-on completed on 2026-03-27:

- the old GCP-only debug screenshot uploader was replaced with an object-storage-backed implementation
- debug screenshots now reuse the same storage provider abstraction used by recording uploads
- in S3 deployments, debug artifacts now rely on the existing S3 bucket configuration and default AWS credential chain
- startup now performs a best-effort debug artifact smoke test by default
- the smoke test is explicitly non-blocking and cannot fail startup
- debug artifact keys now include environment, meeting provider, failure stage, bot identity, host identity, and timestamp
- debug artifact logging now records the exact object key and logs capture failure vs upload failure separately
- the debug artifact defaults are now:
  - `DEBUG_ARTIFACTS_ENABLED=true`
  - `DEBUG_ARTIFACTS_SMOKE_TEST_ON_START=true`
  - `DEBUG_ARTIFACT_PREFIX=meeting-bot/debug`

## Phase 1: Pre-Join Hardening

### Goal

Make the bot robust before the `Join` click.

### Changes

- Add a Zoom pre-join helper that operates against the resolved UI root:
  - page root
  - iframe root
- Explicitly detect and dismiss Zoom prompts such as:
  - `Continue without microphone and camera`
  - `Do you want people to see you in the meeting?`
  - `Do you want people to hear you in the meeting?`
- Repeat prompt handling until:
  - the name input is usable
  - the join button is enabled
  - no blocking dialog remains
- Ensure name filling uses the actual active container root and works with controlled inputs.

### Why First

Both Chrome MCP sessions showed this state. It is the clearest reproducible variant gap.

## Phase 2: Container and State Normalization

### Goal

Stop treating app-page and iframe/PWA variants as separate ad hoc branches.

### Changes

- Add one helper that resolves the active Zoom UI container and returns:
  - mode: `app` or `iframe`
  - root handle
  - current iframe URL if applicable
- Use that same resolved root for:
  - prompt dismissal
  - input detection
  - name entry
  - join click
  - joined-state detection
- Refresh or re-resolve the container after the join click if Zoom changes rendering mode.

### Why

Meeting `89191028372` showed the meaningful UI entirely inside `iframe#webclient`. The bot needs one stable abstraction for this.

## Phase 3: Joined-State Detection Hardening

### Goal

Avoid false negatives after `Join`.

### Changes

- Keep the current `#wc-footer` participant parsing because it works on successful cases.
- Add fallback joined-state signals:
  - visible `Leave`
  - participant control present
  - chat control present
  - audio/video controls present
  - non-lobby in-meeting text
- Add explicit negative-state checks:
  - `You have been removed`
  - `This meeting has been ended by host`
  - host-not-started or waiting-room text if available
- Only classify as lobby timeout when the page actually matches a waiting/admission state.
- Introduce clearer internal outcomes such as:
  - `joined`
  - `waiting_room_timeout`
  - `ended_by_host_before_recording`
  - `user_denied`
  - `unknown_zoom_state`

### Why

The failed `86108755832` runs show the current "waiting at lobby" label is sometimes wrong.

## Phase 4: Failure Diagnostics

### Goal

When Zoom still fails, produce evidence that explains why.

### Changes

At the Zoom join failure point, capture:

- redacted meeting URL
- detected container mode
- iframe URL if used
- root page URL
- footer presence and footer text
- body text excerpt
- visible dialog summaries
- visible button summaries
- screenshot

If possible, capture these for both:

- top document
- iframe document

### Why

The current failure logs give a body-text dump, but not enough structural context to explain why detection failed.

## Phase 5: Logging and Secret Redaction

### Goal

Stop leaking credentials and reduce noisy logs.

### Changes

- Redact `pwd` and similar sensitive query parameters before logging Zoom URLs.
- Avoid logging full webhook endpoints where not needed.
- Review whether deterministic correlation IDs really need raw meeting URLs as part of their input.

### Why

Current logs expose secrets unnecessarily.

## Phase 6: Secondary Cleanup

### Goal

Address non-blocking issues once Zoom join handling is stable.

### Changes

- Investigate ECS task protection `400` responses.
- Quiet or normalize `Failed to log browser messages...` during page shutdown.
- Review whether repeated `Closing device notification buttons...` logs should be reduced or made more specific.

### Why

These are operational polish items, not the main reliability issue.

## Proposed Implementation Order

1. Pre-join prompt handling
2. Container normalization
3. Joined-state fallbacks and better classification
4. Failure diagnostics
5. Secret redaction
6. Secondary cleanup

## Test Matrix

After implementation, test at least these Zoom cases:

- direct web-client app flow with no blocking prompt
- direct web-client flow with serial media prompts
- PWA wrapper plus `iframe#webclient`
- joined page with:
  - reactions promo
  - `OK` prompt
  - mic/camera nag
- ended-by-host before the recording phase fully settles
- denied/admission timeout case

## Suggested Deliverables

### Deliverable 1

Zoom join hardening in `src/bots/ZoomBot.ts`

### Deliverable 2

Shared Zoom diagnostic helpers if they improve readability

### Deliverable 3

Redaction and logging cleanup in:

- `src/util/logger.ts`
- `src/services/notificationService.ts`

### Deliverable 4

Regression coverage for the observed Zoom variants

## Notes for Implementation

- Do not remove the current footer parsing. It is still useful on the happy path.
- Prefer additive fallbacks over replacing all current logic at once.
- Preserve the current recording path unless new evidence shows it is involved in join failures.
- Treat "already inside a joined shell" as a valid detection path even if onboarding overlays remain visible.

# Zoom Investigation Findings

Date: 2026-03-26

## Scope

This note summarizes the Zoom behavior observed from:

- two failed bot runs against meeting `86108755832`
- one successful bot run against meeting `6844404150`
- a live Chrome MCP join of meeting `6844404150`
- a live Chrome MCP join of meeting `89191028372`

The goal was to determine whether the current Zoom automation is broadly broken, or whether it is failing on specific Zoom UI variants.

## Executive Summary

Zoom is not failing in one simple way.

- The current Zoom flow still works on at least one normal path.
- Zoom presents multiple join variants across meetings and regions.
- The bot is most fragile during pre-join handling and state classification.
- The successful run shows that recording, upload, and audio capture are not the primary issue.
- Some failures are being misclassified as "waiting at lobby" when the page already looks like an in-meeting shell.

The problem is best described as Zoom UI variability plus brittle bot assumptions.

## Evidence Reviewed

### Failed Bot Runs

Two failed runs were reviewed for meeting `86108755832`:

- `2026-03-26T11:48` run
- `2026-03-26T12:10` run

In both cases the bot:

- launched successfully
- used the fast `/wc/join/` path
- found the name input
- clicked `Join`
- timed out after the configured wait window

The failure body text from those runs already contained in-meeting controls such as:

- `Audio`
- `Video`
- participant count
- `Participants`
- `Chat`
- `Share Screen`
- `AI Companion`
- `Leave`

The first failed case also contained:

- `Cannot detect your microphone, please check the device and connection and try again.`

The second failed case also contained:

- `This meeting has been ended by host`

### Successful Bot Run

A successful run was reviewed for meeting `6844404150` at `2026-03-26T13:15`.

That run:

- used the fast `/wc/join/` path
- found the input immediately
- clicked `Join`
- parsed `3participants`
- entered the meeting
- dismissed repeated device notifications
- dismissed the Zoom `OK` promo
- recorded successfully in audio-only mode
- stopped cleanly when the meeting ended
- uploaded to S3 successfully
- delivered the completion webhook successfully

### Chrome MCP Live Sessions

Two live sessions were inspected using the Chrome MCP browser.

#### Meeting `6844404150`

Observed behavior:

- landing page showed `Join from browser`
- landing page also showed a cookie banner and a `Did not open Zoom Workplace app?` popup
- direct web-client flow showed two serial media prompts:
  - `Do you want people to see you in the meeting?`
  - `Do you want people to hear you in the meeting?`
- both prompts required `Continue without microphone and camera`
- after clearing them, the normal name/join form appeared
- once inside, the meeting showed:
  - `Audio`
  - `Video`
  - `Participants`
  - `Chat`
  - `Reactions`
  - `OK`
  - `Share Screen`
  - `AI Companion`
  - `Leave`

The current footer-based detector would succeed on this meeting once inside.

#### Meeting `89191028372`

Observed behavior:

- landing page again showed `Join from browser`
- after browser join, Zoom briefly routed through a PWA wrapper
- the real meeting UI rendered inside `iframe#webclient`
- the same two serial media prompts appeared, but this time inside the iframe
- after clearing them, the join form remained in the iframe
- once the form was correctly updated and submitted, the meeting joined successfully
- the joined page showed the familiar in-meeting shell:
  - `Audio`
  - `Video`
  - `2 Participants`
  - `Chat`
  - `Reactions`
  - `OK`
  - `Share Screen`
  - `Leave`

This confirms a second real Zoom variant: PWA wrapper plus iframe-hosted pre-join and in-meeting UI.

## Findings

### 1. Zoom Is Variant-Sensitive, Not Universally Broken

The evidence does not support a blanket conclusion that Zoom automation is broken.

It does support the conclusion that Zoom presents multiple valid UI paths:

- direct web-client page with visible input
- direct web-client page with serial media prompts before the input is usable
- PWA wrapper with `iframe#webclient`
- joined in-meeting shell with overlay promos and device nags

The current bot works on some of these variants and is brittle on others.

### 2. Pre-Join Media Prompts Are a Real Unhandled Branch

The live MCP sessions repeatedly showed Zoom-specific prompts such as:

- `Do you want people to see you in the meeting?`
- `Do you want people to hear you in the meeting?`
- `Continue without microphone and camera`

These prompts appear before or around the name entry step.

The current Zoom flow does not explicitly dismiss them before moving on to:

- wait for input
- fill name
- click `Join`

This is a real hardening gap.

### 3. The Current Joined-State Detection Is Too Narrow

Once the bot clicks `Join`, it currently relies on a narrow signal:

- find `#wc-footer`
- parse the footer for `number + participants`

This works when Zoom exposes that footer in the expected way.

It is fragile when:

- the meaningful UI is inside a different container than expected
- the footer is delayed or not attached
- Zoom is in a partially joined shell
- the meeting has already ended and the page is no longer in a clean lobby/joined state

The failed `86108755832` runs are the strongest evidence for this issue. In those logs the page already looked like a joined shell, but the bot still exited with `WaitingAtLobbyRetryError`.

### 4. Some Failures Are Being Misclassified

The current failure label for Zoom timeouts is too coarse.

At least one failed case included:

- visible in-meeting controls
- participant count
- `Leave`

Another failed case also included:

- `This meeting has been ended by host`

Those states are not well described as "waiting at lobby."

Current classification is collapsing several different failure states into one bucket:

- genuine waiting room timeout
- joined shell not recognized
- ended-by-host before bot transitions to recording
- other unknown Zoom state transitions

### 5. Post-Join UI Noise Is Real but Not the Whole Problem

The "popup blizzard" description is accurate for the in-meeting shell.

Observed post-join noise includes:

- reactions promo
- `OK` confirmation prompt
- mic/camera nag banner
- share-preview and other meeting overlays

This noise matters because it increases UI variability and can interfere with brittle selectors.

But the successful run proves that popup-heavy joined pages can still be handled when the bot first recognizes the meeting as joined.

So popups are a contributing factor, not the complete root cause.

### 6. Recording and Audio Stack Look Healthy

The successful run shows:

- browser launch is stable
- recording starts
- stream capture sees audio and video tracks
- audio-only recording mode activates as expected
- upload completes successfully

PulseAudio and recording internals are not the highest-priority area for this investigation.

### 7. There Are Two Non-Blocking Operational Issues

These appeared during the successful run but are not join blockers:

- ECS task protection returned `400` when enabling protection
- `Failed to log browser messages...` appears during page close

These should be cleaned up, but they are not the Zoom join problem.

### 8. Logs Currently Expose Sensitive Data

The current logs include full meeting URLs, including query-string secrets.

That creates unnecessary exposure for:

- Zoom `pwd` tokens
- webhook destination URLs

This should be fixed regardless of the Zoom join work.

## Most Likely Current Diagnosis

The strongest current diagnosis is:

1. Zoom presents multiple pre-join and in-meeting variants.
2. The bot currently assumes too little variation in pre-join prompts and join-state detection.
3. On the happy-path variant, the bot works.
4. On other variants, the bot can end up in a real meeting shell or semi-joined shell and still time out because the expected footer or container state is not detected in time.

## Recommended Direction

The right next step is Zoom-specific hardening, not broad platform refactoring.

Priority areas:

- explicit pre-join prompt handling
- multi-signal joined-state detection
- better failure diagnostics
- log redaction

## Out of Scope for This Note

Detailed sequencing and remaining work are captured in the companion plan document:

- `docs/2026-03-26-zoom-hardening-plan.md`

## Implementation Progress Update

Date updated: 2026-03-26

An initial hardening pass has now been applied in source.

Implemented:

- Zoom pre-join prompt dismissal in `src/bots/ZoomBot.ts`
- joined-state fallback detection using visible meeting controls, not only footer parsing
- richer Zoom join diagnostics for timeout cases
- a specific `MeetingEndedError` path for ended-by-host-before-recording cases
- URL redaction for correlation logging
- webhook log redaction

Files changed:

- `src/bots/ZoomBot.ts`
- `src/error.ts`
- `src/util/logger.ts`
- `src/services/notificationService.ts`

Verification completed:

- `npm run build` succeeded on 2026-03-26 after the changes

Still pending:

- live runtime validation of the patched Zoom bot against the observed Zoom variants
- follow-on cleanup for ECS task protection warnings
- follow-on cleanup for browser-log shutdown noise

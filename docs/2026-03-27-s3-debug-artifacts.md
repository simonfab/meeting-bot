# S3 Debug Artifacts

Date: 2026-03-27

## Objective

Ensure that when a meeting join fails in production, the bot can upload a screenshot to the same object storage system already used for recordings.

This replaces the old GCP-only debug screenshot path.

## Implemented

- `src/services/bugService.ts` now uploads PNG debug artifacts through the storage provider abstraction
- when `STORAGE_PROVIDER=s3`, artifacts are uploaded to the configured S3 bucket using the existing AWS SDK flow
- no static access keys are required when the runtime already has an IAM role with bucket write access
- Zoom, Google Meet, and Microsoft Teams join-failure screenshot paths now use `DEBUG_ARTIFACTS_ENABLED`
- startup now runs a best-effort smoke test via `runDebugArtifactSmokeTest()`
- artifact upload logs now include the exact object key and failure classification
- capture failures and upload failures are logged explicitly and separately

## Default Configuration

- `DEBUG_ARTIFACTS_ENABLED=true`
- `DEBUG_ARTIFACTS_SMOKE_TEST_ON_START=true`
- `DEBUG_ARTIFACT_PREFIX=meeting-bot/debug`

## Storage Layout

Debug artifacts are stored under:

`meeting-bot/debug/{environment}/{meeting-provider}/{stage}/user-{userId}/bot-{botId}/run-{runId?}/host-{hostname}/{timestamp}-{artifact-name}-{reason?}.png`

Examples:

- `meeting-bot/debug/production/zoom/join-failure/user-2/bot-maf-bot-f775496e/run-530c07fd-469d-5465-afc6-d47fb0c7a435/host-ip-10-0-1-24/2026-03-27T09-10-11.123Z-page-user-denied.png`
- `meeting-bot/debug/production/system/startup-smoke-test/user-system/bot-startup/host-ip-10-0-1-24/2026-03-27T09-10-12.456Z-smoke-test-startup-smoke-test.png`

## Operational Notes

- the startup smoke test is best-effort and does not block server startup
- the startup smoke test is wrapped so it cannot crash the process if artifact upload throws unexpectedly
- upload failures are logged explicitly with provider, key, and error details
- successful uploads are logged with provider, bucket or container, key, stage, and reason
- the uploader uses the same object-storage credentials and role-based access path as recording uploads

## Verification

Completed:

- `npm run build`

Not yet completed:

- production confirmation that the startup smoke test lands in the expected S3 prefix
- live confirmation that a real join failure uploads a screenshot artifact to S3

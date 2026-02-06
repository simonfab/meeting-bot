# Meeting Bot Production Plan

Last updated: 2026-02-06

## Purpose
Capture the production deployment plan for Meeting Bot, including the decisions we need to make in sequence and the current production gaps in code and configuration.

## Current State (Facts)
- MAF production runs on ECS Fargate in `helloworld3-cluster`.
- Two ECS services are live behind a public ALB.
- Streamlit UI target group is on port 8501.
- MAF API target group is on port 8001.
- Deployment is handled by `Deploy.ps1` which builds and pushes the `maf` image and refreshes the two existing ECS services.
- Meeting Bot is not deployed in production.
- Local dev uses `docker-compose.meeting-bot.yml` which starts meeting-bot + MinIO + Redis.
- Redis is disabled in dev by default (`REDIS_CONSUMER_ENABLED=false`).
- MinIO is for local dev only. Production must use S3.

## Architecture Summary (Production Intent)
1. Streamlit UI calls Meeting Bot service to join a meeting.
2. Meeting Bot records the meeting and uploads the file to object storage (S3).
3. Meeting Bot sends a webhook to MAF API: `/api/meeting-bot/recording-complete`.
4. MAF API downloads the recording from S3 and processes it.

## Decisions To Make (In Sequence)
1. Deployment model for Meeting Bot
   - Option A: Separate ECS service (recommended for prod).
   - Option B: Sidecar container in the Streamlit or API task (simpler but less flexible).
2. Internal networking model
   - Option A: Internal ALB for meeting-bot (private, VPC-only).
   - Option B: ECS Service Connect / Cloud Map (private DNS and routing).
3. Storage backend
   - Production is S3 only. Confirm bucket name, region, and credentials or IAM role.
   - Decide if S3 URL format should be virtual-hosted or path-style to match MAF API download parsing.
4. Webhook routing
   - Decide whether meeting-bot should call MAF API via public ALB domain or internal address.
   - Confirm webhook secret handling and rotation.
5. Build and deploy pipeline
   - Do not change `Deploy.ps1`.
   - Create a new `DeployBot.ps1` to build and push meeting-bot image and refresh the new ECS service.
6. Resource sizing and runtime requirements
   - CPU and RAM for Chrome + ffmpeg.
   - Shared memory size for headless browser stability.
   - Ephemeral storage sizing for recordings.
7. Security controls
   - Meeting-bot has no auth on join endpoints. Must be internal-only.
   - Security group rules must restrict inbound to MAF services only.
8. Observability and health checks
   - Confirm health endpoint and target group health check path.
   - Decide on log aggregation and alerting.

## Production Gaps In Current Code
1. Hardcoded webhook secret in MAF API
   - File: `api/routers/meeting_bot_webhook.py`
   - `WEBHOOK_SECRET` is hardcoded and should be an environment variable or secret.
2. Hardcoded MinIO configuration in MAF API
   - File: `api/routers/meeting_bot_webhook.py`
   - `MINIO_CONFIG` points to localhost and must be replaced with S3 configuration from env or IAM.
3. S3 URL parsing mismatch
   - MAF API expects path-style URLs like `http://host/bucket/key`.
   - Meeting Bot generates AWS virtual-hosted URLs like `https://bucket.s3.region.amazonaws.com/key`.
   - The webhook downloader must support both formats or meeting-bot must be configured to use path-style URLs.
4. Meeting Bot port is hardcoded
   - File: `meeting-bot/src/index.ts`
   - Port is fixed at 3000; `PORT` env is ignored.
5. Meeting Bot has no API auth
   - Must be restricted by network policy and security groups.
6. GCP envs logged as required in meeting-bot
   - `GCP_DEFAULT_REGION` and `GCP_MISC_BUCKET` are required by config but are not used for prod S3.
   - We should either supply dummy values or remove these requirements in config.

## Implementation Steps (Draft)
1. Create a new ECR repository for meeting-bot.
2. Build and push meeting-bot production image using `Dockerfile.production`.
3. Create ECS task definition for meeting-bot.
   - Port mapping: 3000.
   - Environment variables for S3 and webhook.
   - Ensure enough CPU, RAM, shared memory, and ephemeral storage.
4. Create ECS service for meeting-bot in `helloworld3-cluster`.
5. Set up internal routing.
   - Internal ALB or Service Connect.
   - Ensure meeting-bot is not publicly exposed.
6. Update Streamlit configuration to point to the meeting-bot internal URL.
   - The UI defaults to `http://localhost:3000` and should be configurable for prod.
7. Patch MAF API webhook for production S3 and secret handling.
8. Deploy and run an end-to-end test in staging.

## Production Configuration Checklist (Meeting Bot)
- `NOTIFY_WEBHOOK_ENABLED=true`
- `NOTIFY_WEBHOOK_URL=<maf-api>/api/meeting-bot/recording-complete`
- `NOTIFY_WEBHOOK_SECRET=<secret>`
- `STORAGE_PROVIDER=s3`
- `S3_REGION=<region>`
- `S3_BUCKET_NAME=<bucket>`
- `S3_ACCESS_KEY_ID=<key>` or IAM role
- `S3_SECRET_ACCESS_KEY=<secret>` or IAM role
- `S3_ENDPOINT=<omit for AWS>` or set only if using non-AWS S3
- `S3_USE_MINIO_COMPATIBILITY=false`
- `REDIS_CONSUMER_ENABLED=false`

## Open Questions
- Should meeting-bot be reachable only from Streamlit, or also from MAF API?
- Do we want the webhook path to be public (existing ALB domain) or internal-only?
- What is the desired retention policy for recordings in S3?


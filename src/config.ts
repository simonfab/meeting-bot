import dotenv from 'dotenv';
import { UploaderType } from './types';
dotenv.config();

const ENVIRONMENTS = [
  'production',
  'staging',
  'development',
  'cli',
  'test',
] as const;

export type Environment = (typeof ENVIRONMENTS)[number];
export const NODE_ENV: Environment = ENVIRONMENTS.includes(
  process.env.NODE_ENV as Environment
)
  ? (process.env.NODE_ENV as Environment)
  : 'staging';

console.log('NODE_ENV', process.env.NODE_ENV);

const isAudioOnlyRecordingEnabled = (() => {
  const raw = process.env.RECORD_AUDIO_ONLY;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'false') {
    return false;
  }
  return true;
})();

const isEcsTaskProtectionEnabled = (() => {
  const raw = process.env.ECS_TASK_PROTECTION_ENABLED;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'false') {
    return false;
  }
  return true;
})();

const isDebugArtifactsEnabled = (() => {
  const raw = process.env.DEBUG_ARTIFACTS_ENABLED;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'false') {
    return false;
  }
  return true;
})();

const isDebugArtifactsSmokeTestEnabled = (() => {
  const raw = process.env.DEBUG_ARTIFACTS_SMOKE_TEST_ON_START;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'false') {
    return false;
  }
  return true;
})();

const parsePositiveInteger = (raw: string | undefined, defaultValue: number): number => {
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.floor(parsed);
};

const maxConcurrentJobs = parsePositiveInteger(process.env.MAX_CONCURRENT_JOBS, 1);
if (maxConcurrentJobs > 1) {
  console.warn(
    'MAX_CONCURRENT_JOBS > 1 is not supported in single-meeting ECS protection mode.'
  );
}

const ecsTaskProtectionExpiresInMinutes = parsePositiveInteger(
  process.env.ECS_TASK_PROTECTION_EXPIRES_IN_MINUTES,
  240
);
const ecsTaskProtectionTimeoutMs = parsePositiveInteger(
  process.env.ECS_TASK_PROTECTION_TIMEOUT_MS,
  2000
);

console.log(
  'RECORD_AUDIO_ONLY',
  process.env.RECORD_AUDIO_ONLY ?? '(unset)',
  '=>',
  isAudioOnlyRecordingEnabled
);

const requiredSettings: string[] = [];
const missingSettings = requiredSettings.filter((s) => !process.env[s]);
if (missingSettings.length > 0) {
  missingSettings.forEach((ms) =>
    console.error(`ENV settings ${ms} is missing.`)
  );
}

const constructRedisUri = () => {
  const host = process.env.REDIS_HOST || 'redis';
  const port = process.env.REDIS_PORT || 6379;
  const username = process.env.REDIS_USERNAME;
  const password = process.env.REDIS_PASSWORD;

  if (username && password) {
    return `redis://${username}:${password}@${host}:${port}`;
  } else if (password) {
    return `redis://:${password}@${host}:${port}`;
  } else {
    return `redis://${host}:${port}`;
  }
};

export default {
  port: process.env.PORT || 3000,
  db: {
    host: process.env.DB_HOST || 'localhost',
    user: process,
  },
  // ScreenApp backend (optional). If not set, status/log updates are skipped.
  authBaseUrlV2: process.env.AUTH_BASE_URL_V2,
  // Unset MAX_RECORDING_DURATION_MINUTES to use default upper limit on duration
  maxRecordingDuration: process.env.MAX_RECORDING_DURATION_MINUTES ?
    Number(process.env.MAX_RECORDING_DURATION_MINUTES) :
    180, // There's an upper limit on meeting duration 3 hours
  chromeExecutablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', // We use Google Chrome with Playwright for recording
  inactivityLimit: process.env.MEETING_INACTIVITY_MINUTES ? Number(process.env.MEETING_INACTIVITY_MINUTES) : 1,
  activateInactivityDetectionAfter: process.env.INACTIVITY_DETECTION_START_DELAY_MINUTES ? Number(process.env.INACTIVITY_DETECTION_START_DELAY_MINUTES) :  1,
  serviceKey: process.env.SCREENAPP_BACKEND_SERVICE_API_KEY,
  joinWaitTime: process.env.JOIN_WAIT_TIME_MINUTES ? Number(process.env.JOIN_WAIT_TIME_MINUTES) : 10,
  // Number of retries for transient errors (not applied to WaitingAtLobbyRetryError)
  retryCount: process.env.RETRY_COUNT ? Number(process.env.RETRY_COUNT) : 2,
  // Audio-only recording is enabled by default.
  // Set RECORD_AUDIO_ONLY=false to revert to legacy audio+video capture.
  recordAudioOnly: isAudioOnlyRecordingEnabled,
  // ECS task protection uses the local ECS agent endpoint from ECS_AGENT_URI.
  ecsTaskProtectionEnabled: isEcsTaskProtectionEnabled,
  ecsTaskProtectionExpiresInMinutes: ecsTaskProtectionExpiresInMinutes,
  ecsTaskProtectionTimeoutMs: ecsTaskProtectionTimeoutMs,
  debugArtifactsEnabled: isDebugArtifactsEnabled,
  debugArtifactsSmokeTestOnStart: isDebugArtifactsSmokeTestEnabled,
  debugArtifactsPrefix: process.env.DEBUG_ARTIFACT_PREFIX ? process.env.DEBUG_ARTIFACT_PREFIX : 'meeting-bot/debug',
  redisQueueName: process.env.REDIS_QUEUE_NAME ?? 'jobs:meetbot:list',
  redisUri: constructRedisUri(),
  // Notification: Webhook (disabled by default)
  notifyWebhookEnabled: process.env.NOTIFY_WEBHOOK_ENABLED === 'true',
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL,
  // Optional secret to sign payloads (HMAC-SHA256). If set, signature will be sent in X-Webhook-Signature header
  notifyWebhookSecret: process.env.NOTIFY_WEBHOOK_SECRET,
  // Notification: Redis (disabled by default). Uses same REDIS connection but selectable DB and list
  notifyRedisEnabled: process.env.NOTIFY_REDIS_ENABLED === 'true',
  // If not provided, uses redisUri with specified database selection
  notifyRedisUri: process.env.NOTIFY_REDIS_URI, // optional override
  notifyRedisDb: process.env.NOTIFY_REDIS_DB ? Number(process.env.NOTIFY_REDIS_DB) : 1, // must not default to 0
  notifyRedisList: process.env.NOTIFY_REDIS_LIST ?? 'jobs:meetbot:recordings',
  uploaderFileExtension: process.env.UPLOADER_FILE_EXTENSION ? process.env.UPLOADER_FILE_EXTENSION : '.webm',
  isRedisEnabled: process.env.REDIS_CONSUMER_ENABLED === 'true',
  s3CompatibleStorage: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucket: process.env.S3_BUCKET_NAME,
    forcePathStyle: process.env.S3_USE_MINIO_COMPATIBILITY === 'true',
  },
  // Object storage provider selection: 's3' (default) or 'azure'
  storageProvider: (process.env.STORAGE_PROVIDER === 'azure' ? 'azure' : 's3') as 's3' | 'azure',
  azureBlobStorage: {
    // Either provide full connection string OR account + key/SAS OR managed identity
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    accountName: process.env.AZURE_STORAGE_ACCOUNT,
    accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY, // optional when using connection string
    sasToken: process.env.AZURE_STORAGE_SAS_TOKEN, // starts with ?sv=...
    useManagedIdentity: process.env.AZURE_USE_MANAGED_IDENTITY === 'true',
    container: process.env.AZURE_STORAGE_CONTAINER,
    blobPrefix: process.env.AZURE_BLOB_PREFIX || '',
    signedUrlTtlSeconds: process.env.AZURE_SIGNED_URL_TTL_SECONDS ? Number(process.env.AZURE_SIGNED_URL_TTL_SECONDS) : 3600,
    uploadConcurrency: process.env.AZURE_UPLOAD_CONCURRENCY ? Number(process.env.AZURE_UPLOAD_CONCURRENCY) : 4,
  },
  uploaderType: process.env.UPLOADER_TYPE ? (process.env.UPLOADER_TYPE as UploaderType) : 's3' as UploaderType,
  maxConcurrentJobs,
};

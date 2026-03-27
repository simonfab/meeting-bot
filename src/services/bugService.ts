import config, { NODE_ENV } from '../config';
import { Logger } from 'winston';
import { getStorageProvider } from '../uploader/providers/factory';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

type DebugArtifactMeetingProvider = 'zoom' | 'google' | 'microsoft' | 'system' | 'debug';

interface UploadOption {
  skipTimestamp?: boolean;
  meetingProvider?: DebugArtifactMeetingProvider;
  stage?: string;
  reason?: string;
  runId?: string;
}

type DebugArtifactDescriptor = {
  key: string;
  fileName: string;
  environment: string;
  host: string;
  meetingProvider: DebugArtifactMeetingProvider;
  stage: string;
  reason?: string;
  runId?: string;
  userId: string;
  botId: string;
  storageProvider: 's3' | 'azure';
};

export interface DebugArtifactUploadResult {
  uploaded: boolean;
  provider?: 's3' | 'azure';
  key?: string;
  storage?: Record<string, unknown>;
  error?: string;
  stage?: string;
  reason?: string;
  meetingProvider?: DebugArtifactMeetingProvider;
}

const SMOKE_TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAwMBAS8p3XQAAAAASUVORK5CYII=',
  'base64'
);

const sanitizeSegment = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'unknown';
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
};

const getTimestampSegment = (): string => new Date().toISOString().replace(/[:]/g, '-');

const getMeetingProviderPathSegment = (provider: DebugArtifactMeetingProvider): string => {
  if (provider === 'microsoft') {
    return 'teams';
  }
  return provider;
};

const buildDebugArtifactDescriptor = (
  fileName: string,
  userId: string,
  botId: string | undefined,
  opts?: UploadOption
): DebugArtifactDescriptor => {
  const provider = getStorageProvider();
  const safeFileName = sanitizeSegment(fileName);
  const environment = sanitizeSegment(NODE_ENV);
  const meetingProvider = opts?.meetingProvider ?? 'system';
  const meetingProviderPath = getMeetingProviderPathSegment(meetingProvider);
  const stage = sanitizeSegment(opts?.stage ?? fileName);
  const reason = opts?.reason ? sanitizeSegment(opts.reason) : undefined;
  const safeUserId = sanitizeSegment(userId);
  const safeBotId = sanitizeSegment(botId ?? 'bot');
  const safeRunId = opts?.runId ? sanitizeSegment(opts.runId) : undefined;
  const host = sanitizeSegment(os.hostname() || 'unknown-host');
  const timestamp = opts?.skipTimestamp ? 'notimestamp' : getTimestampSegment();
  const filenameSuffix = reason ? `-${reason}` : '';
  const fileKeyName = `${timestamp}-${safeFileName}${filenameSuffix}.png`;

  const pathSegments = [
    config.debugArtifactsPrefix,
    environment,
    meetingProviderPath,
    stage,
    `user-${safeUserId}`,
    `bot-${safeBotId}`,
  ];

  if (safeRunId) {
    pathSegments.push(`run-${safeRunId}`);
  }

  pathSegments.push(`host-${host}`, fileKeyName);

  return {
    key: pathSegments.join('/'),
    fileName: safeFileName,
    environment,
    host,
    meetingProvider,
    stage,
    reason,
    runId: safeRunId,
    userId: safeUserId,
    botId: safeBotId,
    storageProvider: provider.name,
  };
};

const getStorageDetails = (
  descriptor: DebugArtifactDescriptor
): Record<string, unknown> => {
  if (descriptor.storageProvider === 's3') {
    return {
      provider: 's3',
      bucket: config.s3CompatibleStorage.bucket,
      key: descriptor.key,
      region: config.s3CompatibleStorage.region,
      endpoint: config.s3CompatibleStorage.endpoint,
      forcePathStyle: !!config.s3CompatibleStorage.forcePathStyle,
    };
  }

  return {
    provider: 'azure',
    container: config.azureBlobStorage.container,
    accountName: config.azureBlobStorage.accountName,
    key: descriptor.key,
    blobPrefix: config.azureBlobStorage.blobPrefix,
  };
};

const getArtifactLogContext = (descriptor: DebugArtifactDescriptor): Record<string, unknown> => ({
  storageProvider: descriptor.storageProvider,
  environment: descriptor.environment,
  meetingProvider: descriptor.meetingProvider,
  stage: descriptor.stage,
  reason: descriptor.reason,
  userId: descriptor.userId,
  botId: descriptor.botId,
  runId: descriptor.runId,
  host: descriptor.host,
  key: descriptor.key,
});

const createTempPngFile = async (buffer: Buffer): Promise<{ tempDir: string; filePath: string }> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-bot-debug-'));
  const filePath = path.join(tempDir, 'artifact.png');
  await fs.writeFile(filePath, buffer);
  return { tempDir, filePath };
};

const cleanupTempPngFile = async (tempDir: string): Promise<void> => {
  await fs.rm(tempDir, { recursive: true, force: true });
};

const uploadDebugArtifactBuffer = async (
  buffer: Buffer,
  descriptor: DebugArtifactDescriptor,
  logger: Logger
): Promise<DebugArtifactUploadResult> => {
  const provider = getStorageProvider();
  const logContext = getArtifactLogContext(descriptor);
  let tempDir: string | undefined;

  try {
    provider.validateConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Debug artifact provider unavailable', {
      ...logContext,
      error: message,
    });
    return {
      uploaded: false,
      provider: descriptor.storageProvider,
      key: descriptor.key,
      storage: getStorageDetails(descriptor),
      error: message,
      stage: descriptor.stage,
      reason: descriptor.reason,
      meetingProvider: descriptor.meetingProvider,
    };
  }

  try {
    const tmp = await createTempPngFile(buffer);
    tempDir = tmp.tempDir;

    logger.info('Uploading debug artifact to object storage...', logContext);

    const uploaded = await provider.uploadFile({
      filePath: tmp.filePath,
      key: descriptor.key,
      contentType: 'image/png',
      logger,
      partSize: 5 * 1024 * 1024,
      concurrency: 1,
    });

    const storage = getStorageDetails(descriptor);

    if (!uploaded) {
      logger.error('Debug artifact upload failed', {
        ...logContext,
        storage,
        error: 'upload_failed',
      });
      return {
        uploaded: false,
        provider: descriptor.storageProvider,
        key: descriptor.key,
        storage,
        error: 'upload_failed',
        stage: descriptor.stage,
        reason: descriptor.reason,
        meetingProvider: descriptor.meetingProvider,
      };
    }

    logger.info('Debug artifact uploaded successfully', {
      ...logContext,
      storage,
    });
    return {
      uploaded: true,
      provider: descriptor.storageProvider,
      key: descriptor.key,
      storage,
      stage: descriptor.stage,
      reason: descriptor.reason,
      meetingProvider: descriptor.meetingProvider,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Debug artifact upload threw an exception', {
      ...logContext,
      error: message,
    });
    return {
      uploaded: false,
      provider: descriptor.storageProvider,
      key: descriptor.key,
      storage: getStorageDetails(descriptor),
      error: message,
      stage: descriptor.stage,
      reason: descriptor.reason,
      meetingProvider: descriptor.meetingProvider,
    };
  } finally {
    if (tempDir) {
      try {
        await cleanupTempPngFile(tempDir);
      } catch (cleanupError) {
        logger.warn('Failed to clean up temporary debug artifact file', {
          ...logContext,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
  }
};

export const uploadDebugImage = async (
  buffer: Buffer,
  fileName: string,
  userId: string,
  logger: Logger,
  botId?: string,
  opts?: UploadOption
): Promise<DebugArtifactUploadResult> => {
  if (!config.debugArtifactsEnabled) {
    logger.info('Debug artifact upload skipped because DEBUG_ARTIFACTS_ENABLED=false');
    return { uploaded: false, error: 'disabled' };
  }

  const descriptor = buildDebugArtifactDescriptor(fileName, userId, botId, opts);
  return uploadDebugArtifactBuffer(buffer, descriptor, logger);
};

export const captureAndUploadDebugImage = async ({
  capture,
  fileName,
  userId,
  logger,
  botId,
  opts,
}: {
  capture: () => Promise<Buffer>;
  fileName: string;
  userId: string;
  logger: Logger;
  botId?: string;
  opts?: UploadOption;
}): Promise<DebugArtifactUploadResult> => {
  if (!config.debugArtifactsEnabled) {
    logger.info('Debug artifact capture skipped because DEBUG_ARTIFACTS_ENABLED=false');
    return { uploaded: false, error: 'disabled' };
  }

  const descriptor = buildDebugArtifactDescriptor(fileName, userId, botId, opts);
  const logContext = getArtifactLogContext(descriptor);

  let buffer: Buffer;
  try {
    buffer = await capture();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Debug artifact capture failed', {
      ...logContext,
      error: message,
    });
    return {
      uploaded: false,
      provider: descriptor.storageProvider,
      key: descriptor.key,
      storage: getStorageDetails(descriptor),
      error: `capture_failed:${message}`,
      stage: descriptor.stage,
      reason: descriptor.reason,
      meetingProvider: descriptor.meetingProvider,
    };
  }

  return uploadDebugArtifactBuffer(buffer, descriptor, logger);
};

export const runDebugArtifactSmokeTest = async (logger: Logger): Promise<void> => {
  if (!config.debugArtifactsEnabled || !config.debugArtifactsSmokeTestOnStart) {
    logger.info('Debug artifact smoke test skipped by configuration', {
      debugArtifactsEnabled: config.debugArtifactsEnabled,
      debugArtifactsSmokeTestOnStart: config.debugArtifactsSmokeTestOnStart,
    });
    return;
  }

  logger.info('Starting debug artifact smoke test...');
  const result = await uploadDebugImage(
    SMOKE_TEST_PNG,
    'smoke-test',
    'system',
    logger,
    'startup',
    {
      meetingProvider: 'system',
      stage: 'startup-smoke-test',
      reason: 'startup-smoke-test',
    }
  );

  if (result.uploaded) {
    logger.info('Debug artifact smoke test succeeded', {
      provider: result.provider,
      key: result.key,
      storage: result.storage,
      stage: result.stage,
      reason: result.reason,
      meetingProvider: result.meetingProvider,
    });
    return;
  }

  logger.warn('Debug artifact smoke test failed', {
    provider: result.provider,
    key: result.key,
    error: result.error,
    storage: result.storage,
    stage: result.stage,
    reason: result.reason,
    meetingProvider: result.meetingProvider,
  });
};

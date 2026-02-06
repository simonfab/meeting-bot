import { StorageProvider, UploadOptions } from './storage-provider';
import config from '../../config';
import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, statSync } from 'fs';

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;

  validateConfig(): void {
    const s3 = config.s3CompatibleStorage;
    const missing: string[] = [];
    if (!s3.region) missing.push('S3_REGION');
    if (!s3.bucket) missing.push('S3_BUCKET_NAME');
    // If one static credential is provided, require the other too.
    if ((s3.accessKeyId && !s3.secretAccessKey) || (!s3.accessKeyId && s3.secretAccessKey)) {
      if (!s3.accessKeyId) missing.push('S3_ACCESS_KEY_ID');
      if (!s3.secretAccessKey) missing.push('S3_SECRET_ACCESS_KEY');
    }
    if (missing.length) {
      throw new Error(`S3 compatible storage configuration is not set or incomplete. Missing: ${missing.join(', ')}`);
    }
  }

  async uploadFile(options: UploadOptions): Promise<boolean> {
    const s3Config = config.s3CompatibleStorage;

    // TypeScript knows these are defined because validateConfig() was called first
    if (!s3Config.region || !s3Config.bucket) {
      throw new Error('S3 configuration validation failed - this should never happen after validateConfig()');
    }

    const clientConfig: S3ClientConfig = {
      region: s3Config.region,
      forcePathStyle: !!s3Config.forcePathStyle,
    };

    const accessKeyId = s3Config.accessKeyId;
    const secretAccessKey = s3Config.secretAccessKey;
    const usingStaticCreds = Boolean(accessKeyId && secretAccessKey);
    // Only set explicit credentials when provided; otherwise use the default provider chain
    // (ECS task role, instance profile, etc).
    if (accessKeyId && secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId,
        secretAccessKey,
      };
    }

    if (s3Config.endpoint) {
      clientConfig.endpoint = s3Config.endpoint;
    }

    const s3Client = new S3Client(clientConfig);

    try {
      let fileSizeBytes: number | undefined;
      try {
        fileSizeBytes = statSync(options.filePath).size;
      } catch {
        // Ignore stat errors; upload will still attempt
      }

      options.logger.info('S3 upload config', {
        bucket: s3Config.bucket,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        forcePathStyle: !!s3Config.forcePathStyle,
        credentialSource: usingStaticCreds ? 'static' : 'default-provider-chain',
      });
      options.logger.info('S3 upload source', {
        key: options.key,
        contentType: options.contentType,
        filePath: options.filePath,
        fileSizeBytes,
      });

      options.logger.info(`Starting upload of ${options.key}`);
      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: s3Config.bucket,
          Key: options.key,
          Body: createReadStream(options.filePath),
          ContentType: options.contentType,
        },
        queueSize: options.concurrency || 4,
        partSize: options.partSize || 50 * 1024 * 1024,
      });

      upload.on('httpUploadProgress', (progress) => {
        options.logger.info(`Uploaded ${options.key} ${progress.loaded} of ${progress.total || 0} bytes`);
      });

      await upload.done();
      options.logger.info(`Upload of ${options.key} complete.`);
      return true;
    } catch (err) {
      const errAny = err as any;
      const meta = errAny?.$metadata || {};
      options.logger.error(`Upload for ${options.key} failed.`, {
        name: errAny?.name,
        message: errAny?.message,
        code: errAny?.code,
        stack: errAny?.stack,
        httpStatusCode: meta?.httpStatusCode,
        requestId: meta?.requestId,
        extendedRequestId: meta?.extendedRequestId,
        cfId: meta?.cfId,
        retryable: errAny?.$retryable,
        bucket: s3Config.bucket,
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        forcePathStyle: !!s3Config.forcePathStyle,
        credentialSource: usingStaticCreds ? 'static' : 'default-provider-chain',
      });
      return false;
    }
  }
}

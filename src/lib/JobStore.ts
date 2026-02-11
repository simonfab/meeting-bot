import { Logger } from 'winston';
import { KnownError } from '../error';
import { getErrorType } from '../util/logger';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface JobInfo {
  jobId: string;
  startedAt: Date;
  metadata?: Record<string, any>;
}

export class JobStore {
  private jobs: Map<string, JobInfo> = new Map();
  private maxConcurrent: number;
  private shutdownRequested: boolean = false;

  constructor(maxConcurrent: number = 3) {
    this.maxConcurrent = maxConcurrent;
  }

  async addJob<T>(
    jobId: string,
    task: () => Promise<T>,
    logger: Logger,
    metadata?: Record<string, any>,
    retryCount: number = 0
  ): Promise<{ accepted: boolean }> {
    if (this.jobs.size >= this.maxConcurrent || this.shutdownRequested) {
      return { accepted: false };
    }

    this.jobs.set(jobId, {
      jobId,
      startedAt: new Date(),
      metadata,
    });

    // Execute the task asynchronously without waiting for completion
    this.executeTaskWithRetry(task, logger, retryCount).then(() => {
      logger.info('LogBasedMetric Bot has finished recording meeting successfully.', { jobId });
    }).catch((error) => {
      const errorType = getErrorType(error);
      if (error instanceof KnownError) {
        logger.error('KnownError JobStore is permanently exiting:', { jobId, error });
      } else {
        logger.error('Error executing task after multiple retries:', { jobId, error });
      }
      logger.error(`LogBasedMetric Bot has permanently failed. [errorType: ${errorType}]`, { jobId });
    }).finally(() => {
      this.jobs.delete(jobId);
    });

    logger.info('LogBasedMetric Bot job has been queued and started recording meeting.', { jobId });
    return { accepted: true };
  }

  private async executeTaskWithRetry<T>(
    task: () => Promise<T>,
    logger: Logger,
    retryCount: number
  ): Promise<void> {
    try {
      await task();
    } catch (error) {
      if (error instanceof KnownError && !error.retryable) {
        logger.error('KnownError is not retryable:', error.name, error.message);
        throw error;
      }

      if (error instanceof KnownError && error.retryable && (retryCount + 1) >= error.maxRetries) {
        logger.error(`KnownError: ${error.maxRetries} tries consumed:`, error.name, error.message);
        throw error;
      }

      retryCount += 1;
      await sleep(retryCount * 30000);
      if (retryCount < 3) {
        if (retryCount) {
          logger.warn(`Retry count: ${retryCount}`);
        }
        await this.executeTaskWithRetry(task, logger, retryCount);
      } else {
        throw error;
      }
    }
  }

  isBusy(): boolean {
    return this.jobs.size >= this.maxConcurrent;
  }

  isFull(): boolean {
    return this.jobs.size >= this.maxConcurrent;
  }

  getActiveCount(): number {
    return this.jobs.size;
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  getActiveJobs(): JobInfo[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Check if shutdown has been requested
   */
  isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }

  /**
   * Request graceful shutdown - prevents new jobs from being accepted
   */
  requestShutdown(): void {
    this.shutdownRequested = true;
  }

  /**
   * Wait for all ongoing tasks to complete
   * @returns Promise that resolves when all tasks are complete
   */
  async waitForCompletion(): Promise<void> {
    if (this.jobs.size === 0) {
      return; // No tasks running, can shutdown immediately
    }

    console.log(`Waiting for ${this.jobs.size} ongoing tasks to complete...`);

    return new Promise<void>((resolve) => {
      const checkCompletion = () => {
        if (this.jobs.size === 0) {
          console.log('All tasks completed successfully');
          resolve();
        } else {
          setTimeout(checkCompletion, 1000); // Check every 1 second
        }
      };
      checkCompletion();
    });
  }
}

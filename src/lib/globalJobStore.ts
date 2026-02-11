import { JobStore } from './JobStore';
import config from '../config';

// Create a global job store instance with configurable concurrency
export const globalJobStore = new JobStore(config.maxConcurrentJobs);

// Utility functions for easier access
export const isShutdownRequested = (): boolean => globalJobStore.isShutdownRequested();
export const isJobStoreBusy = (): boolean => globalJobStore.isBusy();

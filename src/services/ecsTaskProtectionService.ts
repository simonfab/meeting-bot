import axios from 'axios';
import config from '../config';

const TASK_PROTECTION_PATH = '/task-protection/v1/state';
const MIN_EXPIRES_IN_MINUTES = 1;
const MAX_EXPIRES_IN_MINUTES = 2880;

let currentProtectionState = false;
let warnedMissingAgentUri = false;

type TaskProtectionPayload = {
  ProtectionEnabled: boolean;
  ExpiresInMinutes?: number;
};

const clampExpiresInMinutes = (expiresInMinutes: number): number =>
  Math.min(
    MAX_EXPIRES_IN_MINUTES,
    Math.max(MIN_EXPIRES_IN_MINUTES, Math.floor(expiresInMinutes))
  );

const getTaskProtectionUrl = (): string | null => {
  const ecsAgentUri = process.env.ECS_AGENT_URI;
  if (!ecsAgentUri) {
    return null;
  }
  return `${ecsAgentUri.replace(/\/$/, '')}${TASK_PROTECTION_PATH}`;
};

const getSerializableErrorBody = (data: unknown): string | null => {
  if (data == null) {
    return null;
  }
  if (typeof data === 'string') {
    return data;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
};

export const setTaskProtection = async (enabled: boolean): Promise<void> => {
  if (!config.ecsTaskProtectionEnabled) {
    return;
  }

  if (currentProtectionState === enabled) {
    return;
  }

  const url = getTaskProtectionUrl();
  if (!url) {
    if (!warnedMissingAgentUri) {
      console.warn(
        '[ecs-task-protection] ECS_AGENT_URI is missing. Skipping task protection updates.'
      );
      warnedMissingAgentUri = true;
    }
    return;
  }

  const payload: TaskProtectionPayload = enabled
    ? {
      ProtectionEnabled: true,
      ExpiresInMinutes: clampExpiresInMinutes(config.ecsTaskProtectionExpiresInMinutes),
    }
    : {
      ProtectionEnabled: false,
    };

  try {
    const response = await axios.put(url, payload, {
      timeout: config.ecsTaskProtectionTimeoutMs,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (response.status >= 200 && response.status < 300) {
      currentProtectionState = enabled;
      return;
    }

    console.warn(
      `[ecs-task-protection] Failed to set ProtectionEnabled=${enabled}. HTTP ${response.status}. Body=${getSerializableErrorBody(response.data) ?? '(empty)'}`
    );
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const responseBody = getSerializableErrorBody(error.response?.data);
      const errorMessage = error.message;
      console.warn(
        `[ecs-task-protection] Error setting ProtectionEnabled=${enabled}: ${errorMessage}; status=${status ?? 'unknown'}; body=${responseBody ?? '(empty)'}; url=${url}`
      );
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(
      `[ecs-task-protection] Error setting ProtectionEnabled=${enabled}: ${errorMessage}`
    );
  }
};

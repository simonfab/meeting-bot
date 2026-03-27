import { captureAndUploadDebugImage } from '../services/bugService';
import createBrowserContext from '../lib/chromium';
import { loggerFactory } from '../util/logger';
import { v4 } from 'uuid';

async function mainDebug(userId: string, url: string) {
  const correlationId = v4();
  const logger = loggerFactory(correlationId, 'debug');
  console.log('Launching browser...', { userId: userId });

  const page = await createBrowserContext(url, correlationId);

  console.log('Navigating to URL...');
  await page.goto(url, { waitUntil: 'networkidle' });

  console.log('Uploading screenshot...');
  await captureAndUploadDebugImage({
    capture: () => page.screenshot({ type: 'png' }),
    fileName: 'page',
    userId,
    logger,
    botId: 'manual-debug',
    opts: {
      meetingProvider: 'debug',
      stage: 'manual-debug',
      reason: 'website-page',
      runId: correlationId,
    },
  });

  console.log('Closing the browser...');
  await page.context().browser()?.close();
}

export default mainDebug;

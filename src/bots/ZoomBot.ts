import { Frame, Page } from 'playwright';
import { JoinParams, AbstractMeetBot } from './AbstractMeetBot';
import { BotStatus, WaitPromise } from '../types';
import config from '../config';
import { WaitingAtLobbyRetryError } from '../error';
import { v4 } from 'uuid';
import { patchBotStatus } from '../services/botService';
import { RecordingTask } from '../tasks/RecordingTask';
import { ContextBridgeTask } from '../tasks/ContextBridgeTask';
import { getWaitingPromise } from '../lib/promise';
import createBrowserContext from '../lib/chromium';
import { uploadDebugImage } from '../services/bugService';
import { Logger } from 'winston';
import { handleWaitingAtLobbyError } from './MeetBotBase';
import { ZOOM_REQUEST_DENIED } from '../constants';

class BotBase extends AbstractMeetBot {
  protected page: Page;
  protected slightlySecretId: symbol; // Use any hard-to-guess identifier
  protected _logger: Logger;
  protected _correlationId: string;
  constructor(logger: Logger, correlationId: string) {
    super();
    this.slightlySecretId = Symbol(v4());
    this._logger = logger;
    this._correlationId = correlationId;
  }
  join(params: JoinParams): Promise<void> {
    throw new Error('Function not implemented.');
  }
}

export class ZoomBot extends BotBase {
  constructor(logger: Logger, correlationId: string) {
    super(logger, correlationId);
  }

  // TODO use base class for shared functions such as bot status and bot logging
  // TODO Lift the JoinParams to the constructor argument
  async join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader }: JoinParams): Promise<void> {
    const _state: BotStatus[] = ['processing'];

    const handleUpload = async () => {
      this._logger.info('Begin recording upload to server', { userId, teamId });
      const uploadResult = await uploader.uploadRecordingToRemoteStorage();
      this._logger.info('Recording upload result', { uploadResult, userId, teamId });
    };

    try {
      const pushState = (st: BotStatus) => _state.push(st);
      await this.joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, pushState, uploader });
      await patchBotStatus({ botId, eventId, provider: 'zoom', status: _state, token: bearerToken }, this._logger);

      // Finish the upload from the temp video
      await handleUpload();
    } catch(error) {
      if (!_state.includes('finished'))
        _state.push('failed');

      await patchBotStatus({ botId, eventId, provider: 'zoom', status: _state, token: bearerToken }, this._logger);

      if (error instanceof WaitingAtLobbyRetryError) {
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'zoom', error }, this._logger);
      }

      throw error;
    }
  }

  private async joinMeeting({ pushState, ...params }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    const { url, name } = params;
    this._logger.info('Launching browser for Zoom...', { userId: params.userId });

    this.page = await createBrowserContext(url, this._correlationId, 'zoom');

    await this.page.route('**/*.exe', (route) => {
      this._logger.info(`Detected .exe download: ${route.request().url()?.split('download')[0]}`);
    });

    // --- FAST PATH: Try direct web client URL first (skips landing page entirely) ---
    let usingDirectWebClient = false;
    let joinedWebClient = false;

    const tryDirectWebClient = (): boolean => {
      try {
        const wcUrl = new URL(url);
        // Only works for standard /j/ links
        if (wcUrl.pathname.includes('/j/')) {
          return true;
        }
        return false;
      } catch {
        return false;
      }
    };

    if (tryDirectWebClient()) {
      try {
        const wcUrl = new URL(url);
        wcUrl.pathname = wcUrl.pathname.replace('/j/', '/wc/join/');
        this._logger.info('FAST PATH: Navigating directly to Zoom Web Client...', { wcUrl: wcUrl.toString(), botId: params.botId });
        await this.page.goto(wcUrl.toString(), { waitUntil: 'networkidle' });
        usingDirectWebClient = true;
        joinedWebClient = true;
        this._logger.info('FAST PATH: Direct web client navigation succeeded');
      } catch (err) {
        this._logger.info('FAST PATH: Direct web client failed, falling back to landing page...', { error: err?.message });
      }
    }

    // --- FALLBACK: Original landing page approach ---
    if (!joinedWebClient) {
      this._logger.info('FALLBACK: Navigating to Zoom landing page...');
      await this.page.goto(url, { waitUntil: 'networkidle' });

      // Accept cookies
      try {
        const acceptCookies = this.page.locator('button', { hasText: 'Accept Cookies' });
        await acceptCookies.waitFor({ timeout: 3000 });
        await acceptCookies.click({ force: true });
        this._logger.info('Clicked Accept Cookies');
      } catch {
        this._logger.info('No cookies banner found, continuing...');
      }

      // Try to find and click "Join from your browser"
      const findAndClickJoinFromBrowser = async (): Promise<boolean> => {
        for (let retry = 0; retry < 3; retry++) {
          try {
            await this.page.waitForTimeout(1000);

            // Click "Download Now" to reveal "Join from your browser" link
            const downloadBtn = this.page.getByRole('button', { name: /Download Now/i }).first();
            if (await downloadBtn.isVisible()) {
              await downloadBtn.click({ force: true });
            }

            const joinLink = this.page.locator('a', { hasText: 'Join from your browser' }).first();
            await joinLink.waitFor({ timeout: 5000 });
            if ((await joinLink.count()) > 0) {
              await joinLink.click({ force: true });
              return true;
            }
          } catch {
            this._logger.info(`FALLBACK: Retry ${retry + 1}/3 finding Join from browser link...`);
          }
        }
        return false;
      };

      const clickedJoinFromBrowser = await findAndClickJoinFromBrowser();

      if (clickedJoinFromBrowser) {
        // Wait for navigation to web client
        const navSuccess = await this.waitForLandingPageNav();
        if (!navSuccess) {
          this._logger.info('FALLBACK: Navigation after click failed, trying direct URL...');
          const wcUrl = new URL(url);
          wcUrl.pathname = wcUrl.pathname.replace('/j/', '/wc/join/');
          await this.page.goto(wcUrl.toString(), { waitUntil: 'networkidle' });
          usingDirectWebClient = true;
        }
      } else {
        // Last resort: direct URL
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'enable-join-from-browser', params.userId, this._logger, params.botId);
        this._logger.info('FALLBACK: Could not find Join from browser, trying direct URL...');
        const wcUrl = new URL(url);
        wcUrl.pathname = wcUrl.pathname.replace('/j/', '/wc/join/');
        await this.page.goto(wcUrl.toString(), { waitUntil: 'networkidle' });
        usingDirectWebClient = true;
      }
    }

    this._logger.info('On the web client page', { usingDirectWebClient });

    // Detect whether web client renders as main page or iframe
    let iframe: Frame | Page = this.page;
    const foundAppContainer = await this.detectAppContainer(usingDirectWebClient ? 'app' : 'iframe');
    if (foundAppContainer.frame) {
      iframe = foundAppContainer.frame;
    }

    if (!foundAppContainer.success) {
      throw new Error(`Failed to get the Zoom PWA iframe on user ${params.userId}`);
    }

    // Fill name and join
    this._logger.info('Waiting for the input field to be visible...');
    await iframe.waitForSelector('input[type="text"]', { timeout: 30000 });

    await this.page.waitForTimeout(300);
    this._logger.info('Filling the input field with the name...');
    await iframe.fill('input[type="text"]', name ? name : 'ScreenApp Notetaker');

    await this.page.waitForTimeout(300);

    this._logger.info('Clicking the "Join" button...');
    const joinButton = iframe.locator('button', { hasText: 'Join' });
    await joinButton.click();

    // Wait in waiting room
    try {
      const wanderingTime = config.joinWaitTime * 60 * 1000; // Give some time to be let in

      let waitTimeout: NodeJS.Timeout;
      let waitInterval: NodeJS.Timeout;
      const waitAtLobbyPromise = new Promise<boolean>((resolveMe) => {
        waitTimeout = setTimeout(() => {
          clearInterval(waitInterval);
          resolveMe(false);
        }, wanderingTime);

        waitInterval = setInterval(async () => {
          try {
            const footerInfo = iframe.locator('#wc-footer');
            await footerInfo.waitFor({ state: 'attached' });
            const footerText = await footerInfo?.innerText();

            const tokens1 = footerText.split('\n');
            const tokens2 = footerText.split(' ');
            const tokens = tokens1.length > tokens2.length ? tokens1 : tokens2;

            const filtered: string[] = [];
            for (const tok of tokens) {
              if (!tok) continue;
              if (!Number.isNaN(Number(tok.trim())))
                filtered.push(tok);
              else if (tok.trim().toLowerCase() === 'participants') {
                filtered.push(tok.trim().toLowerCase());
                break;
              }
            }
            const joinedText = filtered.join('');

            if (joinedText === 'participants')
              return;

            const isValid = joinedText.match(/\d+(.*)participants/i);
            if (!isValid) {
              return;
            }

            const num = joinedText.match(/\d+/);
            this._logger.info('Final Number of participants while waiting...', num);
            if (num && Number(num[0]) === 0)
              this._logger.info('Waiting on host...');
            else {
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveMe(true);
            }
          } catch(e) {
            // Do nothing
          }
        }, 2000);
      });

      const joined = await waitAtLobbyPromise;
      if (!joined) {
        const bodyText = await this.page.evaluate(() => document.body.innerText);

        const userDenied = (bodyText || '')?.includes(ZOOM_REQUEST_DENIED);

        this._logger.error('Cant finish wait at the lobby check', { userDenied, waitingAtLobbySuccess: joined, bodyText });

        // Don't retry lobby errors - if user doesn't admit bot, retrying won't help
        throw new WaitingAtLobbyRetryError('Zoom bot could not enter the meeting...', bodyText ?? '', false, 0);
      }

      this._logger.info('Bot is entering the meeting after wait room...');
    } catch (error) {
      this._logger.info('Closing the browser on error...', error);
      await this.page.context().browser()?.close();

      throw error;
    }

    // Dismiss device notifications quickly (reduced from 30s to 5s timeout)
    await this.dismissDeviceNotifications(iframe);

    // Dismiss announcements OK button if present
    try {
      const okButton = iframe.locator('button', { hasText: 'OK' }).first();
      if (await okButton.isVisible()) {
        await okButton.click({ timeout: 5000 });
        this._logger.info('Dismissed the OK button...');
      }
    } catch (error) {
      this._logger.info('OK button might be missing...', error);
    }

    pushState('joined');

    // Recording the meeting page
    this._logger.info('Begin recording...');
    await this.recordMeetingPage({ ...params });

    pushState('finished');
  }

  /**
   * Wait for page to navigate away from the "Join from your browser" landing page.
   * Reduced polling interval from 3s to 1.5s, max attempts from 3 to 4.
   */
  private async waitForLandingPageNav(): Promise<boolean> {
    try {
      const maxAttempts = 4;
      let attempt = 0;

      return await new Promise<boolean>((resolve) => {
        const interv = setInterval(async () => {
          if (attempt >= maxAttempts) {
            clearInterval(interv);
            resolve(false);
            return;
          }

          try {
            const joinFromBrowser = this.page.locator('a', { hasText: 'Join from your browser' }).first();
            await joinFromBrowser.waitFor({ timeout: 2000 }).catch(() => {});
            if ((await joinFromBrowser.count()) > 0) {
              this._logger.info('Still on landing page, waiting...', attempt);
            } else {
              clearInterval(interv);
              resolve(true);
            }
          } catch (e) {
            if (e?.name === 'TimeoutError') {
              this._logger.info('Join from browser link gone, navigation complete');
              clearInterval(interv);
              resolve(true);
              return;
            }
            this._logger.info('Error waiting for navigation', e);
            if (attempt >= maxAttempts) {
              clearInterval(interv);
              resolve(false);
            }
          }
          attempt += 1;
        }, 1500);
      });
    } catch {
      return false;
    }
  }

  /**
   * Detect whether Zoom web client renders in an iframe or directly on the page.
   * Tries both approaches with reduced timeouts (15s instead of 30s).
   */
  private async detectAppContainer(startWith: 'app' | 'iframe'): Promise<{ success: boolean; frame: Frame | Page | null }> {
    const tried: Set<string> = new Set();

    const detect = async (mode: 'app' | 'iframe'): Promise<{ success: boolean; frame: Frame | Page | null }> => {
      if (tried.has(mode)) {
        return { success: false, frame: null };
      }
      tried.add(mode);

      try {
        if (mode === 'app') {
          const input = await this.page.waitForSelector('input[type="text"]', { timeout: 15000 });
          const join = this.page.locator('button', { hasText: /Join/i });
          await join.waitFor({ timeout: 10000 });
          this._logger.info('App container detected', { input: input !== null });
          if (input) {
            return { success: true, frame: this.page };
          }
          return await detect('iframe');
        }

        if (mode === 'iframe') {
          const iframeHandle = await this.page.waitForSelector('iframe#webclient', { timeout: 15000, state: 'attached' });
          this._logger.info('Iframe container detected');
          const contentFrame = await iframeHandle.contentFrame();
          if (contentFrame) {
            return { success: true, frame: contentFrame };
          }
          return await detect('app');
        }
      } catch (err) {
        this._logger.info('Cannot detect app container', { mode, error: err?.message });
        const other = mode === 'app' ? 'iframe' : 'app';
        return await detect(other);
      }

      return { success: false, frame: null };
    };

    return await detect(startWith);
  }

  /**
   * Dismiss camera/mic notifications. Quick check with 5s timeout (was 30s).
   * If notifications appear, close them. If none appear within 5s, move on.
   */
  private async dismissDeviceNotifications(iframe: Frame | Page): Promise<void> {
    try {
      const stopWaiting = 5000; // Reduced from 30s — if no notifications in 5s, move on
      let notifyInterval: NodeJS.Timeout;
      let notifyTimeout: NodeJS.Timeout;

      const notifyPromise = new Promise<void>((resolve) => {
        let foundAny = false;

        notifyTimeout = setTimeout(() => {
          clearInterval(notifyInterval);
          resolve();
        }, stopWaiting);

        notifyInterval = setInterval(async () => {
          try {
            const closeButtons = await iframe.getByLabel('close').all();
            if (closeButtons.length > 0) {
              foundAny = true;
              this._logger.info('Closing device notification buttons...', closeButtons.length);
              for (const close of closeButtons) {
                if (await close.isVisible()) {
                  await close.click({ timeout: 3000 });
                }
              }
            } else if (foundAny) {
              // We found and closed notifications, and now they're gone — done
              clearInterval(notifyInterval);
              clearTimeout(notifyTimeout);
              resolve();
            }
          } catch {
            // Ignore and keep trying
          }
        }, 1000);
      });

      await notifyPromise;
    } catch (err) {
      this._logger.info('Device notification dismissal error (non-fatal)', err?.message);
    }
  }

  private async recordMeetingPage(params: JoinParams): Promise<void> {
    const { teamId, userId, eventId, botId, uploader } = params;
    const duration = config.maxRecordingDuration * 60 * 1000;

    this._logger.info('Setting up the duration');
    const processingTime = 0.2 * 60 * 1000;
    const waitingPromise: WaitPromise = getWaitingPromise(processingTime + duration);

    this._logger.info('Setting up the recording connect functions');
    const chores = new ContextBridgeTask(
      this.page,
      { ...params, botId: params.botId ?? '' },
      this.slightlySecretId.toString(),
      waitingPromise,
      uploader,
      this._logger
    );
    await chores.runAsync(null);

    this._logger.info('Setting up the recording Main Task');
    // Inject the MediaRecorder code into the browser context using page.evaluate
    const recordingTask = new RecordingTask(
      userId,
      teamId,
      this.page,
      duration,
      this.slightlySecretId.toString(),
      this._logger
    );
    await recordingTask.runAsync(null);

    this._logger.info('Waiting for recording duration:', config.maxRecordingDuration, 'minutes...');
    waitingPromise.promise.then(async () => {
      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();

      this._logger.info('All done ✨', { botId, eventId, userId, teamId });
    });
    await waitingPromise.promise;
  }
}

import { Frame, Locator, Page } from 'playwright';
import { JoinParams, AbstractMeetBot } from './AbstractMeetBot';
import { BotStatus, WaitPromise } from '../types';
import config from '../config';
import { MeetingEndedError, WaitingAtLobbyRetryError } from '../error';
import { v4 } from 'uuid';
import { patchBotStatus } from '../services/botService';
import { notifyMafStatus } from '../services/notificationService';
import { globalJobStore } from '../lib/globalJobStore';
import { RecordingTask } from '../tasks/RecordingTask';
import { ContextBridgeTask, ParticipantEvent } from '../tasks/ContextBridgeTask';
import { getWaitingPromise } from '../lib/promise';
import createBrowserContext from '../lib/chromium';
import { captureAndUploadDebugImage } from '../services/bugService';
import { Logger } from 'winston';
import { handleWaitingAtLobbyError } from './MeetBotBase';
import { ZOOM_REQUEST_DENIED } from '../constants';
import { setTaskProtection } from '../services/ecsTaskProtectionService';
import { sanitizeUrlForLogs } from '../util/logger';

type ZoomContainerMode = 'app' | 'iframe';

type ZoomContainerResult = {
  success: boolean;
  frame: Frame | Page | null;
  mode: ZoomContainerMode | null;
};

type ZoomJoinSnapshot = {
  joined: boolean;
  joinedBy: 'footer' | 'controls' | null;
  userDenied: boolean;
  endedByHost: boolean;
  waitingOnHost: boolean;
  participantCount: number | null;
  mode: ZoomContainerMode;
  source: 'primary' | 'alternate';
  pageUrl: string;
  rootUrl: string;
  pageBodyText: string;
  rootBodyText: string;
  footerText: string | null;
  dialogTexts: string[];
  buttonLabels: string[];
};

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
  async join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader, metadata }: JoinParams): Promise<void> {
    const _state: BotStatus[] = ['processing'];

    const handleUpload = async () => {
      this._logger.info('Begin recording upload to server', { userId, teamId });
      const uploadResult = await uploader.uploadRecordingToRemoteStorage();
      this._logger.info('Recording upload result', { uploadResult, userId, teamId });
    };

    try {
      await setTaskProtection(true);
      const pushState = (st: BotStatus) => _state.push(st);
      await this.joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, pushState, uploader, metadata });
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
    } finally {
      await setTaskProtection(false);
    }
  }

  private async joinMeeting({ pushState, ...params }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    const { url, name, metadata } = params;
    this._logger.info('Launching browser for Zoom...', { userId: params.userId });

    this.page = await createBrowserContext(url, this._correlationId, 'zoom');

    // Register cancel callback so the job can be force-killed
    const jobId = params.botId || `job-zoom-${Date.now()}`;
    globalJobStore.registerCancelCallback(jobId, async () => {
      this._logger.info('Cancel requested — closing browser', { botId: params.botId });
      await this.page.context().browser()?.close();
    });

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
        this._logger.info('FAST PATH: Navigating directly to Zoom Web Client...', {
          wcUrl: sanitizeUrlForLogs(wcUrl.toString()),
          botId: params.botId,
        });
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
        await captureAndUploadDebugImage({
          capture: () => this.page.screenshot({ type: 'png', fullPage: true }),
          fileName: 'page',
          userId: params.userId,
          logger: this._logger,
          botId: params.botId,
          opts: {
            meetingProvider: 'zoom',
            stage: 'fallback',
            reason: 'join-from-browser-missing',
            runId: this._correlationId,
          },
        });
        this._logger.info('FALLBACK: Could not find Join from browser, trying direct URL...');
        const wcUrl = new URL(url);
        wcUrl.pathname = wcUrl.pathname.replace('/j/', '/wc/join/');
        await this.page.goto(wcUrl.toString(), { waitUntil: 'networkidle' });
        usingDirectWebClient = true;
      }
    }

    this._logger.info('On the web client page', { usingDirectWebClient });

    const foundAppContainer = await this.detectAppContainer(usingDirectWebClient ? 'app' : 'iframe');
    if (!foundAppContainer.success || !foundAppContainer.frame || !foundAppContainer.mode) {
      throw new Error(`Failed to get the Zoom PWA iframe on user ${params.userId}`);
    }

    let iframe: Frame | Page = foundAppContainer.frame;
    const containerMode = foundAppContainer.mode;

    await this.dismissPreJoinMediaPrompts(iframe, containerMode);

    this._logger.info('Waiting for the input field to be visible...', { mode: containerMode });
    await iframe.waitForSelector('input[type="text"]', { timeout: 30000, state: 'visible' });
    await this.dismissPreJoinMediaPrompts(iframe, containerMode);

    await this.page.waitForTimeout(300);
    this._logger.info('Filling the input field with the name...');
    await iframe.fill('input[type="text"]', name ? name : 'ScreenApp Notetaker');

    await this.page.waitForTimeout(300);
    await this.dismissPreJoinMediaPrompts(iframe, containerMode);

    this._logger.info('Clicking the "Join" button...');
    await this.clickJoinButton(iframe, containerMode);

    // Wait in waiting room
    try {
      const wanderingTime = config.joinWaitTime * 60 * 1000; // Give some time to be let in

      let waitTimeout: NodeJS.Timeout;
      let waitInterval: NodeJS.Timeout;
      let bestSnapshot: ZoomJoinSnapshot | null = null;

      const waitAtLobbyPromise = new Promise<ZoomJoinSnapshot | null>((resolveMe) => {
        waitTimeout = setTimeout(() => {
          clearInterval(waitInterval);
          resolveMe(bestSnapshot);
        }, wanderingTime);

        waitInterval = setInterval(async () => {
          try {
            const snapshots = await this.captureJoinSnapshots(iframe, containerMode);

            for (const snapshot of snapshots) {
              if (this.isBetterSnapshot(snapshot, bestSnapshot)) {
                bestSnapshot = snapshot;
              }

              if (snapshot.joined) {
                if (snapshot.joinedBy === 'footer' && snapshot.participantCount !== null) {
                  this._logger.info('Final Number of participants while waiting...', {
                    0: String(snapshot.participantCount),
                    index: 0,
                    input: `${snapshot.participantCount}participants`,
                  });
                } else if (snapshot.joinedBy === 'controls') {
                  this._logger.info('Zoom joined-state detected via control fallback', {
                    mode: snapshot.mode,
                    source: snapshot.source,
                  });
                }

                clearInterval(waitInterval);
                clearTimeout(waitTimeout);
                resolveMe(snapshot);
                return;
              }

              if (snapshot.endedByHost || snapshot.userDenied) {
                clearInterval(waitInterval);
                clearTimeout(waitTimeout);
                resolveMe(snapshot);
                return;
              }

              if (snapshot.waitingOnHost) {
                this._logger.info('Waiting on host...', {
                  mode: snapshot.mode,
                  source: snapshot.source,
                });
                break;
              }
            }
          } catch {
            // Ignore intermittent UI state errors and keep polling
          }
        }, 2000);
      });

      const joinSnapshot = await waitAtLobbyPromise;
      if (!joinSnapshot || !joinSnapshot.joined) {
        const diagnostics = joinSnapshot
          ? this.toJoinDiagnostics(joinSnapshot)
          : {
            waitingAtLobbySuccess: false,
            mode: containerMode,
            pageUrl: sanitizeUrlForLogs(this.page.url()),
          };

        const bodyText = joinSnapshot ? this.getDiagnosticBodyText(joinSnapshot) : await this.page.evaluate(() => document.body.innerText);
        const userDenied = joinSnapshot?.userDenied ?? (bodyText || '')?.includes(ZOOM_REQUEST_DENIED);
        const artifactReason = joinSnapshot?.endedByHost
          ? 'meeting-ended'
          : userDenied
            ? 'user-denied'
            : joinSnapshot?.waitingOnHost
              ? 'waiting-on-host-timeout'
              : 'join-timeout';

        if (config.debugArtifactsEnabled) {
          await captureAndUploadDebugImage({
            capture: () => this.page.screenshot({ type: 'png', fullPage: true }),
            fileName: 'page',
            userId: params.userId,
            logger: this._logger,
            botId: params.botId,
            opts: {
              meetingProvider: 'zoom',
              stage: 'join-failure',
              reason: artifactReason,
              runId: this._correlationId,
            },
          });
        }

        this._logger.error('Cant finish wait at the lobby check', {
          userDenied,
          waitingAtLobbySuccess: false,
          ...diagnostics,
        });

        if (joinSnapshot?.endedByHost) {
          throw new MeetingEndedError(
            'Zoom meeting ended before recording could start.',
            bodyText ?? '',
            false,
            0
          );
        }

        throw new WaitingAtLobbyRetryError('Zoom bot could not enter the meeting...', bodyText ?? '', false, 0);
      }

      this._logger.info('Bot is entering the meeting after wait room...', {
        mode: joinSnapshot.mode,
        joinedBy: joinSnapshot.joinedBy,
        source: joinSnapshot.source,
      });
    } catch (error) {
      this._logger.info('Closing the browser on error...', error);
      await this.page.context().browser()?.close();

      throw error;
    }

    await this.dismissDeviceNotifications(iframe);

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
    await setTaskProtection(true);
    if (metadata?.meeting_id && metadata?.tenantId) {
      notifyMafStatus(metadata.meeting_id, metadata.tenantId, 'joining', this._logger);
    }

    this._logger.info('Begin recording...');
    if (metadata?.meeting_id && metadata?.tenantId) {
      notifyMafStatus(metadata.meeting_id, metadata.tenantId, 'recording', this._logger);
    }
    await this.recordMeetingPage({ ...params });

    pushState('finished');
  }

  private async clickJoinButton(root: Frame | Page, mode: ZoomContainerMode): Promise<void> {
    const joinButton = root.locator('button', { hasText: /^Join$/i }).first();
    await joinButton.waitFor({ timeout: 30000, state: 'visible' });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await joinButton.click({ timeout: 5000 });
        return;
      } catch (error) {
        if (attempt === 2) {
          throw error;
        }
        await this.dismissPreJoinMediaPrompts(root, mode);
        await this.page.waitForTimeout(350);
      }
    }
  }

  private async captureJoinSnapshots(primaryRoot: Frame | Page, primaryMode: ZoomContainerMode): Promise<ZoomJoinSnapshot[]> {
    const snapshots: ZoomJoinSnapshot[] = [
      await this.captureJoinSnapshot(primaryRoot, primaryMode, 'primary'),
    ];

    if (primaryMode === 'app') {
      const iframeHandle = await this.page.$('iframe#webclient');
      const iframe = await iframeHandle?.contentFrame();
      if (iframe) {
        snapshots.push(await this.captureJoinSnapshot(iframe, 'iframe', 'alternate'));
      }
    } else if (primaryRoot !== this.page) {
      snapshots.push(await this.captureJoinSnapshot(this.page, 'app', 'alternate'));
    }

    return snapshots;
  }

  private async captureJoinSnapshot(
    root: Frame | Page,
    mode: ZoomContainerMode,
    source: 'primary' | 'alternate'
  ): Promise<ZoomJoinSnapshot> {
    const rootSnapshot = await this.captureDocumentSnapshot(root);
    const pageSnapshot = root === this.page ? rootSnapshot : await this.captureDocumentSnapshot(this.page);
    const combinedBodyText = `${pageSnapshot.bodyText}\n${rootSnapshot.bodyText}`;
    const participantCount = this.getParticipantCountFromFooter(rootSnapshot.footerText);
    const userDenied = combinedBodyText.includes(ZOOM_REQUEST_DENIED);
    const endedByHost =
      combinedBodyText.includes('This meeting has been ended by host') ||
      combinedBodyText.includes('Meeting is end now');
    const buttonLabels = rootSnapshot.buttonLabels;
    const leaveVisible = buttonLabels.some(label => /^leave$/i.test(label));
    const participantControlVisible = buttonLabels.some(label => /participants/i.test(label));
    const chatControlVisible = buttonLabels.some(label => /^chat$/i.test(label));
    const audioControlVisible = buttonLabels.some(label => /^audio$/i.test(label));
    const videoControlVisible = buttonLabels.some(label => /^video$/i.test(label));
    const joinedByFooter = participantCount !== null && participantCount > 0;
    const joinedByControls =
      leaveVisible &&
      (participantControlVisible || chatControlVisible || audioControlVisible || videoControlVisible);
    const waitingOnHost =
      participantCount === 0 ||
      combinedBodyText.includes('Please wait for the host to start this meeting');

    return {
      joined: !endedByHost && !userDenied && (joinedByFooter || joinedByControls),
      joinedBy: joinedByFooter ? 'footer' : joinedByControls ? 'controls' : null,
      userDenied,
      endedByHost,
      waitingOnHost,
      participantCount,
      mode,
      source,
      pageUrl: sanitizeUrlForLogs(this.page.url()) ?? this.page.url(),
      rootUrl: sanitizeUrlForLogs(root.url()) ?? root.url(),
      pageBodyText: pageSnapshot.bodyText,
      rootBodyText: rootSnapshot.bodyText,
      footerText: rootSnapshot.footerText,
      dialogTexts: rootSnapshot.dialogTexts,
      buttonLabels,
    };
  }

  private async captureDocumentSnapshot(root: Frame | Page): Promise<{
    bodyText: string;
    footerText: string | null;
    dialogTexts: string[];
    buttonLabels: string[];
  }> {
    try {
      return await root.evaluate(() => {
        const normalizeText = (value: string | null | undefined): string =>
          value ? value.replace(/\s+/g, ' ').trim() : '';

        const buttonLabels = Array.from(document.querySelectorAll('button,[role="button"]'))
          .map((el) => {
            const node = el as HTMLElement;
            return normalizeText(node.innerText || node.getAttribute('aria-label'));
          })
          .filter(Boolean);

        const dialogTexts = Array.from(document.querySelectorAll('[role="dialog"],dialog'))
          .map((el) => normalizeText((el as HTMLElement).innerText))
          .filter(Boolean)
          .slice(0, 10);

        return {
          bodyText: document.body?.innerText?.slice(0, 4000) ?? '',
          footerText: (document.querySelector('#wc-footer') as HTMLElement | null)?.innerText ?? null,
          dialogTexts,
          buttonLabels: Array.from(new Set(buttonLabels)).slice(0, 40),
        };
      });
    } catch {
      return {
        bodyText: '',
        footerText: null,
        dialogTexts: [],
        buttonLabels: [],
      };
    }
  }

  private getParticipantCountFromFooter(footerText: string | null): number | null {
    if (!footerText) {
      return null;
    }

    const tokens1 = footerText.split('\n');
    const tokens2 = footerText.split(' ');
    const tokens = tokens1.length > tokens2.length ? tokens1 : tokens2;

    const filtered: string[] = [];
    for (const tok of tokens) {
      if (!tok) continue;
      if (!Number.isNaN(Number(tok.trim()))) {
        filtered.push(tok);
      } else if (tok.trim().toLowerCase() === 'participants') {
        filtered.push(tok.trim().toLowerCase());
        break;
      }
    }

    const joinedText = filtered.join('');
    if (joinedText === 'participants') {
      return null;
    }

    const isValid = joinedText.match(/\d+(.*)participants/i);
    if (!isValid) {
      return null;
    }

    const num = joinedText.match(/\d+/);
    return num ? Number(num[0]) : null;
  }

  private isBetterSnapshot(candidate: ZoomJoinSnapshot, current: ZoomJoinSnapshot | null): boolean {
    if (!current) {
      return true;
    }

    if (candidate.joined && !current.joined) {
      return true;
    }

    if (candidate.endedByHost && !current.endedByHost) {
      return true;
    }

    if (candidate.userDenied && !current.userDenied) {
      return true;
    }

    if (candidate.footerText && !current.footerText) {
      return true;
    }

    return candidate.rootBodyText.length > current.rootBodyText.length;
  }

  private getDiagnosticBodyText(snapshot: ZoomJoinSnapshot): string {
    return snapshot.rootBodyText.length >= snapshot.pageBodyText.length
      ? snapshot.rootBodyText
      : snapshot.pageBodyText;
  }

  private toJoinDiagnostics(snapshot: ZoomJoinSnapshot) {
    return {
      mode: snapshot.mode,
      source: snapshot.source,
      joinedBy: snapshot.joinedBy,
      participantCount: snapshot.participantCount,
      waitingOnHost: snapshot.waitingOnHost,
      pageUrl: snapshot.pageUrl,
      rootUrl: snapshot.rootUrl,
      footerText: snapshot.footerText,
      pageBodyText: snapshot.pageBodyText,
      rootBodyText: snapshot.rootBodyText,
      dialogTexts: snapshot.dialogTexts,
      buttonLabels: snapshot.buttonLabels,
    };
  }

  private async dismissPreJoinMediaPrompts(root: Frame | Page, mode: ZoomContainerMode): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const clickedContinue = await this.clickIfVisible(
        root.getByRole('button', { name: /Continue without microphone and camera/i }).first(),
        'Dismissed Zoom pre-join media prompt',
        { mode, attempt: attempt + 1 }
      );

      if (!clickedContinue) {
        break;
      }

      await this.page.waitForTimeout(350);
    }
  }

  private async clickIfVisible(locator: Locator, message: string, meta: Record<string, unknown>): Promise<boolean> {
    try {
      if ((await locator.count()) === 0 || !(await locator.isVisible())) {
        return false;
      }

      await locator.click({ timeout: 3000 });
      this._logger.info(message, meta);
      return true;
    } catch {
      return false;
    }
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
  private async detectAppContainer(startWith: 'app' | 'iframe'): Promise<ZoomContainerResult> {
    const tried: Set<string> = new Set();

    const detect = async (mode: ZoomContainerMode): Promise<ZoomContainerResult> => {
      if (tried.has(mode)) {
        return { success: false, frame: null, mode: null };
      }
      tried.add(mode);

      try {
        if (mode === 'app') {
          const input = await this.page.waitForSelector('input[type="text"]', { timeout: 15000 });
          const join = this.page.locator('button', { hasText: /Join/i });
          await join.waitFor({ timeout: 10000 });
          this._logger.info('App container detected', { input: input !== null });
          if (input) {
            return { success: true, frame: this.page, mode };
          }
          return await detect('iframe');
        }

        const iframeHandle = await this.page.waitForSelector('iframe#webclient', { timeout: 15000, state: 'attached' });
        this._logger.info('Iframe container detected');
        const contentFrame = await iframeHandle.contentFrame();
        if (contentFrame) {
          return { success: true, frame: contentFrame, mode };
        }
        return await detect('app');
      } catch (err) {
        this._logger.info('Cannot detect app container', { mode, error: err?.message });
        const other = mode === 'app' ? 'iframe' : 'app';
        return await detect(other);
      }
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
    const { teamId, userId, eventId, botId, uploader, metadata } = params;
    const duration = config.maxRecordingDuration * 60 * 1000;

    // Track participant presence events for speaker diarization
    const participantEvents: ParticipantEvent[] = [];

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
      this._logger,
      participantEvents,
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

    // Attach participant events to metadata for webhook payload
    if (participantEvents.length > 0 && metadata) {
      metadata.participantEvents = participantEvents;
      // Also include a flat list of unique detected names for easy access
      const allNames = new Set<string>();
      participantEvents.forEach(e => e.names.forEach(n => allNames.add(n)));
      metadata.detectedParticipants = Array.from(allNames);
      this._logger.info('Participant detection summary', {
        eventCount: participantEvents.length,
        detectedParticipants: metadata.detectedParticipants,
      });
    }
  }
}

import { JoinParams } from './AbstractMeetBot';
import { BotStatus, WaitPromise } from '../types';
import config from '../config';
import { MeetingEndedError, UnsupportedMeetingError, WaitingAtLobbyRetryError } from '../error';
import { patchBotStatus } from '../services/botService';
import { handleUnsupportedMeetingError, handleWaitingAtLobbyError, MeetBotBase } from './MeetBotBase';
import { v4 } from 'uuid';
import { IUploader } from '../middleware/disk-uploader';
import { Logger } from 'winston';
import { browserLogCaptureCallback, sanitizeUrlForLogs } from '../util/logger';
import { getWaitingPromise } from '../lib/promise';
import { retryActionWithWait } from '../util/resilience';
import { captureAndUploadDebugImage } from '../services/bugService';
import createBrowserContext from '../lib/chromium';
import { GOOGLE_LOBBY_MODE_HOST_TEXT, GOOGLE_REQUEST_DENIED, GOOGLE_REQUEST_TIMEOUT } from '../constants';
import { vp9MimeType, webmMimeType } from '../lib/recording';
import { notifyMafStatus } from '../services/notificationService';
import { globalJobStore } from '../lib/globalJobStore';
import { setTaskProtection } from '../services/ecsTaskProtectionService';

type GoogleMeetJoinSnapshot = {
  joined: boolean;
  joinedBy: 'people_count' | 'leave_call' | 'body_text' | null;
  waitingOnHost: boolean;
  requestTimedOut: boolean;
  userDenied: boolean;
  ended: boolean;
  participantCount: number | null;
  pageUrl: string;
  bodyText: string;
  dialogTexts: string[];
  buttonLabels: string[];
};

export class GoogleMeetBot extends MeetBotBase {
  private _logger: Logger;
  private _correlationId: string;
  constructor(logger: Logger, correlationId: string) {
    super();
    this.slightlySecretId = v4();
    this._logger = logger;
    this._correlationId = correlationId;
  }

  async join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader, metadata }: JoinParams): Promise<void> {
    const _state: BotStatus[] = ['processing'];

    const handleUpload = async () => {
      this._logger.info('Begin recording upload to server', { userId, teamId });
      const uploadResult = await uploader.uploadRecordingToRemoteStorage();
      this._logger.info('Recording upload result', { uploadResult, userId, teamId });
      return uploadResult;
    };

    try {
      const pushState = (st: BotStatus) => _state.push(st);
      await this.joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader, metadata, pushState });

      // Finish the upload from the temp video
      const uploadResult = await handleUpload();

      if (_state.includes('finished') && !uploadResult) {
        _state.splice(_state.indexOf('finished'), 1, 'failed');
      }

      await patchBotStatus({ botId, eventId, provider: 'google', status: _state, token: bearerToken }, this._logger);
    } catch(error) {
      if (!_state.includes('finished')) 
        _state.push('failed');

      await patchBotStatus({ botId, eventId, provider: 'google', status: _state, token: bearerToken }, this._logger);
      
      if (error instanceof WaitingAtLobbyRetryError) {
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'google', error }, this._logger);
      }

      if (error instanceof UnsupportedMeetingError) {
        await handleUnsupportedMeetingError({ token: bearerToken, botId, eventId, provider: 'google', error }, this._logger);
      }

      throw error;
    } finally {
      await setTaskProtection(false);
    }
  }

  private async joinMeeting({ url, name, teamId, userId, eventId, botId, pushState, uploader, metadata }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    this._logger.info('Launching browser...');

    this.page = await createBrowserContext(url, this._correlationId, 'google');

    // Register cancel callback so the job can be force-killed
    const jobId = botId || `job-google-${Date.now()}`;
    globalJobStore.registerCancelCallback(jobId, async () => {
      this._logger.info('Cancel requested — closing browser', { botId });
      await this.page.context().browser()?.close();
    });

    this._logger.info('Navigating to Google Meet URL...');
    await this.page.goto(url, { waitUntil: 'networkidle' });

    this._logger.info('Waiting for 1 second...');
    await this.page.waitForTimeout(1000);

    const dismissDeviceCheck = async () => {
      try {
        this._logger.info('Clicking Continue without microphone and camera button...');
        await retryActionWithWait(
          'Clicking the "Continue without microphone and camera" button',
          async () => {
            await this.page.getByRole('button', { name: 'Continue without microphone and camera' }).waitFor({ timeout: 1000 });
            await this.page.getByRole('button', { name: 'Continue without microphone and camera' }).click();
          },
          this._logger,
          1,
          2000,
        );
      } catch (dismissError) {
        this._logger.info('Continue without microphone and camera button is probably missing!...');
      }
    };

    await dismissDeviceCheck();

    const verifyItIsOnGoogleMeetPage = async (): Promise<'SIGN_IN_PAGE' | 'GOOGLE_MEET_PAGE' | 'UNSUPPORTED_PAGE' | null> => {
      try {
        const detectSignInPage = async () => {
          let result = false;
          const url = await this.page.url();
          if (url.startsWith('https://accounts.google.com/')) {
            this._logger.info('Google Meet bot is on the sign in page...', { userId, teamId });
            result = true;
          }
          const signInPage = await this.page.locator('h1', { hasText: 'Sign in' });
          if (await signInPage.count() > 0 && await signInPage.isVisible()) {
            this._logger.info('Google Meet bot is on the page with "Sign in" heading...', { userId, teamId });
            result = result && true;
          }
          return result;
        };
        const pageUrl = await this.page.url();
        if (!pageUrl.includes('meet.google.com')) {
          const signInPage = await detectSignInPage();
          return signInPage ? 'SIGN_IN_PAGE' : 'UNSUPPORTED_PAGE';
        }
        return 'GOOGLE_MEET_PAGE';
      } catch(e) {
        this._logger.error('Error verifying if Google Meet bot is on the Google Meet page...', { error: e, message: e?.message });
        return null;
      }
    };

    const googleMeetPageStatus = await verifyItIsOnGoogleMeetPage();
    if (googleMeetPageStatus === 'SIGN_IN_PAGE') {
      this._logger.info('Exiting now as meeting requires sign in...', { googleMeetPageStatus, userId, teamId });
      throw new UnsupportedMeetingError('Meeting requires sign in', googleMeetPageStatus);
    }

    if (googleMeetPageStatus === 'UNSUPPORTED_PAGE') {
      this._logger.info('Google Meet bot is on the unsupported page...', { googleMeetPageStatus, userId, teamId });
    }

    this._logger.info('Waiting for the input field to be visible...');
    await retryActionWithWait(
      'Waiting for the input field',
      async () => await this.page.waitForSelector('input[type="text"][aria-label="Your name"]', { timeout: 10000 }),
      this._logger,
      3,
      15000,
      async () => {
        await captureAndUploadDebugImage({
          capture: () => this.page.screenshot({ type: 'png', fullPage: true }),
          fileName: 'page',
          userId,
          logger: this._logger,
          botId,
          opts: {
            meetingProvider: 'google',
            stage: 'prejoin',
            reason: 'input-wait',
            runId: this._correlationId,
          },
        });
      }
    );

    await this.page.waitForTimeout(500);

    this._logger.info('Filling the input field with the name...');
    await this.page.fill('input[type="text"][aria-label="Your name"]', name ? name : 'ScreenApp Notetaker');

    await this.page.waitForTimeout(500);
    
    await retryActionWithWait(
      'Clicking the "Ask to join" button',
      async () => {
        // Using the Order of most probable detection
        const possibleTexts = [
          'Ask to join',
          'Join now',
          'Join anyway',
        ];

        let buttonClicked = false;

        for (const text of possibleTexts) {
          try {
            const button = await this.page.locator('button', { hasText: new RegExp(text.toLocaleLowerCase(), 'i') }).first();
            if (await button.count() > 0) {
              await button.click({ timeout: 5000 });
              buttonClicked = true;
              this._logger.info(`Success clicked using "${text}" action...`);
              break;
            }
          } catch(err) {
            this._logger.warn(`Unable to click using "${text}" action...`);
          }
        }

        // Throws to initiate retries
        if (!buttonClicked) {
          throw new Error('Unable to complete the join action...');
        }
      },
      this._logger,
      3,
      15000,
      async () => {
        await captureAndUploadDebugImage({
          capture: () => this.page.screenshot({ type: 'png', fullPage: true }),
          fileName: 'page',
          userId,
          logger: this._logger,
          botId,
          opts: {
            meetingProvider: 'google',
            stage: 'prejoin',
            reason: 'join-action-failure',
            runId: this._correlationId,
          },
        });
      }
    );

    // Do this to ensure meeting bot has joined the meeting

    try {
      const wanderingTime = config.joinWaitTime * 60 * 1000; // Give some time to admit the bot

      let waitTimeout: NodeJS.Timeout;
      let waitInterval: NodeJS.Timeout;
      let bestSnapshot: GoogleMeetJoinSnapshot | null = null;

      const waitAtLobbyPromise = new Promise<GoogleMeetJoinSnapshot | null>((resolveWaiting) => {
        waitTimeout = setTimeout(() => {
          clearInterval(waitInterval);
          resolveWaiting(bestSnapshot);
        }, wanderingTime);

        waitInterval = setInterval(async () => {
          try {
            const snapshot = await this.captureJoinSnapshot();
            if (this.isBetterJoinSnapshot(snapshot, bestSnapshot)) {
              bestSnapshot = snapshot;
            }

            if (snapshot.joined) {
              this._logger.info('Google Meet Bot is entering the meeting...', {
                userId,
                teamId,
                joinedBy: snapshot.joinedBy,
                participantCount: snapshot.participantCount,
              });
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveWaiting(snapshot);
              return;
            }

            if (snapshot.requestTimedOut) {
              this._logger.info('Lobby Mode: Google Meet Bot join request timed out...', {
                userId,
                teamId,
                pageUrl: snapshot.pageUrl,
              });
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveWaiting(snapshot);
              return;
            }

            if (snapshot.userDenied) {
              this._logger.info('Google Meet Bot is denied access to the meeting...', {
                userId,
                teamId,
                pageUrl: snapshot.pageUrl,
              });
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveWaiting(snapshot);
              return;
            }

            if (snapshot.ended) {
              this._logger.info('Google Meet ended before the recording phase started...', {
                userId,
                teamId,
                pageUrl: snapshot.pageUrl,
              });
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveWaiting(snapshot);
              return;
            }

            if (snapshot.waitingOnHost) {
              this._logger.info('Lobby Mode: Google Meet Bot is waiting for the host to admit it...', {
                userId,
                teamId,
                pageUrl: snapshot.pageUrl,
              });
            }
          } catch(e) {
            this._logger.error(
              'wait error', { error: e }
            );
            // Do nothing
          }
        }, 2000);  // Check every 2 seconds (was 20s - too slow, missing start of recording)
      });

      const joinSnapshot = await waitAtLobbyPromise;
      if (!joinSnapshot?.joined) {
        const bodyText = joinSnapshot?.bodyText ?? await this.page.evaluate(() => document.body.innerText);
        const userDenied = joinSnapshot?.userDenied ?? (bodyText || '')?.includes(GOOGLE_REQUEST_DENIED);
        const artifactReason = joinSnapshot?.ended
          ? 'meeting-ended'
          : userDenied
            ? 'user-denied'
            : joinSnapshot?.requestTimedOut
              ? 'request-timed-out'
              : joinSnapshot?.waitingOnHost
                ? 'waiting-on-host-timeout'
                : 'join-timeout';

        if (config.debugArtifactsEnabled) {
          await captureAndUploadDebugImage({
            capture: () => this.page.screenshot({ type: 'png', fullPage: true }),
            fileName: 'page',
            userId,
            logger: this._logger,
            botId,
            opts: {
              meetingProvider: 'google',
              stage: 'join-failure',
              reason: artifactReason,
              runId: this._correlationId,
            },
          });
        }

        this._logger.error('Cant finish wait at the lobby check', {
          userDenied,
          waitingAtLobbySuccess: false,
          ...(joinSnapshot ? this.toJoinDiagnostics(joinSnapshot) : { pageUrl: sanitizeUrlForLogs(this.page.url()) }),
          bodyText,
        });

        if (joinSnapshot?.ended) {
          throw new MeetingEndedError(
            'Google Meet ended before recording could start.',
            bodyText ?? '',
            false,
            0
          );
        }

        throw new WaitingAtLobbyRetryError('Google Meet bot could not enter the meeting...', bodyText ?? '', false, 0);
      }
    } catch(lobbyError) {
      this._logger.info('Closing the browser on error...', lobbyError);
      await this.page.context().browser()?.close();

      throw lobbyError;
    }

    pushState('joined');
    await setTaskProtection(true);
    if (metadata?.meeting_id && metadata?.tenantId) {
      notifyMafStatus(metadata.meeting_id, metadata.tenantId, 'joining', this._logger);
    }

    try {
      this._logger.info('Waiting for the "Got it" button...');
      await this.page.waitForSelector('button:has-text("Got it")', { timeout: 1000 });

      this._logger.info('Going to click all visible "Got it" buttons...');

      let gotItButtonsClicked = 0;
      let previousButtonCount = -1;
      let consecutiveNoChangeCount = 0;
      const maxConsecutiveNoChange = 2; // Stop if button count doesn't change for 2 consecutive iterations

      while (true) {
        const visibleButtons = await this.page.locator('button:visible', {
          hasText: 'Got it',
        }).all();
      
        const currentButtonCount = visibleButtons.length;
        
        if (currentButtonCount === 0) {
          break;
        }
        
        // Check if button count hasn't changed (indicating we might be stuck)
        if (currentButtonCount === previousButtonCount) {
          consecutiveNoChangeCount++;
          if (consecutiveNoChangeCount >= maxConsecutiveNoChange) {
            this._logger.warn(`Button count hasn't changed for ${maxConsecutiveNoChange} iterations, stopping`);
            break;
          }
        } else {
          consecutiveNoChangeCount = 0;
        }
        
        previousButtonCount = currentButtonCount;

        for (const btn of visibleButtons) {
          try {
            await btn.click({ timeout: 5000 });
            gotItButtonsClicked++;
            this._logger.info(`Clicked a "Got it" button #${gotItButtonsClicked}`);
            
            await this.page.waitForTimeout(2000);
          } catch (err) {
            this._logger.warn('Click failed, possibly already dismissed', { error: err });
          }
        }
      
        await this.page.waitForTimeout(2000);
      }
    } catch (error) {
      // Log and ignore this error
      this._logger.info('"Got it" modals might be missing...', { error });
    }

    // Dismiss "Microphone not found" and "Camera not found" notifications if present
    try {
      this._logger.info('Checking for device notifications (microphone/camera)...');
      const hasDeviceNotification = await this.page.evaluate(() => {
        return document.body.innerText.includes('Microphone not found') ||
               document.body.innerText.includes('Make sure your microphone is plugged in') ||
               document.body.innerText.includes('Camera not found') ||
               document.body.innerText.includes('Make sure your camera is plugged in');
      });

      if (hasDeviceNotification) {
        this._logger.info('Found device notification (microphone/camera), attempting to dismiss...');
        // Try to find and click all close buttons
        const closeButtonsCount = await this.page.evaluate(() => {
          const allButtons = Array.from(document.querySelectorAll('button'));
          const closeButtons = allButtons.filter((btn) => {
            const ariaLabel = btn.getAttribute('aria-label');
            const hasCloseIcon = btn.querySelector('svg') !== null;
            return (ariaLabel?.toLowerCase().includes('close') ||
                    ariaLabel?.toLowerCase().includes('dismiss') ||
                    (hasCloseIcon && btn?.offsetParent !== null && btn.innerText === ''));
          });

          let clickedCount = 0;
          closeButtons.forEach((btn) => {
            if (btn?.offsetParent !== null) {
              btn.click();
              clickedCount++;
            }
          });
          return clickedCount;
        });

        if (closeButtonsCount > 0) {
          this._logger.info(`Successfully dismissed ${closeButtonsCount} device notification(s)`);
          await this.page.waitForTimeout(1000);
        } else {
          this._logger.warn('Could not find close button for device notifications');
        }
      }
    } catch (error) {
      this._logger.info('Error checking/dismissing device notifications...', { error });
    }

    // Recording the meeting page
    this._logger.info('Begin recording...');
    if (metadata?.meeting_id && metadata?.tenantId) {
      notifyMafStatus(metadata.meeting_id, metadata.tenantId, 'recording', this._logger);
    }
    await this.recordMeetingPage({ teamId, eventId, userId, botId, uploader });

    pushState('finished');
  }

  private async captureJoinSnapshot(): Promise<GoogleMeetJoinSnapshot> {
    const snapshot = await this.page.evaluate(({
      lobbyText,
      requestTimedOutText,
    }: {
      lobbyText: string;
      requestTimedOutText: string;
    }) => {
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

      const bodyText = document.body?.innerText?.slice(0, 4000) ?? '';
      const peopleLabels = Array.from(document.querySelectorAll('button[aria-label^="People"],button[aria-label*="People"]'))
        .map((el) => normalizeText(el.getAttribute('aria-label') || (el as HTMLElement).innerText))
        .filter(Boolean);

      let participantCount: number | null = null;
      for (const label of peopleLabels) {
        const match = label.match(/People.*?(\d+)/i);
        if (match) {
          participantCount = parseInt(match[1], 10);
          break;
        }
      }

      const leaveCallVisible = document.querySelector('button[aria-label="Leave call"]') !== null;
      const waitingOnHost =
        bodyText.includes(lobbyText) ||
        bodyText.includes('Asking to join');
      const requestTimedOut = bodyText.includes(requestTimedOutText);

      return {
        bodyText,
        dialogTexts,
        buttonLabels: Array.from(new Set(buttonLabels)).slice(0, 40),
        participantCount,
        leaveCallVisible,
        waitingOnHost,
        requestTimedOut,
      };
    }, {
      lobbyText: GOOGLE_LOBBY_MODE_HOST_TEXT,
      requestTimedOutText: GOOGLE_REQUEST_TIMEOUT,
    });

    const bodyText = snapshot.bodyText;
    const endedIndicators = [
      'The meeting has ended',
      'You left the meeting',
      'This meeting has ended',
      'Meeting ended',
      'Return to home screen',
      'The video call ended',
      'Call ended',
      'You\'ve been removed from the meeting',
    ];
    const ended = endedIndicators.some(indicator => bodyText.includes(indicator));
    const userDenied = bodyText.includes(GOOGLE_REQUEST_DENIED);
    const joinedByPeopleCount = snapshot.participantCount !== null && snapshot.participantCount >= 1;
    const joinedByBodyText =
      bodyText.includes('You have joined the call') ||
      bodyText.includes('other person in the call') ||
      bodyText.includes('people in the call');
    const joinedByLeaveCall =
      snapshot.leaveCallVisible &&
      !snapshot.waitingOnHost &&
      !bodyText.includes('You\'re the only one here');
    const joined = !ended && !userDenied && !snapshot.requestTimedOut && (
      joinedByPeopleCount ||
      joinedByBodyText ||
      joinedByLeaveCall
    );

    return {
      joined,
      joinedBy: joinedByPeopleCount ? 'people_count' : joinedByBodyText ? 'body_text' : joinedByLeaveCall ? 'leave_call' : null,
      waitingOnHost: snapshot.waitingOnHost,
      requestTimedOut: snapshot.requestTimedOut,
      userDenied,
      ended,
      participantCount: snapshot.participantCount,
      pageUrl: sanitizeUrlForLogs(this.page.url()) ?? this.page.url(),
      bodyText,
      dialogTexts: snapshot.dialogTexts,
      buttonLabels: snapshot.buttonLabels,
    };
  }

  private isBetterJoinSnapshot(
    snapshot: GoogleMeetJoinSnapshot,
    current: GoogleMeetJoinSnapshot | null
  ): boolean {
    if (!current) {
      return true;
    }

    const score = (candidate: GoogleMeetJoinSnapshot): number => {
      let result = 0;
      if (candidate.joined) result += 100;
      if (candidate.ended) result += 90;
      if (candidate.userDenied) result += 80;
      if (candidate.requestTimedOut) result += 70;
      if (candidate.waitingOnHost) result += 10;
      if (candidate.participantCount !== null) result += 5;
      result += candidate.dialogTexts.length;
      result += Math.min(candidate.buttonLabels.length, 20);
      result += Math.min(candidate.bodyText.length, 4000) / 1000;
      return result;
    };

    return score(snapshot) >= score(current);
  }

  private toJoinDiagnostics(snapshot: GoogleMeetJoinSnapshot): Record<string, unknown> {
    return {
      pageUrl: snapshot.pageUrl,
      joinedBy: snapshot.joinedBy,
      waitingOnHost: snapshot.waitingOnHost,
      requestTimedOut: snapshot.requestTimedOut,
      ended: snapshot.ended,
      participantCount: snapshot.participantCount,
      dialogTexts: snapshot.dialogTexts,
      buttonLabels: snapshot.buttonLabels,
    };
  }

  private async recordMeetingPage(
    { teamId, userId, eventId, botId, uploader }: 
    { teamId: string, userId: string, eventId?: string, botId?: string, uploader: IUploader }
  ): Promise<void> {
    const duration = config.maxRecordingDuration * 60 * 1000;
    const inactivityLimit = config.inactivityLimit * 60 * 1000;

    // Capture and send the browser console logs to Node.js context
    this.page?.on('console', async msg => {
      try {
        await browserLogCaptureCallback(this._logger, msg);
      } catch(err) {
        this._logger.info('Playwright chrome logger: Failed to log browser messages...', err?.message);
      }
    });

    await this.page.exposeFunction('screenAppSendData', async (slightlySecretId: string, data: string) => {
      if (slightlySecretId !== this.slightlySecretId) return;

      const buffer = Buffer.from(data, 'base64');
      await uploader.saveDataToTempFile(buffer);
    });

    await this.page.exposeFunction('screenAppMeetEnd', (slightlySecretId: string) => {
      if (slightlySecretId !== this.slightlySecretId) return;
      try {
        this._logger.info('Attempt to end meeting early...');
        waitingPromise.resolveEarly();
      } catch (error) {
        console.error('Could not process meeting end event', error);
      }
    });

    // Inject the MediaRecorder code into the browser context using page.evaluate
    await this.page.evaluate(
      async ({ teamId, duration, inactivityLimit, userId, slightlySecretId, activateInactivityDetectionAfter, activateInactivityDetectionAfterMinutes, primaryMimeType, secondaryMimeType, recordAudioOnly }: 
      { teamId:string, userId: string, duration: number, inactivityLimit: number, slightlySecretId: string, activateInactivityDetectionAfter: string, activateInactivityDetectionAfterMinutes: number, primaryMimeType: string, secondaryMimeType: string, recordAudioOnly: boolean }) => {
        let timeoutId: NodeJS.Timeout;
        let inactivityParticipantDetectionTimeout: NodeJS.Timeout;
        let inactivitySilenceDetectionTimeout: NodeJS.Timeout;
        let isOnValidGoogleMeetPageInterval: NodeJS.Timeout;

        const sendChunkToServer = async (chunk: ArrayBuffer) => {
          function arrayBufferToBase64(buffer: ArrayBuffer) {
            let binary = '';
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
          }
          const base64 = arrayBufferToBase64(chunk);
          await (window as any).screenAppSendData(slightlySecretId, base64);
        };

        async function startRecording() {
          console.log('Will activate the inactivity detection after', activateInactivityDetectionAfter);

          // Check for the availability of the mediaDevices API
          if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            console.error('MediaDevices or getDisplayMedia not supported in this browser.');
            return;
          }
          
          const stream: MediaStream = await (navigator.mediaDevices as any).getDisplayMedia({
            video: true,
            audio: {
              autoGainControl: false,
              channels: 2,
              channelCount: 2,
              echoCancellation: false,
              noiseSuppression: false,
            },
            preferCurrentTab: true,
          });

          // Check if we actually got audio tracks
          const audioTracks = stream.getAudioTracks();
          const hasAudioTracks = audioTracks.length > 0;
          const videoTracks = stream.getVideoTracks();

          console.log(`Captured stream tracks - audio: ${audioTracks.length}, video: ${videoTracks.length}`);
          
          if (!hasAudioTracks) {
            console.warn('No audio tracks available for silence detection. Will rely only on presence detection.');
          }

          const audioOnlyPrimaryMimeType = 'audio/webm;codecs=opus';
          const audioOnlySecondaryMimeType = 'audio/webm';
          let recordingStream: MediaStream = stream;
          let selectedPrimaryMimeType = primaryMimeType;
          let selectedSecondaryMimeType = secondaryMimeType;
          let usingAudioOnly = false;

          if (recordAudioOnly) {
            if (!hasAudioTracks) {
              console.warn('RECORD_AUDIO_ONLY requested but no audio tracks were captured. Falling back to AV recording mode.');
            } else {
              recordingStream = new MediaStream(audioTracks);
              selectedPrimaryMimeType = audioOnlyPrimaryMimeType;
              selectedSecondaryMimeType = audioOnlySecondaryMimeType;
              usingAudioOnly = true;

              // Stop the video tracks to reduce render/encode pressure.
              videoTracks.forEach((track) => track.stop());
              console.log('Audio-only recording mode enabled; video tracks detached from recorder stream.');
            }
          } else {
            console.log('Audio+video recording mode enabled (RECORD_AUDIO_ONLY=false).');
          }

          const resolveRecorderOptions = (primary: string, fallback: string): MediaRecorderOptions => {
            if (MediaRecorder.isTypeSupported(primary)) {
              console.log(`Media Recorder will use ${primary} codecs...`);
              return { mimeType: primary };
            }
            if (MediaRecorder.isTypeSupported(fallback)) {
              console.warn(`Media Recorder did not find primary mime type codecs ${primary}, using fallback codecs ${fallback}`);
              return { mimeType: fallback };
            }
            console.warn(`Neither preferred mime type (${primary}) nor fallback (${fallback}) is explicitly supported. Letting browser choose defaults.`);
            return {};
          };

          let options: MediaRecorderOptions = {};
          options = resolveRecorderOptions(selectedPrimaryMimeType, selectedSecondaryMimeType);

          let mediaRecorder: MediaRecorder;
          try {
            mediaRecorder = new MediaRecorder(recordingStream, { ...options });
          } catch (error) {
            if (usingAudioOnly) {
              console.warn('Audio-only MediaRecorder initialization failed; falling back to AV recorder stream.', error);
              recordingStream = stream;
              selectedPrimaryMimeType = primaryMimeType;
              selectedSecondaryMimeType = secondaryMimeType;
              options = resolveRecorderOptions(selectedPrimaryMimeType, selectedSecondaryMimeType);
              mediaRecorder = new MediaRecorder(recordingStream, { ...options });
              usingAudioOnly = false;
            } else {
              throw error;
            }
          }
          console.log(`Recorder mode active: ${usingAudioOnly ? 'audio-only' : 'audio+video'}`);

          let chunkCount = 0;
          let totalBytesReceived = 0;
          mediaRecorder.ondataavailable = async (event: BlobEvent) => {
            if (!event.data.size) {
              console.warn('Received empty chunk...');
              return;
            }
            chunkCount++;
            totalBytesReceived += event.data.size;
            console.log(`Chunk #${chunkCount}: ${event.data.size} bytes (total: ${totalBytesReceived} bytes)`);
            try {
              const arrayBuffer = await event.data.arrayBuffer();
              sendChunkToServer(arrayBuffer);
            } catch (error) {
              console.error('Error uploading chunk:', error);
            }
          };

          // Start recording with 2-second intervals
          const chunkDuration = 2000;
          mediaRecorder.start(chunkDuration);

          let dismissModalsInterval: NodeJS.Timeout;
          let lastDimissError: Error | null = null;

          const stopTheRecording = async () => {
            console.log(`=== RECORDING STOPPED ===`);
            console.log(`Total chunks received: ${chunkCount}`);
            console.log(`Total bytes received: ${totalBytesReceived}`);
            console.log(`Capture stream tracks - audio: ${stream.getAudioTracks().length}, video: ${stream.getVideoTracks().length}`);
            console.log(`Recorder stream tracks - audio: ${recordingStream.getAudioTracks().length}, video: ${recordingStream.getVideoTracks().length}`);
            mediaRecorder.stop();
            const tracksToStop = new Map<string, MediaStreamTrack>();
            stream.getTracks().forEach((track) => tracksToStop.set(track.id, track));
            recordingStream.getTracks().forEach((track) => tracksToStop.set(track.id, track));
            tracksToStop.forEach((track) => track.stop());

            // Cleanup recording timer
            clearTimeout(timeoutId);

            // Cancel the perpetural checks
            if (inactivityParticipantDetectionTimeout) {
              clearTimeout(inactivityParticipantDetectionTimeout);
            }
            if (inactivitySilenceDetectionTimeout) {
              clearTimeout(inactivitySilenceDetectionTimeout);
            }

            if (loneTest) {
              clearTimeout(loneTest);
            }

            if (isOnValidGoogleMeetPageInterval) {
              clearInterval(isOnValidGoogleMeetPageInterval);
            }

            if (dismissModalsInterval) {
              clearInterval(dismissModalsInterval);
              if (lastDimissError && lastDimissError instanceof Error) {
                console.error('Error dismissing modals:', { lastDimissError, message: lastDimissError?.message });
              }
            }

            // Begin browser cleanup
            (window as any).screenAppMeetEnd(slightlySecretId);
          };

          let loneTest: NodeJS.Timeout;
          let detectionFailures = 0;
          let loneTestDetectionActive = true;
          const maxDetectionFailures = 10; // Track up to 10 consecutive failures
          let lastBadgeLogTime = 0; // Track last time we logged badge count

          function detectLoneParticipantResilient(): void {
            const re = /^[0-9]+$/;

            function getContributorsCount(): number | undefined {
              function findPeopleButton() {
                try {
                  // 1. Try to locate using attribute "starts with"
                  let btn: Element | null | undefined = document.querySelector('button[aria-label^="People -"]');
                  if (btn) return btn;

                  // 2. Try to locate using attribute "contains"
                  btn = document.querySelector('button[aria-label*="People"]');
                  if (btn) return btn;

                  // 3. Try via aria-labelledby pointing to element with "People" text
                  const allBtns = Array.from(document.querySelectorAll('button[aria-labelledby]'));
                  btn = allBtns.find(b => {
                    const labelledBy = b.getAttribute('aria-labelledby');
                    if (labelledBy) {
                      const labelElement = document.getElementById(labelledBy);
                      if (labelElement && labelElement.textContent?.trim() === 'People') {
                        return true;
                      }
                    }
                    return false;
                  });
                  if (btn) return btn;

                  // 4. Try via regex on aria-label (for more complex patterns)
                  const allBtnsWithLabel = Array.from(document.querySelectorAll('button[aria-label]'));
                  btn = allBtnsWithLabel.find(b => {
                    const label = b.getAttribute('aria-label');
                    return label && /^People - \d+ joined$/.test(label);
                  });
                  if (btn) return btn;

                  // 5. Fallback: Look for button with a child icon containing "people"
                  btn = allBtnsWithLabel.find(b =>
                    Array.from(b.querySelectorAll('i')).some(i =>
                      i.textContent && i.textContent.trim() === 'people'
                    )
                  );
                  if (btn) return btn;

                  // 6. Not found
                  return null;
                } catch (error) {
                  console.log('Error finding people button:', error);
                  return null;
                }
              }

              // Find participant count badge near People button (doesn't require opening panel)
              try {
                const peopleBtn = findPeopleButton();
                // console.log('[Detection] People button found:', !!peopleBtn);

                if (peopleBtn) {
                  // Search INSIDE the button (descendants) and nearby (parent container)
                  const searchRoots = [
                    peopleBtn, // Search inside button itself
                    peopleBtn.parentElement,
                    peopleBtn.parentElement?.parentElement
                  ].filter(Boolean);

                  // console.log('[Detection] Searching', searchRoots.length, 'containers');

                  for (const searchRoot of searchRoots) {
                    if (!searchRoot) continue;

                    // Method 1: Look for data-avatar-count attribute (most reliable)
                    const avatarSpan = searchRoot.querySelector('[data-avatar-count]');
                    if (avatarSpan) {
                      const countAttr = avatarSpan.getAttribute('data-avatar-count');
                      // console.log('[Detection] Method 1 SUCCESS - data-avatar-count:', countAttr);
                      const count = Number(countAttr);
                      if (!isNaN(count) && count > 0) {
                        return count;
                      }
                    }

                    // Method 2: Fallback - Look for number in badge div
                    const badgeDiv = searchRoot.querySelector('div.egzc7c') as HTMLElement;
                    if (badgeDiv) {
                      const text = ((badgeDiv.innerText || badgeDiv.textContent) ?? '').trim();
                      if (text.length > 0 && text.length <= 3 && re.test(text)) {
                        const count = Number(text);
                        if (!isNaN(count) && count > 0) {
                          // console.log('[Detection] Method 2 SUCCESS - Badge text:', text);
                          return count;
                        }
                      }
                    }
                  }

                  // Method 3: Last resort - search for short numbers in People button area
                  const mainSearchRoot = peopleBtn.parentElement?.parentElement || peopleBtn;
                  const allDivs = Array.from(mainSearchRoot.querySelectorAll('div'));
                  for (const div of allDivs) {
                    const text = ((div as HTMLElement).innerText || div.textContent || '').trim();
                    if (text.length > 0 && text.length <= 3 && re.test(text)) {
                      const isVisible = (div as HTMLElement).offsetParent !== null;
                      if (isVisible) {
                        const count = Number(text);
                        if (!isNaN(count) && count > 0) {
                          // console.log('[Detection] Method 3 SUCCESS - Found number:', count);
                          return count;
                        }
                      }
                    }
                  }
                  // console.log('[Detection] All methods failed to find count');
                } else {
                  // console.log('[Detection] People button NOT found');
                }
              } catch (error) {
                console.log('Error finding participant badge:', error);
              }

              return undefined;
            }
          
            function retryWithBackoff(): void {
              loneTest = setTimeout(function check() {
                if (!loneTestDetectionActive) {
                  if (loneTest) {
                    clearTimeout(loneTest);
                  }
                  return;
                }
                let contributors: number | undefined;
                try {
                  contributors = getContributorsCount();

                  // Log participant count once per minute
                  if (typeof contributors !== 'undefined') {
                    const now = Date.now();
                    if (now - lastBadgeLogTime > 60000) {
                      console.log('Participant detection check - Count:', contributors);
                      lastBadgeLogTime = now;
                    }
                  }

                  if (typeof contributors === 'undefined') {
                    detectionFailures++;
                    console.warn('Meet participant detection failed, retrying. Failure count:', detectionFailures);
                    // Log for debugging
                    if (detectionFailures >= maxDetectionFailures) {
                      console.log('Persistent detection failures:', { bodyText: `${document.body.innerText?.toString()}` });
                      loneTestDetectionActive = false;
                    }
                    retryWithBackoff();
                    return;
                  }
                  detectionFailures = 0;
                  if (contributors < 2) {
                    console.log('Bot is alone, ending meeting.');
                    loneTestDetectionActive = false;
                    stopTheRecording();
                    return;
                  }
                } catch (err) {
                  detectionFailures++;
                  console.error('Detection error:', err, detectionFailures);
                  retryWithBackoff();
                  return;
                }
                retryWithBackoff();
              }, 5000);
            }
          
            retryWithBackoff();
          }

          const detectIncrediblySilentMeeting = () => {
            // Only run silence detection if we have audio tracks
            if (!hasAudioTracks) {
              console.warn('Skipping silence detection - no audio tracks available. This may be due to browser permissions or Google Meet audio sharing settings.');
              console.warn('Meeting will rely on presence detection and max duration timeout.');
              return;
            }

            try {
              const audioContext = new AudioContext();
              const mediaSource = audioContext.createMediaStreamSource(stream);
              const analyser = audioContext.createAnalyser();

              /* Use a value suitable for the given use case of silence detection
                 |
                 |____ Relatively smaller FFT size for faster processing and less sampling
              */
              analyser.fftSize = 256;

              mediaSource.connect(analyser);

              const dataArray = new Uint8Array(analyser.frequencyBinCount);
              
              // Sliding silence period
              let silenceDuration = 0;
              let totalChecks = 0;
              let audioActivitySum = 0;
              let lastActivityLogTime = 0;

              // Audio gain/volume
              const silenceThreshold = 10;

              let monitor = true;

              const monitorSilence = () => {
                try {
                  analyser.getByteFrequencyData(dataArray);

                  const audioActivity = dataArray.reduce((a, b) => a + b) / dataArray.length;
                  audioActivitySum += audioActivity;
                  totalChecks++;

                  // Log silence detection status once per minute
                  const now = Date.now();
                  if (now - lastActivityLogTime > 60000) {
                    const avgActivity = (audioActivitySum / totalChecks).toFixed(2);
                    console.log('Silence detection check - Avg:', avgActivity, 'Current:', audioActivity.toFixed(2), 'Threshold:', silenceThreshold);
                    lastActivityLogTime = now;
                  }

                  if (audioActivity < silenceThreshold) {
                    silenceDuration += 100; // Check every 100ms
                    if (silenceDuration >= inactivityLimit) {
                        console.warn('Detected silence in Google Meet and ending the recording on team:', userId, teamId);
                        console.log('Silence detection stats - Avg audio activity:', (audioActivitySum / totalChecks).toFixed(2), 'Checks performed:', totalChecks);
                        monitor = false;
                        stopTheRecording();
                    }
                  } else {
                    silenceDuration = 0;
                  }

                  if (monitor) {
                    // Recursively queue the next check
                    setTimeout(monitorSilence, 100);
                  }
                } catch (error) {
                  console.error('Error in silence monitoring:', error);
                  console.warn('Silence detection failed - will rely on presence detection and max duration timeout.');
                  // Stop monitoring on error
                  monitor = false;
                }
              };

              // Go silence monitor
              monitorSilence();
            } catch (error) {
              console.error('Failed to initialize silence detection:', error);
              console.warn('Silence detection initialization failed - will rely on presence detection and max duration timeout.');
            }
          };

          /**
           * Perpetual checks for inactivity detection
           */
          inactivityParticipantDetectionTimeout = setTimeout(() => {
            detectLoneParticipantResilient();
          }, activateInactivityDetectionAfterMinutes * 60 * 1000);

          inactivitySilenceDetectionTimeout = setTimeout(() => {
            detectIncrediblySilentMeeting();
          }, activateInactivityDetectionAfterMinutes * 60 * 1000);

          const detectModalsAndDismiss = () => {
            let dismissModalErrorCount = 0;
            const maxDismissModalErrorCount = 10;
            dismissModalsInterval = setInterval(() => {
              try {
                const buttons = document.querySelectorAll('button');
                const dismissButtons = Array.from(buttons).filter((button) => button?.offsetParent !== null && button?.innerText?.includes('Got it'));
                if (dismissButtons.length > 0) {
                  console.log('Found "Got it" button, clicking it...', dismissButtons[0]);
                  dismissButtons[0].click();
                }

                // Dismiss "Microphone not found" and "Camera not found" notifications
                const bodyText = document.body.innerText;
                if (bodyText.includes('Microphone not found') ||
                    bodyText.includes('Make sure your microphone is plugged in') ||
                    bodyText.includes('Camera not found') ||
                    bodyText.includes('Make sure your camera is plugged in')) {
                  console.log('Found device notification (microphone/camera), attempting to dismiss...');
                  // Look for close button (X) near the notification
                  const allButtons = Array.from(document.querySelectorAll('button'));
                  const closeButtons = allButtons.filter((btn) => {
                    const ariaLabel = btn.getAttribute('aria-label');
                    const hasCloseIcon = btn.querySelector('svg') !== null;
                    // Look for close/dismiss buttons
                    return (ariaLabel?.toLowerCase().includes('close') ||
                            ariaLabel?.toLowerCase().includes('dismiss') ||
                            (hasCloseIcon && btn?.offsetParent !== null && btn.innerText === ''));
                  });

                  // Click all visible close buttons to dismiss all notifications
                  closeButtons.forEach((btn) => {
                    if (btn?.offsetParent !== null) {
                      console.log('Clicking close button for device notification...');
                      btn.click();
                    }
                  });
                }
              } catch(error) {
                lastDimissError = error;
                dismissModalErrorCount += 1;
                if (dismissModalErrorCount > maxDismissModalErrorCount) {
                  console.error(`Failed to detect and dismiss "Got it" modals ${maxDismissModalErrorCount} times, will stop trying...`);
                  clearInterval(dismissModalsInterval);
                }
              }
            }, 2000);
          };

          const detectMeetingIsOnAValidPage = () => {
            // Simple check to verify we're still on a supported Google Meet page
            let pageValidityFailures = 0;
            const maxPageValidityFailures = 6; // Allow 6 consecutive failures before stopping (60 seconds grace period)

            const isOnValidGoogleMeetPage = () => {
              try {
                // Check if we're still on a Google Meet URL
                const currentUrl = window.location.href;
                if (!currentUrl.includes('meet.google.com')) {
                  console.warn('No longer on Google Meet page - URL changed to:', currentUrl);
                  return 'FATAL'; // Immediate stop
                }

                const currentBodyText = document.body.innerText;
                if (currentBodyText.includes('You\'ve been removed from the meeting')) {
                  console.warn('Bot was removed from the meeting - ending recording on team:', userId, teamId);
                  return 'FATAL'; // Immediate stop
                }

                if (currentBodyText.includes('No one responded to your request to join the call')) {
                  console.warn('Bot was not admitted to the meeting - ending recording on team:', userId, teamId);
                  return 'FATAL'; // Immediate stop
                }

                // Detect meeting ended scenarios
                const meetingEndedIndicators = [
                  'The meeting has ended',
                  'You left the meeting',
                  'This meeting has ended',
                  'Meeting ended',
                  'Return to home screen',
                  'The video call ended',
                  'Call ended',
                ];
                for (const indicator of meetingEndedIndicators) {
                  if (currentBodyText.includes(indicator)) {
                    console.warn('Meeting ended detected:', indicator, '- ending recording on team:', userId, teamId);
                    return 'FATAL'; // Immediate stop
                  }
                }

                // Check for basic Google Meet UI elements (multiple fallback selectors)
                // Google Meet frequently changes aria-labels, so check multiple indicators
                const meetIndicators = [
                  // Primary buttons
                  'button[aria-label="People"]',
                  'button[aria-label="Leave call"]',
                  // Alternative labels
                  'button[aria-label="Show everyone"]',
                  'button[aria-label="Participants"]',
                  'button[aria-label="End call"]',
                  'button[aria-label="Hang up"]',
                  // Fallback: check for meeting-specific containers/elements
                  '[data-allocation-index]', // Meet participant container
                  '[data-self-name]', // Self participant indicator
                  '[data-tooltip="Leave call"]',
                  '[data-tooltip="End call"]',
                ];

                const hasMeetElements = meetIndicators.some(selector => {
                  try {
                    return document.querySelector(selector) !== null;
                  } catch {
                    return false;
                  }
                });

                if (!hasMeetElements) {
                  console.warn('Google Meet UI elements not found - checked selectors:', meetIndicators.length);
                  return 'TEMPORARY'; // May be temporary - use failure counter
                }

                return 'OK';
              } catch (error) {
                console.error('Error checking page validity:', error);
                return 'TEMPORARY'; // May be temporary
              }
            };

            // check if we're still on a valid Google Meet page
            // Start checking after 30 seconds to give time for UI to stabilize
            setTimeout(() => {
              isOnValidGoogleMeetPageInterval = setInterval(() => {
                try {
                  const status = isOnValidGoogleMeetPage();
                  if (status === 'FATAL') {
                    console.log('Google Meet page FATAL error - ending recording on team:', userId, teamId);
                    clearInterval(isOnValidGoogleMeetPageInterval);
                    stopTheRecording();
                  } else if (status === 'TEMPORARY') {
                    pageValidityFailures++;
                    console.warn('Page validity check failed, count:', pageValidityFailures, 'of', maxPageValidityFailures);
                    if (pageValidityFailures >= maxPageValidityFailures) {
                      console.log('Google Meet page state changed (persistent) - ending recording on team:', userId, teamId);
                      clearInterval(isOnValidGoogleMeetPageInterval);
                      stopTheRecording();
                    }
                  } else {
                    // Reset failure counter on success
                    if (pageValidityFailures > 0) {
                      console.log('Page validity recovered after', pageValidityFailures, 'failures');
                    }
                    pageValidityFailures = 0;
                  }
                } catch (intervalError) {
                  console.error('Error in page validity interval - forcing stop:', intervalError);
                  pageValidityFailures++;
                  if (pageValidityFailures >= maxPageValidityFailures) {
                    console.log('Page validity interval crashed repeatedly - ending recording');
                    clearInterval(isOnValidGoogleMeetPageInterval);
                    stopTheRecording();
                  }
                }
              }, 10000);
            }, 30000); // Wait 30 seconds before starting checks
          };

          detectModalsAndDismiss();

          detectMeetingIsOnAValidPage();
          
          // Cancel this timeout when stopping the recording
          // Stop recording after `duration` minutes upper limit
          timeoutId = setTimeout(async () => {
            stopTheRecording();
          }, duration);
        }

        // Start the recording
        await startRecording();
      },
      { 
        teamId,
        duration,
        inactivityLimit,
        userId,
        slightlySecretId: this.slightlySecretId,
        activateInactivityDetectionAfterMinutes: config.activateInactivityDetectionAfter,
        activateInactivityDetectionAfter: new Date(new Date().getTime() + config.activateInactivityDetectionAfter * 60 * 1000).toISOString(),
        primaryMimeType: webmMimeType,
        secondaryMimeType: vp9MimeType,
        recordAudioOnly: config.recordAudioOnly
      }
    );
  
    this._logger.info('Waiting for recording duration', config.maxRecordingDuration, 'minutes...');
    const processingTime = 0.2 * 60 * 1000;
    const waitingPromise: WaitPromise = getWaitingPromise(processingTime + duration);

    waitingPromise.promise.then(async () => {
      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();

      this._logger.info('All done ✨', { eventId, botId, userId, teamId });
    });

    await waitingPromise.promise;
  }
}

import { JoinParams } from './AbstractMeetBot';
import { BotStatus } from '../types';
import config from '../config';
import { WaitingAtLobbyRetryError } from '../error';
import { handleWaitingAtLobbyError, MeetBotBase } from './MeetBotBase';
import { v4 } from 'uuid';
import { patchBotStatus } from '../services/botService';
import { notifyMafStatus } from '../services/notificationService';
import { IUploader } from '../middleware/disk-uploader';
import { Logger } from 'winston';
import { retryActionWithWait } from '../util/resilience';
import { uploadDebugImage } from '../services/bugService';
import createBrowserContext from '../lib/chromium';
import { browserLogCaptureCallback } from '../util/logger';
import { MICROSOFT_REQUEST_DENIED } from '../constants';
import { FFmpegRecorder } from '../lib/ffmpegRecorder';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class MicrosoftTeamsBot extends MeetBotBase {
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
      await this.joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, pushState, uploader, metadata });

      // Finish the upload from the temp video
      const uploadResult = await handleUpload();

      if (_state.includes('finished') && !uploadResult) {
        _state.splice(_state.indexOf('finished'), 1, 'failed');
        this._logger.error('Recording completed but upload failed', { botId, userId, teamId });
        await patchBotStatus({ botId, eventId, provider: 'microsoft', status: _state, token: bearerToken }, this._logger);
        throw new Error('Recording upload failed');
      } else if (uploadResult) {
        this._logger.info('Recording and upload completed successfully', { botId, userId, teamId });
      }

      await patchBotStatus({ botId, eventId, provider: 'microsoft', status: _state, token: bearerToken }, this._logger);
    } catch(error) {
      // Log the actual error that occurred
      this._logger.error('Error in Microsoft Teams bot join process', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        botId,
        userId,
        teamId,
        currentState: _state
      });

      if (!_state.includes('finished'))
        _state.push('failed');

      // Try to update bot status (may fail if API is unreachable, but that's OK)
      await patchBotStatus({ botId, eventId, provider: 'microsoft', status: _state, token: bearerToken }, this._logger);

      if (error instanceof WaitingAtLobbyRetryError)
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'microsoft', error }, this._logger);

      throw error;
    }
  }

  private async joinMeeting({ url, name, teamId, userId, eventId, botId, pushState, uploader, metadata }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    // Skip pre-warming — go straight to the meeting URL.
    // The old approach opened a throwaway browser just to trigger Chrome dialogs, adding ~5-8s.
    // Chrome permission dialogs are handled inline during the actual join flow.
    this._logger.info('Launching browser for Microsoft Teams meeting...');

    this.page = await createBrowserContext(url, this._correlationId, 'microsoft');

    this._logger.info('Navigating to Microsoft Teams Meeting URL...');
    await this.page.goto(url, { waitUntil: 'networkidle' });

    // Find and click "Join from browser" button using Promise.race on all selectors.
    // Old approach tried each selector sequentially with 60s timeout = up to 5 minutes.
    // New approach races them all with a single 15s timeout.
    this._logger.info('Looking for Join from browser button...');
    const joinButtonSelectors = [
      'button[aria-label="Join meeting from this browser"]',
      'button[aria-label="Continue on this browser"]',
      'button[aria-label="Join on this browser"]',
      'button:has-text("Continue on this browser")',
      'button:has-text("Join from browser")',
    ];

    let browserButtonClicked = false;
    try {
      // Race all selectors — first one to appear wins
      const raceResult = await Promise.race([
        ...joinButtonSelectors.map(async (selector, idx) => {
          try {
            await this.page.waitForSelector(selector, { timeout: 15000 });
            return { selector, idx };
          } catch {
            // This selector didn't match in time — let others win
            return new Promise<never>(() => {}); // never resolves
          }
        }),
        // Safety timeout: if none match in 15s, resolve with null
        new Promise<null>(resolve => setTimeout(() => resolve(null), 16000)),
      ]);

      if (raceResult && typeof raceResult === 'object' && 'selector' in raceResult) {
        this._logger.info(`Found button: ${raceResult.selector}`);
        await this.page.click(raceResult.selector, { force: true });
        browserButtonClicked = true;
        this._logger.info('Successfully clicked join from browser button');
      }
    } catch (err) {
      this._logger.info('Error during button race, continuing...', err?.message);
    }

    if (!browserButtonClicked) {
      this._logger.info('Join from browser button not found after 15s, proceeding anyway...');
    }

    // Fill name if input field exists
    try {
      this._logger.info('Looking for name input field...');
      const nameInput = this.page.locator('input[data-tid="prejoin-display-name-input"]');
      await nameInput.waitFor({ state: 'visible', timeout: 15000 });
      this._logger.info('Found name input field, filling with bot name...');
      await nameInput.fill(name ? name : 'ScreenApp Notetaker');
      await this.page.waitForTimeout(250);
    } catch (err) {
      this._logger.info('Name input field not found, skipping...', err?.message);
    }

    // Toggle off camera and mute microphone before joining
    await this.toggleDevicesOff();

    // Click the actual "Join now" button
    this._logger.info('Clicking the join button...');
    await retryActionWithWait(
      'Clicking the join button',
      async () => {
        const possibleTexts = [
          'Join now',
          'Join',
          'Ask to join',
          'Join meeting',
        ];

        let clicked = false;

        for (const text of possibleTexts) {
          try {
            const button = this.page.getByRole('button', { name: new RegExp(text, 'i') });
            if (await button.isVisible({ timeout: 3000 }).catch(() => false)) {
              await button.click();
              clicked = true;
              this._logger.info(`Successfully clicked "${text}" button`);
              break;
            }
          } catch (err) {
            this._logger.info(`Unable to click "${text}" button, trying next...`);
          }
        }

        if (!clicked) {
          throw new Error('Unable to find any join button variant');
        }
      },
      this._logger,
      3,
      15000,
      async () => {
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'join-button-click', userId, this._logger, botId);
      }
    );

    // Wait for admission to meeting (lobby wait)
    try {
      const wanderingTime = config.joinWaitTime * 60 * 1000;
      const callButton = this.page.getByRole('button', { name: /Leave/i });
      await callButton.waitFor({ timeout: wanderingTime });
      this._logger.info('Bot is entering the meeting...');
    } catch (error) {
      const bodyText = await this.page.evaluate(() => document.body.innerText);

      const userDenied = (bodyText || '')?.includes(MICROSOFT_REQUEST_DENIED);

      this._logger.error('Cant finish wait at the lobby check', { userDenied, waitingAtLobbySuccess: false, bodyText });

      this._logger.error('Closing the browser on error...', error);
      await this.page.context().browser()?.close();

      // Don't retry lobby errors - if user doesn't admit bot, retrying won't help
      throw new WaitingAtLobbyRetryError('Microsoft Teams Meeting bot could not enter the meeting...', bodyText ?? '', false, 0);
    }

    pushState('joined');
    if (metadata?.meeting_id && metadata?.tenantId) {
      notifyMafStatus(metadata.meeting_id, metadata.tenantId, 'joining', this._logger);
    }

    // Dismiss device notifications and close buttons
    await this.dismissDeviceChecksAndNotifications();

    // Wait for audio to stabilize before recording
    this._logger.info('Waiting 2 seconds for audio to stabilize before recording...');
    await this.page.waitForTimeout(2000);

    // Recording the meeting page with ffmpeg
    this._logger.info('Begin recording with ffmpeg...');
    if (metadata?.meeting_id && metadata?.tenantId) {
      notifyMafStatus(metadata.meeting_id, metadata.tenantId, 'recording', this._logger);
    }
    await this.recordMeetingPageWithFFmpeg({ teamId, userId, eventId, botId, uploader });

    pushState('finished');
  }

  /**
   * Toggle camera off and mute microphone. Non-blocking — if toggles aren't found, moves on.
   */
  private async toggleDevicesOff(): Promise<void> {
    try {
      this._logger.info('Attempting to turn off camera and mute microphone...');

      // Turn off camera
      try {
        const cameraSelectors = [
          'input[data-tid="toggle-video"][checked]',
          'input[type="checkbox"][title*="Turn camera off" i]',
          'input[role="switch"][data-tid="toggle-video"]',
          'button[aria-label*="Turn camera off" i]',
          'button[aria-label*="Camera off" i]',
        ];

        for (const selector of cameraSelectors) {
          const cameraButton = this.page.locator(selector).first();
          const isVisible = await cameraButton.isVisible({ timeout: 2000 }).catch(() => false);
          if (isVisible) {
            const label = await cameraButton.getAttribute('aria-label');
            this._logger.info(`Clicking camera toggle: ${label}`);
            await cameraButton.click();
            await this.page.waitForTimeout(250);
            break;
          }
        }
      } catch (err) {
        this._logger.info('Could not toggle camera', err?.message);
      }

      // Mute microphone
      try {
        const micSelectors = [
          'input[data-tid="toggle-mute"]:not([checked])',
          'input[type="checkbox"][title*="Mute mic" i]',
          'input[role="switch"][data-tid="toggle-mute"]',
          'button[aria-label*="Mute microphone" i]',
          'button[aria-label*="Mute mic" i]',
        ];

        for (const selector of micSelectors) {
          const micButton = this.page.locator(selector).first();
          const isVisible = await micButton.isVisible({ timeout: 2000 }).catch(() => false);
          if (isVisible) {
            const label = await micButton.getAttribute('aria-label');
            this._logger.info(`Clicking microphone toggle: ${label}`);
            await micButton.click();
            await this.page.waitForTimeout(250);
            break;
          }
        }
      } catch (err) {
        this._logger.info('Could not toggle microphone', err?.message);
      }

      this._logger.info('Finished toggling camera and microphone');
    } catch (error) {
      this._logger.warn('Error toggling devices', error?.message);
    }
  }

  /**
   * Dismiss notification dialogs and device permission modals after joining.
   */
  private async dismissDeviceChecksAndNotifications(): Promise<void> {
    // Notification close button
    try {
      this._logger.info('Checking for notification close button...');
      await this.page.waitForSelector('button[aria-label=Close]', { timeout: 3000 });
      await this.page.click('button[aria-label=Close]', { timeout: 2000 });
      this._logger.info('Dismissed notification');
    } catch {
      this._logger.info('No notification close button found');
    }

    // Device permission close buttons
    try {
      await this.page.waitForSelector('button[title="Close"]', { timeout: 3000 });

      let closeButtonsClicked = 0;
      let previousButtonCount = -1;
      let consecutiveNoChangeCount = 0;
      const maxConsecutiveNoChange = 2;

      while (true) {
        const visibleButtons = await this.page.locator('button[title="Close"]:visible').all();
        const currentButtonCount = visibleButtons.length;

        if (currentButtonCount === 0) break;

        if (currentButtonCount === previousButtonCount) {
          consecutiveNoChangeCount++;
          if (consecutiveNoChangeCount >= maxConsecutiveNoChange) {
            this._logger.warn(`Button count unchanged for ${maxConsecutiveNoChange} iterations, stopping`);
            break;
          }
        } else {
          consecutiveNoChangeCount = 0;
        }

        previousButtonCount = currentButtonCount;

        for (const btn of visibleButtons) {
          try {
            await btn.click({ timeout: 5000 });
            closeButtonsClicked++;
            this._logger.info(`Clicked Close button #${closeButtonsClicked}`);
            await this.page.waitForTimeout(500);
          } catch (err) {
            this._logger.warn('Click failed, possibly already dismissed', { error: err });
          }
        }

        await this.page.waitForTimeout(500);
      }
    } catch {
      this._logger.info('No device permission modals found');
    }

    this._logger.info('Finished dismissing device checks and notifications');
  }

  private async recordMeetingPageWithFFmpeg(
    { teamId, userId, eventId, botId, uploader }:
    { teamId: string, userId: string, eventId?: string, botId?: string, uploader: IUploader }
  ): Promise<void> {
    // Use config max recording duration (3 hours default) - only for safety
    const duration = config.maxRecordingDuration * 60 * 1000;
    this._logger.info(`Recording max duration set to ${duration / 60000} minutes (safety limit only)`);

    // Use the same temp folder as Google Meet bot (has proper permissions)
    const tempFolder = path.join(process.cwd(), 'dist', '_tempvideo');
    const outputPath = path.join(tempFolder, `recording-${botId || Date.now()}.webm`);

    this._logger.info('Starting ffmpeg recording...', { outputPath, duration });

    // Verify PulseAudio is ready before starting FFmpeg
    this._logger.info('Verifying PulseAudio status before starting FFmpeg...');
    try {
      // Check if PulseAudio process is running
      try {
        const { stdout: psOutput } = await execAsync('ps aux | grep pulseaudio | grep -v grep');
        this._logger.info('PulseAudio process status:', psOutput.trim());
      } catch (err) {
        this._logger.error('PulseAudio process not found!', err);
      }

      // Check XDG_RUNTIME_DIR
      this._logger.info('Environment check:', {
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        USER: process.env.USER,
        HOME: process.env.HOME
      });

      // Check if PulseAudio socket exists
      try {
        const socketPath = `${process.env.XDG_RUNTIME_DIR}/pulse/native`;
        const { stdout: socketCheck } = await execAsync(`ls -la ${socketPath}`);
        this._logger.info('PulseAudio socket exists:', socketCheck.trim());
      } catch (err) {
        this._logger.error('PulseAudio socket not found!', err);
      }

      // Try to list sources
      const { stdout: paStatus } = await execAsync('pactl list sources short');
      this._logger.info('PulseAudio sources available:', paStatus.trim() || '(empty - no sources found)');

      if (!paStatus.includes('virtual_output.monitor')) {
        this._logger.error('WARNING: virtual_output.monitor not found in PulseAudio sources!');
        this._logger.info('Attempting to restart PulseAudio and recreate virtual audio device...');

        // Try to restart PulseAudio
        try {
          await execAsync('pulseaudio --kill || true');
          await execAsync('sleep 1');
          await execAsync('pulseaudio -D --exit-idle-time=-1 --log-level=info');
          await execAsync('sleep 2');
          this._logger.info('Restarted PulseAudio');

          // Recreate the null sink
          await execAsync('pactl load-module module-null-sink sink_name=virtual_output sink_properties=device.description="Virtual_Output"');
          await execAsync('pactl set-default-sink virtual_output');
          this._logger.info('Recreated virtual_output sink and monitor');

          // Verify it worked
          const { stdout: newStatus } = await execAsync('pactl list sources short');
          this._logger.info('PulseAudio sources after restart:', newStatus.trim());
        } catch (err) {
          this._logger.error('Failed to restart PulseAudio or recreate virtual audio device:', err);
        }
      }
    } catch (err) {
      this._logger.error('Error checking PulseAudio status:', err);
    }

    // Create and start ffmpeg recorder
    const recorder = new FFmpegRecorder(outputPath, this._logger);

    // Track FFmpeg status
    let ffmpegFailed = false;
    let ffmpegError: Error | null = null;

    try {
      await recorder.start();
      this._logger.info('FFmpeg recording started successfully');

      // Monitor FFmpeg process - if it dies, stop recording immediately
      recorder.onProcessExit((code) => {
        if (code !== 0 && code !== null) {
          this._logger.error('FFmpeg died unexpectedly during recording', { exitCode: code });
          ffmpegFailed = true;
          ffmpegError = new Error(`FFmpeg exited with code ${code} during recording`);
        }
      });

      // Set up browser-based inactivity detection
      let meetingEnded = false;
      await this.page.exposeFunction('screenAppMeetEnd', () => {
        this._logger.info('Meeting ended signal received from browser');
        meetingEnded = true;
      });

      // Capture and forward browser console logs to Node.js logger
      this.page.on('console', async msg => {
        try {
          await browserLogCaptureCallback(this._logger, msg);
        } catch(err) {
          this._logger.info('Playwright chrome logger: Failed to log browser messages...', err?.message);
        }
      });

      // Start audio silence detection (runs in parallel with participant detection)
      // Convert inactivityLimit from minutes to milliseconds
      const inactivityLimitMs = config.inactivityLimit * 60 * 1000;

      const monitorAudioSilence = async () => {
        try {
          this._logger.info('Starting audio silence detection for Microsoft Teams', {
            inactivityLimitMs,
            inactivityLimitMinutes: inactivityLimitMs / 60000
          });
          let consecutiveSilentChecks = 0;
          const checkIntervalSeconds = 5;
          const checksNeeded = Math.ceil(inactivityLimitMs / 1000 / checkIntervalSeconds);

          const checkInterval = setInterval(async () => {
            try {
              const { stdout } = await execAsync(
                'timeout 1 parec --device=virtual_output.monitor --format=s16le --rate=16000 --channels=1 2>/dev/null | ' +
                'od -An -td2 -v | awk \'BEGIN{max=0} {for(i=1;i<=NF;i++) {val=($i<0)?-$i:$i; if(val>max) max=val}} END{print max}\''
              );

              const peakLevel = parseInt(stdout.trim()) || 0;
              const silenceThreshold = 200;

              this._logger.debug('Audio level check', { peakLevel, threshold: silenceThreshold });

              if (peakLevel < silenceThreshold) {
                consecutiveSilentChecks++;
                this._logger.info(`Silence detected: ${consecutiveSilentChecks}/${checksNeeded} checks`, { peakLevel });

                if (consecutiveSilentChecks >= checksNeeded) {
                  this._logger.warn('Audio silence threshold reached, ending Microsoft Teams meeting', {
                    userId,
                    teamId,
                    silenceDurationMs: inactivityLimitMs,
                    silenceDurationMinutes: inactivityLimitMs / 60000,
                    finalPeakLevel: peakLevel,
                    checksNeeded,
                    checksDetected: consecutiveSilentChecks
                  });
                  clearInterval(checkInterval);
                  meetingEnded = true;
                }
              } else {
                if (consecutiveSilentChecks > 0) {
                  this._logger.info('Audio detected, resetting silence counter', { peakLevel });
                }
                consecutiveSilentChecks = 0;
              }
            } catch (err) {
              this._logger.error('Error checking audio level:', err);
            }
          }, 5000);

        } catch (error) {
          this._logger.error('Failed to initialize audio silence detection:', error);
          this._logger.warn('Will rely on participant detection only');
        }
      };

      // Start silence monitoring after delay
      setTimeout(() => {
        monitorAudioSilence();
      }, config.activateInactivityDetectionAfter * 60 * 1000);

      // Inject inactivity detection script
      await this.page.evaluate(
        ({ activateAfterMinutes, maxDuration }: { activateAfterMinutes: number, maxDuration: number }) => {
          // Max duration timeout - safety limit (3 hours default in production)
          setTimeout(() => {
            console.log(`Max recording duration (${maxDuration / 60000} minutes) reached, ending meeting`);
            (window as any).screenAppMeetEnd();
          }, maxDuration);
          console.log(`Max duration timeout set to ${maxDuration / 60000} minutes (safety limit)`);

          // IMMEDIATE: Detect "meeting ended" DOM signals from Teams
          let meetEndDetected = false;
          const endMeetingOnce = (reason: string) => {
            if (meetEndDetected) return;
            meetEndDetected = true;
            console.log(`Meeting end detected: ${reason}`);
            (window as any).screenAppMeetEnd();
          };

          // Check for Teams "meeting ended" signals every 2 seconds (starts immediately)
          const meetingEndedCheck = setInterval(() => {
            try {
              const bodyText = document.body?.innerText || '';
              if (bodyText.includes('The meeting has ended') ||
                  bodyText.includes('You left the meeting') ||
                  bodyText.includes('Meeting has ended') ||
                  bodyText.includes('Call ended') ||
                  bodyText.includes('You were removed from the meeting')) {
                clearInterval(meetingEndedCheck);
                endMeetingOnce('Teams meeting-ended overlay detected');
              }

              const url = window.location.href;
              if (url.includes('/post-meeting') || url.includes('/meetingEnded')) {
                clearInterval(meetingEndedCheck);
                endMeetingOnce('Redirected to post-meeting page');
              }
            } catch (error) {
              // Non-fatal, keep checking
            }
          }, 2000);

          // Activate participant detection after delay
          setTimeout(() => {
            console.log('Activating participant count detection...');

            const detectLoneParticipant = () => {
              const interval = setInterval(() => {
                try {
                  const regex = /\d+/;
                  const contributors = Array.from(document.querySelectorAll('button[aria-label=People]') ?? [])
                    .filter(x => regex.test(x?.textContent ?? ''))[0]?.textContent;
                  const match = (typeof contributors === 'undefined' || !contributors) ? null : contributors.match(regex);

                  if (match && Number(match[0]) >= 2) {
                    return; // Still has participants
                  }

                  clearInterval(interval);
                  endMeetingOnce('Bot is alone (participant count)');
                } catch (error) {
                  console.error('Participant detection error:', error);
                }
              }, 2000);
            };

            detectLoneParticipant();
          }, activateAfterMinutes * 60 * 1000);
        },
        {
          activateAfterMinutes: config.activateInactivityDetectionAfter,
          maxDuration: duration,
        }
      );

      // Wait for either timeout, meeting end, or FFmpeg failure
      const startTime = Date.now();
      while (!meetingEnded && !ffmpegFailed && (Date.now() - startTime) < duration) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      this._logger.info('Recording period ended', {
        meetingEnded,
        ffmpegFailed,
        recordedDuration: Math.floor((Date.now() - startTime) / 1000) + 's'
      });

      // If FFmpeg failed during recording, throw the error
      if (ffmpegFailed && ffmpegError) {
        throw ffmpegError;
      }

    } catch (error) {
      this._logger.error('Error during recording:', error);
      ffmpegFailed = true;
      ffmpegError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      // Always stop ffmpeg
      this._logger.info('Stopping ffmpeg recording...');
      await recorder.stop();

      // Upload the recorded file
      this._logger.info('Uploading recorded file...', { outputPath });

      let uploadSuccess = false;
      if (fs.existsSync(outputPath)) {
        const fileBuffer = fs.readFileSync(outputPath);
        await uploader.saveDataToTempFile(fileBuffer);

        // Clean up the temporary file
        fs.unlinkSync(outputPath);
        this._logger.info('Recording uploaded and temporary file cleaned up');
        uploadSuccess = true;
      } else {
        this._logger.error('Recording file not found!', { outputPath });
      }

      // Close browser
      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();

      // Log final status
      if (ffmpegFailed) {
        this._logger.error('Recording failed due to FFmpeg error', { botId, eventId, userId, teamId });
      } else if (!uploadSuccess) {
        this._logger.error('Recording completed but file upload failed', { botId, eventId, userId, teamId });
      } else {
        this._logger.info('Recording completed successfully ✨', { botId, eventId, userId, teamId });
      }
    }
  }
}

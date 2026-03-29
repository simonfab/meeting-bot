import { Page } from 'playwright';
import { Task } from '../lib/Task';
import config from '../config';
import { Logger } from 'winston';
import { vp9MimeType, webmMimeType } from '../lib/recording';

export class RecordingTask extends Task<null, void> {
  private userId: string;
  private teamId: string;
  private page: Page;
  private duration: number;
  private inactivityLimit: number;
  private slightlySecretId: string;
  
  constructor(
    userId: string,
    teamId: string,
    page: Page,
    duration: number,
    slightlySecretId: string,
    logger: Logger
  ) {
    super(logger);
    this.userId = userId;
    this.teamId = teamId;
    this.duration = duration;
    this.inactivityLimit = config.inactivityLimit * 60 * 1000;
    this.page = page;
    this.slightlySecretId = slightlySecretId;
  }

  protected async execute(): Promise<void> {
    await this.page.evaluate(
      async ({ teamId, duration, inactivityLimit, userId, slightlySecretId, activateInactivityDetectionAfter, activateInactivityDetectionAfterMinutes, primaryMimeType, secondaryMimeType, recordAudioOnly }:
        { teamId: string, duration: number, inactivityLimit: number, userId: string, slightlySecretId: string, activateInactivityDetectionAfter: string, activateInactivityDetectionAfterMinutes: number, primaryMimeType: string, secondaryMimeType: string, recordAudioOnly: boolean }) => {
        let timeoutId: NodeJS.Timeout;
        let inactivityDetectionTimeout: NodeJS.Timeout;

        /**
         * @summary A simple method to reliably send chunks over exposeFunction
         * @param chunk Array buffer to send
         * @returns void
         */
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

          const audioTracks = stream.getAudioTracks();
          const videoTracks = stream.getVideoTracks();
          const hasAudioTracks = audioTracks.length > 0;
          console.log(`Captured stream tracks - audio: ${audioTracks.length}, video: ${videoTracks.length}`);

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

          mediaRecorder.ondataavailable = async (event: BlobEvent) => {
            if (!event.data.size) {
              console.warn('Received empty chunk...');
              return;
            }
            try {
              const arrayBuffer = await event.data.arrayBuffer();
              await sendChunkToServer(arrayBuffer);
            } catch (error) {
              console.error('Error uploading chunk:', error.message, error);
            }
          };

          // Start recording with 2-second intervals
          const chunkDuration = 2000;
          mediaRecorder.start(chunkDuration);

          const stopTheRecording = async () => {
            console.log('-------- TRIGGER stop the recording');
            mediaRecorder.stop();
            const tracksToStop = new Map<string, MediaStreamTrack>();
            stream.getTracks().forEach((track) => tracksToStop.set(track.id, track));
            recordingStream.getTracks().forEach((track) => tracksToStop.set(track.id, track));
            tracksToStop.forEach((track) => track.stop());

            // Cleanup recording timer
            clearTimeout(timeoutId);

            // Cancel the perpetural checks
            if (inactivityDetectionTimeout) {
              clearTimeout(inactivityDetectionTimeout);
            }

            // Begin browser cleanup
            (window as any).screenAppMeetEnd(slightlySecretId);
          };

          let loneTest: NodeJS.Timeout;
          let monitor = true;

          // Participant detection — starts immediately, state-aware
          // Phase 1: Wait for someone to join (count >= 2)
          // Phase 2: Once participants seen, end as soon as bot is alone (count < 2)
          let hasSeenParticipants = false;
          console.log('Participant count detection active (waiting for participants to join)...');

          const detectLoneParticipant = () => {
            let dom: Document = document;
            const iframe: HTMLIFrameElement | null = document.querySelector('iframe#webclient');
            if (iframe && iframe.contentDocument) {
              console.log('Using iframe for participants detection...');
              dom = iframe.contentDocument;
            }

            loneTest = setInterval(() => {
              try {
                // Detect and click blocking "OK" buttons
                const okButton = Array.from(dom.querySelectorAll('button'))
                    .filter((el) => el?.innerText?.trim()?.match(/^OK/i));
                if (okButton && okButton[0]) {
                  console.log('It appears that meeting has been ended. Click "OK" and verify if meeting is still in progress...', { userId });
                  let shouldEndMeeting = false;
                  const meetingEndLabel = dom.querySelector('[aria-label="Meeting is end now"]');
                  if (meetingEndLabel) {
                    shouldEndMeeting = true;
                  }
                  else {
                    const endText = 'This meeting has been ended by host';
                    const divs = dom.querySelectorAll('div');
                    for (const modal of divs) {
                      if (modal.innerText.includes(endText)) {
                        shouldEndMeeting = true;
                        break;
                      }
                    }
                  }
                  okButton[0].click();
                  if (shouldEndMeeting) {
                    console.log('Detected Zoom meeting has been ended by host. End Recording...', { userId });
                    clearInterval(loneTest);
                    monitor = false;
                    stopTheRecording();
                  }
                }

                // Detect number of participants
                const participantsMatch = Array.from(dom.querySelectorAll('button'))
                    .filter((el) => el?.innerText?.trim()?.match(/^\d+/));
                const text = participantsMatch && participantsMatch.length > 0 ? participantsMatch[0].innerText.trim() : null;
                if (!text) {
                  console.error('Zoom presence detection is probably not working on user:', userId, teamId);
                  return;
                }

                const regex = new RegExp(/\d+/);
                const participants = text.match(regex);
                if (!participants || participants.length === 0) {
                  console.error('Zoom participants detection is probably not working on user:', { userId, teamId });
                  return;
                }
                const count = Number(participants[0]);
                if (count > 1) {
                  if (!hasSeenParticipants) {
                    console.log(`Participants joined (count: ${count}) — meeting is active`);
                    hasSeenParticipants = true;
                  }
                  return;
                }

                if (hasSeenParticipants) {
                  console.log(`Bot is alone after participants left (count: ${count})`, { userId, teamId });
                  clearInterval(loneTest);
                  monitor = false;
                  stopTheRecording();
                }
                // If !hasSeenParticipants, keep waiting — bot arrived early
              } catch (error) {
                console.error('Zoom Meeting presence detection failed on team:', { userId, teamId, message: error.message, error });
              }
            }, 2000); // Detect every 2 seconds
          };

          const detectIncrediblySilentMeeting = () => {
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

            // Audio gain/volume
            const silenceThreshold = 10;

            const monitorSilence = () => {
              analyser.getByteFrequencyData(dataArray);

              const audioActivity = dataArray.reduce((a, b) => a + b) / dataArray.length;

              if (audioActivity < silenceThreshold) {
                silenceDuration += 100; // Check every 100ms
                if (silenceDuration >= inactivityLimit) {
                  console.warn('Detected silence in Zoom Meeting and ending the recording on team:', userId, teamId);
                  monitor = false;
                  clearInterval(loneTest);
                  stopTheRecording();
                }
              } else {
                silenceDuration = 0;
              }

              if (monitor) {
                // Recursively queue the next check
                setTimeout(monitorSilence, 100);
              }
            };

            // Go silence monitor
            monitorSilence();
          };

          /**
           * Participant detection starts immediately (state-aware — waits for
           * participants before triggering end). Silence detection starts after
           * grace period as a safety net.
           */
          detectLoneParticipant();
          inactivityDetectionTimeout = setTimeout(() => {
            detectIncrediblySilentMeeting();
          }, activateInactivityDetectionAfterMinutes * 60 * 1000);

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
        teamId: this.teamId,
        duration: this.duration,
        inactivityLimit: this.inactivityLimit, 
        userId: this.userId, 
        slightlySecretId: this.slightlySecretId,
        activateInactivityDetectionAfterMinutes: config.activateInactivityDetectionAfter,
        activateInactivityDetectionAfter: new Date(new Date().getTime() + config.activateInactivityDetectionAfter * 60 * 1000).toISOString(),
        primaryMimeType: webmMimeType,
        secondaryMimeType: vp9MimeType,
        recordAudioOnly: config.recordAudioOnly
      }
    );
  }
}

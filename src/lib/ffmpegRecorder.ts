import { spawn, ChildProcess } from 'child_process';
import { Logger } from 'winston';
import config from '../config';

type FFmpegRecordingMode = 'audio-only' | 'audio-video';

export class FFmpegRecorder {
  private ffmpegProcess: ChildProcess | null = null;
  private outputPath: string;
  private logger: Logger;
  private exitCallback: ((code: number | null) => void) | null = null;
  private currentMode: FFmpegRecordingMode = 'audio-video';

  constructor(outputPath: string, logger: Logger) {
    this.outputPath = outputPath;
    this.logger = logger;
  }

  /**
   * Register a callback to be notified when FFmpeg process exits
   */
  onProcessExit(callback: (code: number | null) => void): void {
    this.exitCallback = callback;
  }

  private buildAudioVideoArgs(): string[] {
    return [
      '-y',
      '-loglevel', 'info',

      // Video input from X11 display (with Y offset to skip address bar)
      '-f', 'x11grab',
      '-video_size', '960x540',
      '-framerate', '25',
      '-draw_mouse', '0',
      '-i', `${process.env.DISPLAY || ':99'}+0,80`,

      // Audio input from PulseAudio monitor
      '-f', 'pulse',
      '-ac', '2',
      '-ar', '44100',
      '-i', 'virtual_output.monitor',

      // Video encoding - VP8 for WebM
      '-c:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '8',
      '-b:v', '0',
      '-crf', '35',
      '-g', '50',
      '-threads', '0',

      // Audio encoding - Opus for WebM
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',

      '-f', 'webm',
      this.outputPath,
    ];
  }

  private buildAudioOnlyArgs(): string[] {
    return [
      '-y',
      '-loglevel', 'info',

      // Audio-only capture from PulseAudio monitor
      '-f', 'pulse',
      '-ac', '2',
      '-ar', '44100',
      '-i', 'virtual_output.monitor',

      // Keep output as WebM for downstream compatibility
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-vn',

      '-f', 'webm',
      this.outputPath,
    ];
  }

  private getArgsForMode(mode: FFmpegRecordingMode): string[] {
    if (mode === 'audio-only') {
      return this.buildAudioOnlyArgs();
    }
    return this.buildAudioVideoArgs();
  }

  private async startWithMode(mode: FFmpegRecordingMode): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const ffmpegArgs = this.getArgsForMode(mode);

        this.logger.info('Starting ffmpeg', {
          mode,
          args: ffmpegArgs.join(' '),
        });

        // Ensure FFmpeg can connect to PulseAudio
        const ffmpegEnv = {
          ...process.env,
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/1001',
          DISPLAY: process.env.DISPLAY || ':99',
        };

        this.logger.info('FFmpeg environment:', {
          mode,
          XDG_RUNTIME_DIR: ffmpegEnv.XDG_RUNTIME_DIR,
          DISPLAY: ffmpegEnv.DISPLAY,
          USER: process.env.USER,
          HOME: process.env.HOME,
        });

        const processRef = spawn('ffmpeg', ffmpegArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: ffmpegEnv,
        });
        this.ffmpegProcess = processRef;

        // Handle stdout
        processRef.stdout?.on('data', (data) => {
          this.logger.debug('ffmpeg stdout:', data.toString());
        });

        // Buffer to accumulate stderr for better error reporting
        let stderrBuffer = '';
        const startTime = Date.now();

        // Handle stderr (ffmpeg outputs progress here)
        processRef.stderr?.on('data', (data) => {
          const output = data.toString();
          stderrBuffer += output;

          const isStartupPhase = (Date.now() - startTime) < 5000; // First 5 seconds

          // Log errors and important messages
          if (output.includes('error') || output.includes('Error') || output.includes('Invalid') || output.includes('Failed')) {
            this.logger.error('ffmpeg error:', { mode, output });
          } else if (output.includes('Duration') || output.includes('Stream #') || output.includes('video:') || output.includes('audio:')) {
            this.logger.info('ffmpeg info:', { mode, output: output.trim() });
          } else if (isStartupPhase) {
            // Log all stderr at info level during startup (first 5 seconds) to catch initialization errors
            this.logger.info('ffmpeg startup:', { mode, output: output.trim().substring(0, 200) });
          } else {
            // After startup, only debug log progress updates
            this.logger.debug('ffmpeg progress:', { mode, output: output.substring(0, 150) });
          }
        });

        // Track if we already resolved/rejected
        let settled = false;

        // Handle process exit
        processRef.on('exit', (code, signal) => {
          this.logger.info('ffmpeg process exited', { mode, code, signal });

          // Notify callback if registered
          if (this.exitCallback) {
            this.exitCallback(code);
          }

          // If exited with error, log the full stderr buffer
          if (code !== 0 && code !== null) {
            this.logger.error('FFmpeg failed with exit code', code);
            const trimmedBuffer = stderrBuffer.trim();
            if (trimmedBuffer) {
              this.logger.error('FFmpeg stderr output:', { mode, stderr: trimmedBuffer });
            } else {
              this.logger.error('FFmpeg stderr was empty - process may have crashed without error message');
              this.logger.error('Common causes: screen size mismatch (check Xvfb resolution vs capture area + offset), PulseAudio not running, X11 display not available');
            }
            if (this.ffmpegProcess === processRef) {
              this.ffmpegProcess = null;
            }

            // If we haven't settled yet (early failure during startup), reject
            if (!settled) {
              settled = true;
              reject(new Error(`FFmpeg (${mode}) exited with code ${code}: ${trimmedBuffer || 'no error details'}`));
            }
          }
        });

        // Handle errors
        processRef.on('error', (error) => {
          this.logger.error('ffmpeg process error:', { mode, error });
          if (this.ffmpegProcess === processRef) {
            this.ffmpegProcess = null;
          }
          if (!settled) {
            settled = true;
            reject(error);
          }
        });

        // Wait a bit to ensure ffmpeg starts successfully
        setTimeout(() => {
          if (settled) {
            // Already rejected due to early exit/error
            return;
          }

          if (processRef && !processRef.killed && processRef.exitCode === null) {
            this.logger.info('ffmpeg recording started successfully', { mode });
            settled = true;
            resolve();
          } else {
            this.logger.error('ffmpeg failed to start or already exited', { mode });
            settled = true;
            reject(new Error(`ffmpeg (${mode}) failed to start`));
          }
        }, 2000);

      } catch (error) {
        this.logger.error('Error starting ffmpeg:', { mode, error });
        reject(error);
      }
    });
  }

  async start(): Promise<void> {
    const initialMode: FFmpegRecordingMode = config.recordAudioOnly ? 'audio-only' : 'audio-video';
    const fallbackMode: FFmpegRecordingMode = 'audio-video';
    const modesToTry: FFmpegRecordingMode[] = initialMode === fallbackMode
      ? [initialMode]
      : [initialMode, fallbackMode];

    let lastError: unknown;
    for (let i = 0; i < modesToTry.length; i++) {
      const mode = modesToTry[i];
      this.currentMode = mode;
      try {
        await this.startWithMode(mode);
        if (i > 0) {
          this.logger.warn('FFmpeg fallback mode engaged', { mode });
        }
        return;
      } catch (error) {
        lastError = error;
        this.logger.error('FFmpeg start attempt failed', {
          mode,
          error: error instanceof Error ? error.message : String(error),
        });
        if (i < modesToTry.length - 1) {
          this.logger.warn('Retrying FFmpeg start with fallback mode', {
            fromMode: mode,
            toMode: modesToTry[i + 1],
          });
        }
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error('FFmpeg failed to start in all modes');
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ffmpegProcess) {
        this.logger.warn('No ffmpeg process to stop');
        resolve();
        return;
      }

      this.logger.info('Sending quit signal to ffmpeg...', { mode: this.currentMode });

      // Flag to track if already resolved
      let resolved = false;

      // Send 'q' to ffmpeg stdin to gracefully stop
      try {
        if (this.ffmpegProcess.stdin) {
          this.ffmpegProcess.stdin.write('q\n');
          this.ffmpegProcess.stdin.end();
          this.logger.info('Quit signal sent successfully');
        }
      } catch (error) {
        this.logger.warn('Could not send quit signal to ffmpeg stdin:', error);
        // Fallback to SIGTERM
        this.ffmpegProcess.kill('SIGTERM');
      }

      // WebM format needs no finalization (unlike MP4), so ffmpeg exits quickly
      const timeout = setTimeout(() => {
        if (this.ffmpegProcess && !this.ffmpegProcess.killed && !resolved) {
          this.logger.warn('ffmpeg did not exit after 5s, sending SIGTERM');
          this.ffmpegProcess.kill('SIGTERM');

          // Last resort SIGKILL after 3 more seconds
          setTimeout(() => {
            if (this.ffmpegProcess && !this.ffmpegProcess.killed && !resolved) {
              this.logger.error('ffmpeg still not exited, sending SIGKILL');
              this.ffmpegProcess.kill('SIGKILL');
            }
          }, 3000);
        }
      }, 5000);

      this.ffmpegProcess.on('exit', (code, signal) => {
        if (!resolved) {
          clearTimeout(timeout);
          this.logger.info('ffmpeg process exited gracefully', { mode: this.currentMode, code, signal });
          this.ffmpegProcess = null;
          resolved = true;
          resolve();
        }
      });

      // If already exited
      if (this.ffmpegProcess.killed || this.ffmpegProcess.exitCode !== null) {
        clearTimeout(timeout);
        this.ffmpegProcess = null;
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }
    });
  }
}

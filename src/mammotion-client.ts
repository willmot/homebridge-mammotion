import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import type { Logger } from 'homebridge';

import type {
  MammotionBridgeResponse,
  MammotionDeviceInfo,
  MammotionPlatformConfig,
  MammotionState,
} from './types';
import {
  bootstrapManagedPython,
  managedVenvPythonPath,
  probePython,
  versionIsSupported,
  versionLabel,
} from './python-env';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

const REQUEST_TIMEOUTS_MS: Record<string, number> = {
  init: 120000,
  command: 60000,
  poll: 30000,
  shutdown: 5000,
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

const MAX_RESTART_ATTEMPTS = 10;

export class MammotionClient extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private pythonPath: string;
  private readonly userConfiguredPythonPath: boolean;
  private stopping = false;
  private restartAttempts = 0;
  private restartTimer?: NodeJS.Timeout;

  constructor(
    private readonly log: Logger,
    private readonly config: MammotionPlatformConfig,
  ) {
    super();
    this.userConfiguredPythonPath = Boolean(config.pythonPath);
    this.pythonPath = config.pythonPath ?? managedVenvPythonPath();
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    await this.verifyPythonEnvironment();

    const bridgePath = join(__dirname, 'python', 'bridge.py');
    this.process = spawn(this.pythonPath, [bridgePath], {
      stdio: 'pipe',
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    this.process.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text.length > 0) {
        if (text.includes('map areas=') || text.includes('get_area_name_list') || text.includes('start_map_sync')) {
          this.log.info(`[bridge] ${text}`);
        } else {
          this.log.debug(`[bridge] ${text}`);
        }
      }
    });

    this.process.on('exit', (code, signal) => {
      const error = new Error(`Bridge exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      for (const [, request] of this.pending) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      this.process = undefined;
      this.emit('exit', error);

      if (!this.stopping) {
        this.scheduleRestart();
      }
    });

    await this.request('init', {
      email: this.config.email,
      password: this.config.password,
      areaNameFallbacks: this.config.areaNameFallbacks ?? {},
    });

    this.restartAttempts = 0;
  }

  private timeoutForMethod(method: string): number {
    const base = REQUEST_TIMEOUTS_MS[method] ?? DEFAULT_REQUEST_TIMEOUT_MS;

    if (method === 'shutdown') {
      return base;
    }

    const override = this.config.requestTimeoutSeconds;
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
      return override * 1000;
    }

    return base;
  }

  private scheduleRestart(): void {
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.log.error(
        `Mammotion bridge failed to stay running after ${MAX_RESTART_ATTEMPTS} restart attempts; giving up. Restart Homebridge to try again.`,
      );
      return;
    }

    const delay = Math.min(60000, 2000 * 2 ** this.restartAttempts);
    this.restartAttempts++;
    this.log.warn(
      `Mammotion bridge will restart in ${delay / 1000}s (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS}).`,
    );

    this.restartTimer = setTimeout(() => {
      this.start().catch((error: Error) => {
        this.log.error(`Mammotion bridge restart failed: ${error.message}`);
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }

    if (!this.process) {
      return;
    }

    await this.request('shutdown', {}).catch(() => undefined);
    this.process.kill();
    this.process = undefined;
  }

  async discoverDevices(): Promise<MammotionDeviceInfo[]> {
    return this.request<MammotionDeviceInfo[]>('list_devices', {});
  }

  async pollStates(): Promise<MammotionState[]> {
    return this.request<MammotionState[]>('poll', {});
  }

  async command(deviceName: string, action: 'start' | 'pause' | 'dock' | 'cancel'): Promise<MammotionState> {
    return this.request<MammotionState>('command', {
      name: deviceName,
      action,
    });
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.process) {
      throw new Error('Bridge is not running');
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    const timeoutMs = this.timeoutForMethod(method);

    const responsePromise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Bridge request '${method}' timed out after ${timeoutMs / 1000}s`));
        }
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer,
      });
    });

    this.process.stdin.write(`${payload}\n`);
    return responsePromise;
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');

    while (true) {
      const lineEnd = this.buffer.indexOf('\n');
      if (lineEnd < 0) {
        return;
      }

      const line = this.buffer.slice(0, lineEnd).trim();
      this.buffer = this.buffer.slice(lineEnd + 1);

      if (line.length === 0) {
        continue;
      }

      let message: { id?: number } & MammotionBridgeResponse;
      try {
        message = JSON.parse(line) as { id?: number } & MammotionBridgeResponse;
      } catch (error) {
        this.log.warn(`Failed to parse bridge message: ${line}`);
        continue;
      }

      if (typeof message.id !== 'number') {
        continue;
      }

      const request = this.pending.get(message.id);
      if (!request) {
        continue;
      }

      this.pending.delete(message.id);
      clearTimeout(request.timer);

      if (!message.ok) {
        request.reject(new Error(message.error ?? 'Unknown bridge error'));
        continue;
      }

      request.resolve(message.data);
    }
  }

  private async verifyPythonEnvironment(): Promise<void> {
    let probe = await probePython(this.pythonPath);
    if (!probe.available || !versionIsSupported(probe) || !probe.hasPyMammotion) {
      if (!this.userConfiguredPythonPath) {
        this.log.info('Preparing managed Python environment for Mammotion bridge...');
        this.pythonPath = await bootstrapManagedPython(this.log);
        probe = await probePython(this.pythonPath);
      } else if (!probe.available) {
        this.log.warn(
          `Configured pythonPath "${this.pythonPath}" is not executable in Homebridge runtime (${probe.error ?? 'unknown reason'}). Falling back to managed runtime.`,
        );
        this.pythonPath = await bootstrapManagedPython(this.log);
        probe = await probePython(this.pythonPath);
      }
    }

    if (!probe.available) {
      throw new Error(
        `Cannot execute python interpreter "${this.pythonPath}" (${probe.error ?? 'unknown reason'}).`,
      );
    }

    if (!versionIsSupported(probe)) {
      throw new Error(
        `Python ${versionLabel(probe)} at ${probe.executable ?? this.pythonPath} is unsupported. Use Python 3.10+ or remove "pythonPath" to use managed runtime.`,
      );
    }

    if (!probe.hasPyMammotion) {
      if (this.userConfiguredPythonPath) {
        const installHint = `${this.pythonPath} -m pip install --upgrade pip pymammotion==0.5.75`;
        throw new Error(
          [
            `Python found at ${probe.executable ?? this.pythonPath} but module "pymammotion" is missing.`,
            `Install it with: ${installHint}`,
            'Or remove "pythonPath" to use managed runtime.',
          ].join(' '),
        );
      }

      throw new Error('Managed runtime bootstrap completed but pymammotion is still unavailable.');
    }
  }
}

import type { Logger } from 'homebridge';

import type { MammotionClient } from './mammotion-client';
import type { MammotionAction, MammotionDeviceInfo, MammotionState } from './types';

type Composable = { with: (...features: unknown[]) => unknown };

type MatterApi = {
  uuid: { generate: (input: string) => string };
  deviceTypes: { RoboticVacuumCleaner: unknown };
  deviceRequirements?: { PowerSource: { PowerSourceServer: unknown } };
  updateAccessoryState: (
    uuid: string,
    cluster: string,
    attributes: Record<string, unknown>,
    partId?: string,
  ) => Promise<void>;
};

type MatterAccessoryLike = {
  UUID: string;
  displayName: string;
  deviceType: unknown;
  serialNumber: string;
  manufacturer: string;
  model: string;
  firmwareRevision: string;
  hardwareRevision: string;
  context: Record<string, unknown>;
  clusters: Record<string, unknown>;
  handlers: Record<string, unknown>;
};

export class MammotionMatterVacuum {
  private readonly accessory: MatterAccessoryLike;

  constructor(
    private readonly matterApi: MatterApi,
    private readonly log: Logger,
    private readonly device: MammotionDeviceInfo,
    private readonly client: MammotionClient,
    uuidSeed: string,
  ) {
    const serial = device.serialNumber ?? device.name;
    const uuid = matterApi.uuid.generate(`mammotion-rvc:${uuidSeed}:${device.name}`);

    this.accessory = {
      UUID: uuid,
      displayName: device.name,
      deviceType: this.batteryDeviceType(),
      serialNumber: serial,
      manufacturer: 'Mammotion',
      model: device.model ?? 'Mower',
      firmwareRevision: 'via Mammotion API',
      hardwareRevision: '1.0',
      context: {
        deviceName: device.name,
      },
      clusters: {
        powerSource: {
          status: 0, order: 0, description: 'Mower battery',
          // Homebridge publishes RVCs as standalone nodes with the mower on
          // endpoint 1. Associate its battery explicitly with that endpoint.
          endpointList: [1],
          batPercentRemaining: null, batChargeLevel: 0, batChargeState: 0,
          batReplacementNeeded: false, batReplaceability: 0, batPresent: true,
          batFunctionalWhileCharging: false,
        },
        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: 0, modeTags: [{ value: 16384 }] },
            { label: 'Cleaning', mode: 1, modeTags: [{ value: 16385 }] },
          ],
          currentMode: 0,
        },
        // Work parameters are read-only in the API. Do not advertise selectable
        // clean modes that cannot be applied to the mower.
        rvcOperationalState: {
          operationalStateList: [
            { operationalStateId: 0 },
            { operationalStateId: 1 },
            { operationalStateId: 2 },
            { operationalStateId: 3 },
            { operationalStateId: 64 },
            { operationalStateId: 65 },
            { operationalStateId: 66 },
          ],
          operationalState: 3,
          operationalError: { errorStateId: 2, errorStateDetails: 'Mower telemetry unavailable' },
        },
      },
      handlers: {
        rvcRunMode: {
          changeToMode: async (request: { newMode: number }) => {
            if (request.newMode === 1) {
              await this.command('start');
            } else if (request.newMode === 0) {
              await this.command('cancel');
            } else {
              throw new Error('Unsupported mower run mode');
            }
          },
        },
        rvcOperationalState: {
          pause: async () => {
            await this.command('pause');
          },
          resume: async () => {
            await this.command('resume');
          },
          goHome: async () => {
            await this.command('dock');
          },
        },
      },
    };
  }

  toAccessory(): MatterAccessoryLike {
    return this.accessory;
  }

  get uuid(): string {
    return this.accessory.UUID;
  }

  get deviceName(): string {
    return this.device.name;
  }

  async markUnavailable(): Promise<void> {
    // Keep the last run mode; missing telemetry is not evidence that a task ended.
    await this.matterApi.updateAccessoryState(this.uuid, 'powerSource', {
      status: 0, batPercentRemaining: null, batChargeState: 0,
    });
    await this.matterApi.updateAccessoryState(this.uuid, 'rvcOperationalState', {
      operationalState: 3,
      operationalError: { errorStateId: 2, errorStateDetails: 'Mower telemetry unavailable' },
    });
  }

  async updateState(nextState: MammotionState): Promise<void> {
    // A paused task remains in Cleaning run mode; Idle means the task ended.
    const runMode = this.isWorking(nextState) || this.isPaused(nextState) ? 1 : 0;
    const operationalState = this.toOperationalState(nextState);

    await this.matterApi.updateAccessoryState(this.uuid, 'powerSource', {
      status: nextState.online ? 1 : 0,
      batPercentRemaining: nextState.online ? Math.round(nextState.battery * 2) : null,
      batChargeLevel: nextState.battery <= 5 ? 2 : nextState.battery <= 20 ? 1 : 0,
      batChargeState: !nextState.online ? 0 : nextState.chargeState === 0 ? 3 : nextState.battery >= 100 ? 2 : 1,
    });

    await this.matterApi.updateAccessoryState(this.uuid, 'rvcRunMode', {
      currentMode: runMode,
    });

    await this.matterApi.updateAccessoryState(this.uuid, 'rvcOperationalState', {
      operationalState,
      operationalError: this.operationalError(nextState),
    });
  }

  private batteryDeviceType(): unknown {
    const deviceType = this.matterApi.deviceTypes.RoboticVacuumCleaner as Composable;
    const powerSource = this.matterApi.deviceRequirements?.PowerSource.PowerSourceServer as Composable | undefined;
    // Declare the behavior in the type too: cache restore must detect this
    // structural upgrade, rather than reusing an endpoint without a battery.
    return typeof powerSource?.with === 'function' && typeof deviceType?.with === 'function'
      ? deviceType.with(powerSource.with('Battery', 'Rechargeable'))
      : deviceType;
  }

  private async command(action: MammotionAction): Promise<void> {
    const state = await this.client.command(this.device.name, action);
    if (state) {
      await this.updateState(state);
    }
  }

  private operationalError(state: MammotionState): Record<string, unknown> {
    if (!state.online) {
      return { errorStateId: 3, errorStateDetails: 'Mower is offline' };
    }
    if (state.hasError) {
      return { errorStateId: 2, errorStateDetails: 'Check the Mammotion app for the mower fault' };
    }
    return { errorStateId: 0 };
  }

  private toOperationalState(state: MammotionState): number {
    if (!state.online || state.hasError) {
      return 3;
    }

    if (this.isWorking(state)) {
      return 1;
    }

    if (this.isPaused(state)) {
      return 2;
    }

    if (this.isReturning(state)) {
      return 64;
    }

    if (state.chargeState !== 0) {
      return state.battery >= 100 ? 66 : 65;
    }

    return 0;
  }

  logReady(): void {
    this.log.info(`Matter RVC ready for ${this.device.name}`);
  }

  private isWorking(state: MammotionState): boolean {
    return state.sysStatus === 13
      || state.modeName === 'MODE_WORKING'
      || state.modeName.endsWith('WORKING');
  }

  private isPaused(state: MammotionState): boolean {
    return state.sysStatus === 19
      || state.modeName === 'MODE_PAUSE'
      || state.modeName.endsWith('PAUSE');
  }

  private isReturning(state: MammotionState): boolean {
    return state.sysStatus === 14
      || state.modeName === 'MODE_RETURNING'
      || state.modeName.endsWith('RETURNING');
  }
}

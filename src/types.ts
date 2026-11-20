export interface MammotionPlatformConfig {
  platform: string;
  name?: string;
  // Retained as an identity seed for existing Apple Home pairings, not login.
  email?: string;
  apiCredentialsPath: string;
  pollIntervalSeconds?: number;
  deviceFilter?: string[];
  offCommand?: 'pause' | 'dock' | 'cancel';
  enableMatterRvc?: boolean;
}

export interface MammotionDeviceInfo {
  name: string;
  model?: string;
  serialNumber?: string;
}

export interface MammotionState {
  name: string;
  online: boolean;
  battery: number;
  chargeState: number;
  firmwareVersion?: string;
  sysStatus: number;
  modeName: string;
  hasError: boolean;
}

export type MammotionAction = 'start' | 'resume' | 'pause' | 'dock' | 'cancel';

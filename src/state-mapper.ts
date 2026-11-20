import type { MammotionState } from './types';

type OfficialState = { online: number; status: string; batteryLevel: number; chargeStatus?: number; version?: string };

export class MammotionStateError extends Error {}

export function mapOfficialState(name: string, value: unknown): MammotionState {
  const detail = value as Partial<OfficialState> | null;
  if (!detail || ![0, 1].includes(detail.online ?? -1) || typeof detail.status !== 'string'
    || !Number.isFinite(detail.batteryLevel) || Number(detail.batteryLevel) < 0 || Number(detail.batteryLevel) > 100
    || (detail.chargeStatus !== undefined && !Number.isFinite(detail.chargeStatus))) {
    throw new MammotionStateError('Mammotion telemetry unavailable: official API returned incomplete or invalid mower status');
  }
  const status = detail.status.toLowerCase().replace(/[^a-z]/g, '');
  const modes: Record<string, readonly [number, string]> = { working: [13, 'MODE_WORKING'], mowing: [13, 'MODE_WORKING'], paused: [19, 'MODE_PAUSE'], taskpaused: [19, 'MODE_PAUSE'],
    returning: [14, 'MODE_RETURNING'], standby: [0, 'MODE_IDLE'], offline: [0, 'MODE_IDLE'],
    mapping: [0, 'MODE_MAPPING'], updating: [0, 'MODE_UPDATING'], abnormal: [17, 'MODE_LOCK'] };
  const mode = modes[status];
  return {
    name, online: detail.online === 1 && status !== 'offline', battery: Number(detail.batteryLevel),
    // Keep the provider's charge-state number, as the original bridge did. The
    // live API returns 5 on our docked mower despite the schema listing 0/1.
    chargeState: detail.chargeStatus ?? 0,
    firmwareVersion: typeof detail.version === 'string' ? detail.version : undefined,
    sysStatus: mode?.[0] ?? 17, modeName: mode?.[1] ?? 'MODE_UNKNOWN',
    hasError: status === 'abnormal' || mode === undefined,
  };
}

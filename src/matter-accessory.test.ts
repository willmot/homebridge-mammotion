import type { Logger } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';
import { MammotionMatterVacuum } from './matter-accessory';
import type { MammotionClient } from './mammotion-client';
import type { MammotionState } from './types';

const device = { name: 'fixture-mower', iotId: 'fixture-id', serialNumber: 'fixture-serial', model: 'LUBA 3 AWD' };
const state: MammotionState = { name: device.name, online: true, battery: 80, chargeState: 0,
  sysStatus: 0, modeName: 'MODE_IDLE', hasError: false };
function accessory() {
  const matter = { uuid: { generate: vi.fn(seed => seed) }, deviceTypes: { RoboticVacuumCleaner: 1 }, updateAccessoryState: vi.fn().mockResolvedValue(undefined) };
  const command = vi.fn().mockResolvedValue(state);
  const handler = new MammotionMatterVacuum(matter, {} as Logger, device, { command } as unknown as MammotionClient, 'fixture-namespace');
  return { handler, matter, command };
}

describe('existing Apple Home Matter contract', () => {
  it('preserves the UUID, serial and supported clusters', () => {
    const { handler, matter } = accessory();
    expect(matter.uuid.generate).toHaveBeenCalledWith('mammotion-rvc:fixture-namespace:fixture-mower');
    expect(handler.toAccessory().serialNumber).toBe('fixture-serial');
    expect(handler.toAccessory().clusters).not.toHaveProperty('rvcCleanMode');
    expect(handler.toAccessory().clusters).toHaveProperty('rvcRunMode.supportedModes');
  });
  it.each([
    [{ sysStatus: 13, modeName: 'MODE_WORKING' }, 1],
    [{ sysStatus: 19, modeName: 'MODE_PAUSE' }, 2],
    [{ sysStatus: 14, modeName: 'MODE_RETURNING' }, 64],
    [{ chargeState: 1 }, 65],
    [{ chargeState: 5, battery: 100 }, 66],
    [{ online: false }, 3],
    [{ hasError: true, sysStatus: 13 }, 3],
  ])('continues mapping mower state %j to Matter state %s', async (update, expected) => {
    const { handler, matter, command } = accessory();
    await handler.updateState({ ...state, ...update });
    expect(matter.updateAccessoryState).toHaveBeenLastCalledWith(handler.uuid, 'rvcOperationalState', expect.objectContaining({ operationalState: expected }));
    expect(command).not.toHaveBeenCalled();
  });
});


describe('native battery and command controls', () => {
  it.each([
    [{ battery: 98, chargeState: 2 }, { batPercentRemaining: 196, batChargeLevel: 0, batChargeState: 1, status: 1 }],
    [{ battery: 100, chargeState: 5 }, { batPercentRemaining: 200, batChargeLevel: 0, batChargeState: 2 }],
    [{ battery: 20, chargeState: 0 }, { batPercentRemaining: 40, batChargeLevel: 1, batChargeState: 3 }],
    [{ battery: 5 }, { batPercentRemaining: 10, batChargeLevel: 2 }],
    [{ online: false }, { batPercentRemaining: null, batChargeState: 0, status: 0 }],
  ])('reports battery and charging state from telemetry %j', async (update, expected) => {
    const { handler, matter } = accessory();
    await handler.updateState({ ...state, ...update });
    expect(matter.updateAccessoryState).toHaveBeenCalledWith(handler.uuid, 'powerSource', expect.objectContaining(expected));
  });

  it('retains Cleaning run mode while paused so Resume remains available', async () => {
    const { handler, matter } = accessory();
    await handler.updateState({ ...state, sysStatus: 19, modeName: 'MODE_PAUSE' });
    expect(matter.updateAccessoryState).toHaveBeenCalledWith(handler.uuid, 'rvcRunMode', { currentMode: 1 });
    expect(matter.updateAccessoryState).toHaveBeenCalledWith(handler.uuid, 'rvcOperationalState', {
      operationalState: 2, operationalError: { errorStateId: 0 },
    });
  });

  it('distinguishes offline from device faults and clears errors on recovery', async () => {
    const { handler, matter } = accessory();
    await handler.updateState({ ...state, online: false });
    expect(matter.updateAccessoryState).toHaveBeenLastCalledWith(handler.uuid, 'rvcOperationalState', {
      operationalState: 3, operationalError: { errorStateId: 3, errorStateDetails: 'Mower is offline' },
    });
    await handler.updateState({ ...state, hasError: true });
    expect(matter.updateAccessoryState).toHaveBeenLastCalledWith(handler.uuid, 'rvcOperationalState', {
      operationalState: 3, operationalError: { errorStateId: 2, errorStateDetails: 'Check the Mammotion app for the mower fault' },
    });
    await handler.updateState(state);
    expect(matter.updateAccessoryState).toHaveBeenLastCalledWith(handler.uuid, 'rvcOperationalState', {
      operationalState: 0, operationalError: { errorStateId: 0 },
    });
  });

  it('uses explicit Resume and Stop commands and validates modes before sending commands', async () => {
    const { handler, command, matter } = accessory();
    const handlers = handler.toAccessory().handlers as {
      rvcRunMode: { changeToMode: (request: { newMode: number }) => Promise<void> };
      rvcOperationalState: { resume: () => Promise<void> };
    };
    await handlers.rvcOperationalState.resume();
    await handlers.rvcRunMode.changeToMode({ newMode: 0 });
    expect(command.mock.calls).toEqual([[device.name, 'resume'], [device.name, 'cancel']]);
    expect(matter.updateAccessoryState).toHaveBeenCalled();
    await expect(handlers.rvcRunMode.changeToMode({ newMode: 99 })).rejects.toThrow('Unsupported');
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('keeps command failures visible without changing state or replaying', async () => {
    const { handler, command, matter } = accessory();
    command.mockRejectedValueOnce(new Error('Mower rejected Pause'));
    const handlers = handler.toAccessory().handlers as { rvcOperationalState: { pause: () => Promise<void> } };
    await expect(handlers.rvcOperationalState.pause()).rejects.toThrow('rejected Pause');
    expect(command).toHaveBeenCalledOnce();
    expect(matter.updateAccessoryState).not.toHaveBeenCalled();
  });
});

it('publishes unknown telemetry without claiming that a working task stopped', async () => {
  const { handler, matter, command } = accessory();
  expect(handler.toAccessory().clusters.rvcOperationalState).toMatchObject({ operationalState: 3 });
  await handler.updateState({ ...state, modeName: 'MODE_WORKING', sysStatus: 13 });
  matter.updateAccessoryState.mockClear();
  await handler.markUnavailable();
  expect(matter.updateAccessoryState).not.toHaveBeenCalledWith(expect.anything(), 'rvcRunMode', expect.anything());
  expect(matter.updateAccessoryState).toHaveBeenCalledWith(handler.uuid, 'powerSource', {
    status: 0, batPercentRemaining: null, batChargeState: 0,
  });
  expect(matter.updateAccessoryState).toHaveBeenLastCalledWith(handler.uuid, 'rvcOperationalState', {
    operationalState: 3, operationalError: { errorStateId: 2, errorStateDetails: 'Mower telemetry unavailable' },
  });
  expect(command).not.toHaveBeenCalled();
});

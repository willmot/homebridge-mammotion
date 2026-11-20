import { EventEmitter } from 'node:events';
import type { API, Logger } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./mammotion-client', async original => ({ ...await original<typeof import('./mammotion-client')>(), MammotionClient: vi.fn() }));
import { MammotionApiError, MammotionClient } from './mammotion-client';
import { MammotionStateError } from './state-mapper';
import { MammotionPlatform } from './platform';

const config = { platform: 'Mammotion', name: 'Mammotion', email: 'test@example.com', apiCredentialsPath: '/fixture/private.env' };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
let client: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; discoverDevices: ReturnType<typeof vi.fn>; pollStates: ReturnType<typeof vi.fn> };
let api: EventEmitter & { hap: unknown; matter: { uuid: { generate: ReturnType<typeof vi.fn> }; deviceTypes: unknown; updateAccessoryState: ReturnType<typeof vi.fn>; registerPlatformAccessories: ReturnType<typeof vi.fn>; unregisterPlatformAccessories: ReturnType<typeof vi.fn> } };

async function launch() {
  const platform = new MammotionPlatform(log, config, api as unknown as API);
  api.emit('didFinishLaunching');
  await vi.advanceTimersByTimeAsync(0);
  return platform;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  client = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
    discoverDevices: vi.fn().mockResolvedValue([{ name: 'fixture-mower', serialNumber: 'fixture-serial' }]), pollStates: vi.fn().mockResolvedValue([]) };
  vi.mocked(MammotionClient).mockImplementation(function () { return client as unknown as MammotionClient; });
  api = Object.assign(new EventEmitter(), { hap: {}, matter: {
    uuid: { generate: vi.fn(seed => seed) }, deviceTypes: { RoboticVacuumCleaner: 1 },
    updateAccessoryState: vi.fn().mockResolvedValue(undefined), registerPlatformAccessories: vi.fn().mockResolvedValue(undefined), unregisterPlatformAccessories: vi.fn().mockResolvedValue(undefined),
  } });
});
afterEach(() => vi.useRealTimers());

describe('official API polling and pairing preservation', () => {
  it('preserves the original account-derived Matter identity', async () => {
    await launch();
    expect(api.matter.uuid.generate).toHaveBeenCalledWith('mammotion-rvc:Mammotion|test@example.com|Mammotion:fixture-mower');
    expect(api.matter.registerPlatformAccessories).toHaveBeenCalledOnce();
  });
  it('retries failed startup with increasing backoff', async () => {
    client.start.mockRejectedValue(new Error('authorization failed'));
    await launch(); await vi.advanceTimersByTimeAsync(10_000);
    expect(client.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(client.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.start).toHaveBeenCalledTimes(3);
  });
  it('cancels pending recovery on shutdown', async () => {
    client.start.mockRejectedValue(new Error('authorization failed'));
    await launch(); api.emit('shutdown');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.start).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not register anything if shutdown happens during startup', async () => {
    let finish!: () => void;
    client.start.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    await launch(); api.emit('shutdown'); finish(); await vi.advanceTimersByTimeAsync(0);
    expect(client.discoverDevices).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for a slow poll before scheduling another', async () => {
    await launch();
    let finish!: (states: unknown[]) => void;
    client.pollStates.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(15_000); await vi.advanceTimersByTimeAsync(90_000);
    expect(client.pollStates).toHaveBeenCalledTimes(2);
    finish([]); await vi.advanceTimersByTimeAsync(15_000);
    expect(client.pollStates).toHaveBeenCalledTimes(3);
  });
  it('honors rate-limit delays without rediscovering or removing paired accessories', async () => {
    await launch();
    client.pollStates.mockRejectedValueOnce(new MammotionApiError('rate limit', 120_000));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(client.pollStates).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.pollStates).toHaveBeenCalledTimes(3);
    expect(client.discoverDevices).toHaveBeenCalledOnce();
    expect(api.matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
  });
  it('retains cached Matter accessories on empty initial cloud discovery', async () => {
    client.discoverDevices.mockResolvedValueOnce([]);
    const platform = new MammotionPlatform(log, config, api as unknown as API);
    platform.configureMatterAccessory({ UUID: 'mammotion-rvc:Mammotion|test@example.com|Mammotion:fixture-mower' });
    api.emit('didFinishLaunching'); await vi.advanceTimersByTimeAsync(0);
    expect(api.matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.matter.registerPlatformAccessories).toHaveBeenCalledOnce();
    expect(api.matter.registerPlatformAccessories.mock.calls[0][2][0].UUID).toBe('mammotion-rvc:Mammotion|test@example.com|Mammotion:fixture-mower');
    expect(client.discoverDevices).toHaveBeenCalledTimes(2);
  });

  it('drops a stale Matter accessory from the cache after unregistering it', async () => {
    const platform = new MammotionPlatform(log, config, api as unknown as API);
    const staleAccessory = { UUID: 'stale-mower' };
    platform.configureMatterAccessory(staleAccessory);

    api.emit('didFinishLaunching');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.matter.unregisterPlatformAccessories).toHaveBeenCalledWith(
      'homebridge-mammotion', 'Mammotion', [staleAccessory],
    );

    await platform['discoverAndSyncMatterAccessories']();
    expect(api.matter.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
  });
});

it('invalidates stale Matter state and recovers without authentication, registration or commands', async () => {
  await launch();
  client.pollStates.mockRejectedValueOnce(new MammotionStateError('Mammotion telemetry unavailable'));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(expect.any(String), 'powerSource', {
    status: 0, batPercentRemaining: null, batChargeState: 0,
  });
  expect(api.matter.updateAccessoryState).toHaveBeenLastCalledWith(expect.any(String), 'rvcOperationalState', {
    operationalState: 3, operationalError: { errorStateId: 2, errorStateDetails: 'Mower telemetry unavailable' },
  });
  client.pollStates.mockResolvedValueOnce([{ name: 'fixture-mower', online: true, battery: 82, chargeState: 5,
    sysStatus: 0, modeName: 'MODE_IDLE', hasError: false }]);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(api.matter.updateAccessoryState).toHaveBeenLastCalledWith(expect.any(String), 'rvcOperationalState', {
    operationalState: 65, operationalError: { errorStateId: 0 },
  });
  expect(client.start).toHaveBeenCalledOnce();
  expect(client.stop).not.toHaveBeenCalled();
  expect(api.matter.registerPlatformAccessories).toHaveBeenCalledOnce();
});

it('keeps initial incomplete telemetry in the polling backoff path without repeated logins', async () => {
  client.pollStates.mockRejectedValue(new MammotionStateError('Mammotion telemetry unavailable'));
  await launch();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(client.pollStates).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(client.pollStates).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(client.pollStates).toHaveBeenCalledTimes(3);
  expect(client.start).toHaveBeenCalledOnce();
  expect(client.stop).not.toHaveBeenCalled();
  api.emit('shutdown');
  await vi.advanceTimersByTimeAsync(600_000);
  expect(client.pollStates).toHaveBeenCalledTimes(3);
});

it('does not publish unavailable state after shutdown cancels an in-flight poll', async () => {
  await launch();
  let fail!: (error: Error) => void;
  client.pollStates.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
  await vi.advanceTimersByTimeAsync(15_000);
  api.emit('shutdown');
  fail(new MammotionApiError('request aborted'));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.matter.updateAccessoryState).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { expect, it, vi } from 'vitest';
import { MammotionAccessory } from '../src/accessory';
import type { MammotionClient } from '../src/mammotion-client';
import type { MammotionPlatform } from '../src/platform';

it('HAP reads fail while telemetry is unavailable and recover after a valid update', async () => {
  const hap = { Service, Characteristic, HAPStatus, HapStatusError };
  const platform = { ...hap, api: { hap }, config: {} } as unknown as MammotionPlatform;
  const accessory = Object.assign(new Accessory('fixture', uuid.generate('fixture')), { context: { deviceName: 'fixture' } });
  const command = vi.fn();
  const handler = new MammotionAccessory(platform, accessory as unknown as PlatformAccessory<{ deviceName: string }>,
    { name: 'fixture' }, { command } as unknown as MammotionClient);
  const on = accessory.getService(Service.Switch)!.getCharacteristic(Characteristic.On);
  const battery = accessory.getService(Service.Battery)!.getCharacteristic(Characteristic.BatteryLevel);
  await expect(on.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  handler.updateState({ name: 'fixture', online: true, battery: 80, chargeState: 0,
    sysStatus: 13, modeName: 'MODE_WORKING', hasError: false });
  await expect(on.handleGetRequest()).resolves.toBe(true);
  handler.markUnavailable();
  await expect(on.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  await expect(battery.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  handler.updateState({ name: 'fixture', online: true, battery: 79, chargeState: 0,
    sysStatus: 13, modeName: 'MODE_WORKING', hasError: false });
  await expect(on.handleGetRequest()).resolves.toBe(true);
  await expect(battery.handleGetRequest()).resolves.toBe(79);
  expect(command).not.toHaveBeenCalled();
});

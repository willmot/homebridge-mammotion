import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, it, vi } from 'vitest';
import { MammotionMatterVacuum } from '../src/matter-accessory';

// Exercise Homebridge's real behavior/registry path, including cache restore.
// Every mower command is a spy; networking is entirely simulated.
const { Environment, Network, NetworkSimulator, Logger } = await import('@matter/main');
const { PowerSourceServer } = await import('@matter/main/behaviors/power-source');
const { RoboticVacuumCleanerDevice } = await import('@matter/main/devices/robotic-vacuum-cleaner');
const { MatterServer } = await import(pathToFileURL(join(process.cwd(), 'node_modules/homebridge/dist/matter/server.js')).href);
const { User } = await import(pathToFileURL(join(process.cwd(), 'node_modules/homebridge/dist/user.js')).href);
const instanceRoot = mkdtempSync(join(tmpdir(), 'mammotion-test-instance-'));
User.setStoragePath(instanceRoot);
afterAll(() => rmSync(instanceRoot, { recursive: true, force: true }));

function definition(command, battery = true, updateAccessoryState = vi.fn()) {
  const accessory = new MammotionMatterVacuum({
    deviceRequirements: { PowerSource: { PowerSourceServer } },
    uuid: { generate: () => '00000000-0000-4000-8000-000000000001' },
    deviceTypes: { RoboticVacuumCleaner: RoboticVacuumCleanerDevice }, updateAccessoryState,
  }, {}, { name: 'Luba-fixture', serialNumber: 'fixture' }, { command }, 'fixture').toAccessory();
  if (!battery) {
    accessory.deviceType = RoboticVacuumCleanerDevice;
    delete accessory.clusters.powerSource;
  }
  return accessory;
}
async function open(storagePath) {
  Environment.default.set(Network, new NetworkSimulator().addHost(1));
  const server = new MatterServer({ port: 5540, uniqueId: 'AABBCCDDEE01', storagePath,
    displayName: 'Fixture mower', serialNumber: 'fixture', externalAccessory: true, debugModeEnabled: false, networkInterfaces: ['fake0'] });
  Logger.level = 'fatal';
  await server.start();
  expect(server.serverNode.lifecycle.isOnline).toBe(false);
  return server;
}

it('routes Matter Start, Pause and Return to the plugin without physical commands', async () => {
  const temp = mkdtempSync(join(instanceRoot, 'mammotion-routing-'));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  let server;
  try {
    server = await open(temp);
    const command = vi.fn().mockResolvedValue(undefined);
    const accessory = definition(command);
    await server.registerPlatformAccessories('homebridge-mammotion', 'ExternalMatter', [accessory]);
    const endpoint = server.accessories.get(accessory.UUID).endpoint;
    await endpoint.act(agent => agent.rvcRunMode.changeToMode({ newMode: 1 }));
    await endpoint.act(agent => agent.rvcOperationalState.pause());
    await endpoint.act(agent => agent.rvcOperationalState.resume());
    await endpoint.act(agent => agent.rvcRunMode.changeToMode({ newMode: 0 }));
    await endpoint.act(agent => agent.rvcOperationalState.goHome());
    expect(command.mock.calls).toEqual([['Luba-fixture', 'start'], ['Luba-fixture', 'pause'], ['Luba-fixture', 'resume'], ['Luba-fixture', 'cancel'], ['Luba-fixture', 'dock']]);
  } finally {
    await server?.stop(); output.mockRestore(); rmSync(temp, { recursive: true, force: true });
  }
});

it('rebinds commands after a standalone-server restart while retaining node and accessory IDs', async () => {
  const temp = mkdtempSync(join(instanceRoot, 'mammotion-restored-routing-'));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  let first, second;
  try {
    const oldCommand = vi.fn().mockResolvedValue(undefined);
    const original = definition(oldCommand, false);
    first = await open(temp);
    await first.registerPlatformAccessories('homebridge-mammotion', 'ExternalMatter', [original]);
    const originalNumber = first.accessories.get(original.UUID).endpoint.number;
    const nodeIdentity = { username: first.username, uniqueId: first.serverNode.state.basicInformation.uniqueId };
    await first.accessoryCache.save(first.accessories);
    expect((await first.accessoryCache.load()).has(original.UUID)).toBe(true);
    await first.stop(); first = undefined;
    second = await open(temp);
    const currentCommand = vi.fn().mockResolvedValue(undefined);
    await second.registerPlatformAccessories('homebridge-mammotion', 'ExternalMatter', [definition(currentCommand)]);
    const endpoint = second.accessories.get(original.UUID).endpoint;
    expect({ username: second.username, uniqueId: second.serverNode.state.basicInformation.uniqueId }).toEqual(nodeIdentity);
    expect(second.accessories.get(original.UUID).serialNumber).toBe('fixture');
    expect(endpoint.number).toBe(originalNumber);
    expect(endpoint.behaviors.has('powerSource')).toBe(true);
    expect(endpoint.state.powerSource.batChargeState).toBe(0);
    expect(endpoint.state.powerSource.endpointList).toEqual([Number(endpoint.number)]);
    expect(endpoint.state.descriptor.deviceTypeList.some(type => type.deviceType === 0x11)).toBe(true);
    await endpoint.act(agent => agent.rvcRunMode.changeToMode({ newMode: 1 }));
    expect(currentCommand).toHaveBeenCalledWith('Luba-fixture', 'start');
    expect(oldCommand).not.toHaveBeenCalled();
  } finally {
    await first?.stop(); await second?.stop(); output.mockRestore(); rmSync(temp, { recursive: true, force: true });
  }
});


it('updates real native battery, paused/resumed and fault states through command handlers', async () => {
  const temp = mkdtempSync(join(instanceRoot, 'mammotion-states-'));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  let server;
  try {
    server = await open(temp);
    const state = { name: 'Luba-fixture', online: true, battery: 73, chargeState: 0,
      sysStatus: 13, modeName: 'MODE_WORKING', hasError: false };
    const command = vi.fn().mockResolvedValue(state);
    const accessory = definition(command, true, (...args) => server.updateAccessoryState(...args));
    await server.registerPlatformAccessories('homebridge-mammotion', 'ExternalMatter', [accessory]);
    const endpoint = server.accessories.get(accessory.UUID).endpoint;
    await endpoint.act(agent => agent.rvcRunMode.changeToMode({ newMode: 1 }));
    expect(endpoint.state.rvcOperationalState.operationalState).toBe(1);
    expect(endpoint.state.powerSource.batPercentRemaining).toBe(146);
    expect(endpoint.state.powerSource.batChargeState).toBe(3);
    command.mockResolvedValueOnce({ ...state, sysStatus: 19, modeName: 'MODE_PAUSE' });
    await endpoint.act(agent => agent.rvcOperationalState.pause());
    expect(endpoint.state.rvcOperationalState.operationalState).toBe(2);
    expect(endpoint.state.rvcRunMode.currentMode).toBe(1);
    await endpoint.act(agent => agent.rvcOperationalState.resume());
    expect(endpoint.state.rvcOperationalState.operationalState).toBe(1);
    command.mockResolvedValueOnce({ ...state, hasError: true });
    await endpoint.act(agent => agent.rvcOperationalState.pause());
    expect(endpoint.state.rvcOperationalState.operationalState).toBe(3);
    expect(endpoint.state.rvcOperationalState.operationalError.errorStateId).toBe(2);
    await endpoint.act(agent => agent.rvcOperationalState.resume());
    expect(endpoint.state.rvcOperationalState.operationalState).toBe(1);
    expect(endpoint.state.rvcOperationalState.operationalError.errorStateId).toBe(0);
  } finally {
    await server?.stop(); output.mockRestore(); rmSync(temp, { recursive: true, force: true });
  }
});

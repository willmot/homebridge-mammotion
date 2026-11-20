import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { MammotionMatterVacuum } from '../src/matter-accessory';

// Use the actual Matter SDK bundled with the Homebridge development dependency.
// Endpoints use an offline test node, simulated networking and temporary storage.
// The node is never started or commissioned.
const requireSdk = createRequire(join(process.cwd(), 'package.json'));
const { Endpoint, ServerNode, Environment, Network, NetworkSimulator, Logger } = requireSdk('@matter/main');
const { RoboticVacuumCleanerDevice } = requireSdk('@matter/main/devices/robotic-vacuum-cleaner');
const { PowerSourceServer } = requireSdk('@matter/main/behaviors/power-source');
const { RvcCleanModeServer } = requireSdk('@matter/main/behaviors/rvc-clean-mode');

async function withOfflineNode(check) {
  const storagePath = mkdtempSync(join(tmpdir(), 'mammotion-matter-test-'));
  Environment.default.set(Network, new NetworkSimulator().addHost(1));
  Logger.level = 'fatal';
  const environment = new Environment('mammotion-offline-test', Environment.default);
  environment.vars.set('storage.path', storagePath);
  const server = await ServerNode.create({ id: 'fixture-node', environment });
  try {
    await check(server);
    expect(server.lifecycle.isOnline).toBe(false);
  } finally {
    await server.close();
    rmSync(storagePath, { recursive: true, force: true });
  }
}

function definition() {
  return new MammotionMatterVacuum({
    uuid: { generate: seed => seed }, deviceRequirements: { PowerSource: { PowerSourceServer } }, deviceTypes: { RoboticVacuumCleaner: RoboticVacuumCleanerDevice },
    updateAccessoryState: vi.fn(),
  }, {}, { name: 'fixture-mower', iotId: 'fixture-id' }, {}, 'fixture').toAccessory();
}

it('constructs our RVC endpoint with the actual Matter SDK without commissioning', async () => {
  const endpoint = new Endpoint(definition().deviceType, { id: 'fixture-rvc', ...definition().clusters });
  await withOfflineNode(async server => {
    await server.add(endpoint);
    expect(endpoint.state.rvcRunMode.supportedModes).toHaveLength(2);
    expect(endpoint.state.powerSource.batPercentRemaining).toBeNull();
  });
});

it('reproduces the old single-clean-mode registration failure', async () => {
  const endpoint = new Endpoint(RoboticVacuumCleanerDevice.with(RvcCleanModeServer), {
    id: 'fixture-invalid-rvc',
    ...definition().clusters,
    rvcCleanMode: { supportedModes: [{ label: 'Vacuum', mode: 0, modeTags: [{ value: 16385 }] }], currentMode: 0 },
  });
  await withOfflineNode(async server => {
    const failure = await server.add(endpoint).then(() => undefined, error => error);
    const messages = error => [error?.message ?? '', ...(error?.errors ?? []).flatMap(messages), ...(error?.cause ? messages(error.cause) : [])];
    expect(messages(failure).join(' ')).toMatch(/supportedModes|at least 2/i);
  });
});

it('the actual Matter endpoint accepts unavailable telemetry and later clears it on recovery', async () => {
  let endpoint;
  const handler = new MammotionMatterVacuum({
    uuid: { generate: seed => seed }, deviceRequirements: { PowerSource: { PowerSourceServer } },
    deviceTypes: { RoboticVacuumCleaner: RoboticVacuumCleanerDevice },
    updateAccessoryState: async (_uuid, cluster, attributes) => endpoint.set({ [cluster]: attributes }),
  }, {}, { name: 'fixture-mower' }, {}, 'fixture');
  const accessory = handler.toAccessory();
  endpoint = new Endpoint(accessory.deviceType, { id: 'fixture-telemetry', ...accessory.clusters });
  await withOfflineNode(async server => {
    await server.add(endpoint);
    const state = { name: 'fixture-mower', online: true, battery: 80, chargeState: 0,
      sysStatus: 13, modeName: 'MODE_WORKING', hasError: false };
    await handler.updateState(state);
    await handler.markUnavailable();
    expect(endpoint.state.powerSource.batPercentRemaining).toBeNull();
    expect(endpoint.state.rvcRunMode.currentMode).toBe(1);
    expect(endpoint.state.rvcOperationalState.operationalState).toBe(3);
    expect(endpoint.state.rvcOperationalState.operationalError.errorStateId).toBe(2);
    await handler.updateState(state);
    expect(endpoint.state.powerSource.batPercentRemaining).toBe(160);
    expect(endpoint.state.rvcOperationalState.operationalState).toBe(1);
    expect(endpoint.state.rvcOperationalState.operationalError.errorStateId).toBe(0);
  });
});

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
const { probeOfficialApi } = createRequire(join(process.cwd(), 'package.json'))('./scripts/probe-official-api.js') as {
  probeOfficialApi: (path?: string) => Promise<unknown>;
};
it('requires a credentials file', async () => {
  await expect(probeOfficialApi()).rejects.toThrow('Usage');
});
it('runs the real compiled client with only authorization and read requests, omitting private IDs', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'mammotion-probe-'));
  const file = join(temp, 'private.env');
  writeFileSync(file, 'MAMMOTION_CLIENT_ID=private-client\nMAMMOTION_CLIENT_SECRET=private-secret\n', { mode: 0o600 });
  const reply = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
  const fetchApi = vi.fn().mockResolvedValueOnce(reply({ access_token: 'private-token', expires_in: 3600 }))
    .mockResolvedValueOnce(reply([{ id: 'private-id', name: 'private-name', model: 'LUBA 3 AWD' }]))
    .mockResolvedValueOnce(reply({ online: 1, status: 'Standby', batteryLevel: 100, chargeStatus: 5, version: '2.3.35.12' }));
  vi.stubGlobal('fetch', fetchApi);
  try {
    const result = await probeOfficialApi(file);
    expect(result).toMatchObject({ readOnly: true, mowerCount: 1, mowers: [{ model: 'LUBA 3 AWD', firmware: '2.3.35.12', online: true, battery: 100 }] });
    expect(fetchApi.mock.calls.map(([url, options]) => [url, options.method ?? 'GET'])).toEqual([
      ['https://id.mammotion.com/oauth2/token', 'POST'], ['https://api-open.mammotion.com/v1/mowers', 'GET'],
      ['https://api-open.mammotion.com/v1/mower/private-id', 'GET'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private-/);
  } finally { vi.unstubAllGlobals(); rmSync(temp, { recursive: true, force: true }); }
});

import type { Logger } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readFile = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({ readFile }));
import { MammotionClient, MammotionApiError } from './mammotion-client';

const config = { platform: 'Mammotion', apiCredentialsPath: '/private/fixture.env' };
const log = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
const mower = { id: 'private/device-id', name: 'Luba-fixture', model: 'LUBA 3 AWD' };
const detail = { online: 1, status: 'Standby', batteryLevel: 100, chargeStatus: 5 };
const fetchApi = vi.fn();
const token = () => new Response(JSON.stringify({ code: 0, data: { access_token: 'private-token', expires_in: 3600 } }));
const response = (data: unknown, code = 0) => new Response(JSON.stringify({ code, data }));
let client: MammotionClient;
async function start() {
  fetchApi.mockResolvedValueOnce(token()).mockResolvedValueOnce(response([mower]));
  await client.start();
}

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('fetch', fetchApi);
  readFile.mockResolvedValue('MAMMOTION_CLIENT_ID="private-client"\nMAMMOTION_CLIENT_SECRET="private-secret"\n');
  client = new MammotionClient(log, config);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('official API authentication and identity', () => {
  it('loads private file credentials and keeps mower name and serial separate from API ID', async () => {
    await start();
    expect(readFile).toHaveBeenCalledWith('/private/fixture.env', 'utf8');
    await expect(client.discoverDevices()).resolves.toEqual([{ name: 'Luba-fixture', serialNumber: 'fixture', model: 'LUBA 3 AWD' }]);
    expect(fetchApi.mock.calls[0][1].body.get('grant_type')).toBe('client_credentials');
    expect(fetchApi.mock.calls.every(([, options]) => options.redirect === 'error')).toBe(true);
  });
  it('reuses the token for multiple reads and renews before expiry', async () => {
    await start();
    fetchApi.mockResolvedValueOnce(response(detail)).mockResolvedValueOnce(response(detail));
    await client.pollStates(); await client.pollStates();
    expect(fetchApi).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(3_571_000);
    fetchApi.mockResolvedValueOnce(token()).mockResolvedValueOnce(response(detail));
    await client.pollStates();
    expect(fetchApi.mock.calls.filter(([url]) => url.includes('/oauth2/'))).toHaveLength(2);
  });
  it('refreshes on 401 and retries a read only once', async () => {
    await start();
    fetchApi.mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(token()).mockResolvedValueOnce(response(detail));
    await expect(client.pollStates()).resolves.toMatchObject([{ online: true, battery: 100 }]);
    expect(fetchApi.mock.calls.filter(([url]) => url.includes('/oauth2/'))).toHaveLength(2);
  });
  it('does not loop on repeated 401 responses', async () => {
    await start();
    fetchApi.mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(client.pollStates()).rejects.toThrow('HTTP 401');
    expect(fetchApi).toHaveBeenCalledTimes(5);
  });
  it('filters device requests using the existing device names', async () => {
    client = new MammotionClient(log, { ...config, deviceFilter: ['another-mower'] });
    await start();
    await expect(client.pollStates()).resolves.toEqual([]);
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });
  it('rejects missing credentials before calling the cloud', async () => {
    readFile.mockResolvedValue('MAMMOTION_CLIENT_ID=fixture');
    await expect(client.start()).rejects.toThrow('MAMMOTION_CLIENT_SECRET');
    expect(fetchApi).not.toHaveBeenCalled();
  });
});

describe('native mower commands', () => {
  it.each([['start', 'CMD_START'], ['resume', 'RESUME'], ['pause', 'PAUSE'], ['dock', 'RETURN'], ['cancel', 'STOP']] as const)(
    'maps %s to %s without a Python bridge or plan creation', async (action, expected) => {
      await start();
      if (action === 'start' || action === 'resume') { fetchApi.mockResolvedValueOnce(response(detail)); }
      fetchApi.mockResolvedValueOnce(response({ commandResult: true })).mockResolvedValueOnce(response(detail));
      await client.command(mower.name, action);
      const writes = fetchApi.mock.calls.filter(([url]) => url.endsWith('/v1/mower/action'));
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0][1].body)).toEqual({ deviceId: mower.id, action: expected });
    });
  it('resumes a paused job and does not issue another start while working', async () => {
    await start();
    fetchApi.mockResolvedValueOnce(response({ ...detail, status: 'Paused' }))
      .mockResolvedValueOnce(response({ commandResult: true })).mockResolvedValueOnce(response({ ...detail, status: 'Working' }));
    await client.command(mower.name, 'start');
    expect(JSON.parse(fetchApi.mock.calls[3][1].body).action).toBe('RESUME');
    fetchApi.mockResolvedValueOnce(response({ ...detail, status: 'Working' }));
    await client.command(mower.name, 'start');
    expect(fetchApi.mock.calls.filter(([url]) => url.endsWith('/v1/mower/action'))).toHaveLength(1);
  });
  it.each([401, 429, 500])('never replays a command after HTTP %s', async status => {
    await start();
    fetchApi.mockResolvedValueOnce(response(detail)).mockResolvedValueOnce(new Response('', { status }));
    await expect(client.command(mower.name, 'start')).rejects.toThrow();
    expect(fetchApi.mock.calls.filter(([url]) => url.endsWith('/v1/mower/action'))).toHaveLength(1);
  });
  it('never replays a command after a network failure or leaks exception details', async () => {
    await start();
    fetchApi.mockResolvedValueOnce(response(detail)).mockRejectedValueOnce(new Error('private-token private-secret'));
    await expect(client.command(mower.name, 'start')).rejects.toThrow('request failed or timed out');
    expect(fetchApi.mock.calls.filter(([url]) => url.endsWith('/v1/mower/action'))).toHaveLength(1);
  });
  it('rejects an explicit negative command acknowledgment', async () => {
    await start();
    fetchApi.mockResolvedValueOnce(response(detail)).mockResolvedValueOnce(response({ commandResult: false, resultMessage: 'Unfinished task: private-token private-client private-secret' }));
    await expect(client.command(mower.name, 'start')).rejects.toThrow('rejected CMD_START: Unfinished task: [redacted] [redacted] [redacted]');
  });
  it.each([undefined, null, {}, { resultMessage: 'Command sent' }])(
    'accepts a successful API envelope without an optional action acknowledgment: %j', async data => {
      await start();
      fetchApi.mockResolvedValueOnce(response(detail)).mockResolvedValueOnce(response(data))
        .mockResolvedValueOnce(response(detail));
      await expect(client.command(mower.name, 'start')).resolves.toMatchObject({ modeName: 'MODE_IDLE' });
      expect(fetchApi.mock.calls.filter(([url]) => url.endsWith('/v1/mower/action'))).toHaveLength(1);
    });
  it('rejects a malformed action acknowledgment without replaying the command', async () => {
    await start();
    fetchApi.mockResolvedValueOnce(response(detail)).mockResolvedValueOnce(response({ commandResult: 'true' }));
    await expect(client.command(mower.name, 'start')).rejects.toThrow('invalid acknowledgment');
    expect(fetchApi.mock.calls.filter(([url]) => url.endsWith('/v1/mower/action'))).toHaveLength(1);
  });
  it('keeps command acceptance distinct from a subsequent status-read failure', async () => {
    await start();
    fetchApi.mockResolvedValueOnce(response(detail)).mockResolvedValueOnce(response({ commandResult: true }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(client.command(mower.name, 'start')).resolves.toMatchObject({ modeName: 'MODE_IDLE' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('accepted'));
  });
  it('rejects unknown or offline mowers before sending an action', async () => {
    await start();
    await expect(client.command('unknown', 'start')).rejects.toThrow('Unknown');
    fetchApi.mockResolvedValueOnce(response({ ...detail, online: 0 }));
    await expect(client.command(mower.name, 'start')).rejects.toThrow('offline');
    expect(fetchApi.mock.calls.filter(([url]) => url.endsWith('/v1/mower/action'))).toHaveLength(0);
  });
});

describe('failure boundaries', () => {
  it('honors Retry-After instead of hammering the API', async () => {
    await start();
    fetchApi.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(client.pollStates()).rejects.toMatchObject({ retryAfterMs: 120_000 });
    await expect(client.pollStates()).rejects.toBeInstanceOf(MammotionApiError);
    expect(fetchApi).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    fetchApi.mockResolvedValueOnce(response(detail));
    await expect(client.pollStates()).resolves.toHaveLength(1);
  });
  it('aborts in-flight requests on shutdown', async () => {
    await start();
    fetchApi.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
    }));
    const poll = client.pollStates();
    const result = expect(poll).rejects.toThrow('request failed');
    await vi.advanceTimersByTimeAsync(0);
    await client.stop();
    await result;
  });
  it('does not turn an invalid status response into a fake offline or idle state', async () => {
    await start();
    fetchApi.mockResolvedValueOnce(response({}));
    await expect(client.pollStates()).rejects.toThrow('invalid mower status');
  });
});

it('rejects a detail response belonging to a different mower', async () => {
  await start();
  fetchApi.mockResolvedValueOnce(response({ ...detail, id: 'different-device' }));
  await expect(client.pollStates()).rejects.toThrow('different mower identity');
});

it('renews the token for a business-code 401 returned with HTTP 200', async () => {
  await start();
  fetchApi.mockResolvedValueOnce(response(null, 401)).mockResolvedValueOnce(token()).mockResolvedValueOnce(response(detail));
  await expect(client.pollStates()).resolves.toHaveLength(1);
  expect(fetchApi.mock.calls.filter(([url]) => url.includes('/oauth2/'))).toHaveLength(2);
});
it('never retries a mower action rejected by a business-code 401 envelope', async () => {
  await start();
  fetchApi.mockResolvedValueOnce(response(detail)).mockResolvedValueOnce(response(null, 401));
  await expect(client.command(mower.name, 'start')).rejects.toThrow('401');
  expect(fetchApi.mock.calls.filter(([url]) => url.endsWith('/v1/mower/action'))).toHaveLength(1);
});

it('preserves actionable provider errors without leaking credentials', async () => {
  await start();
  fetchApi.mockResolvedValueOnce(response(detail)).mockResolvedValueOnce(new Response(JSON.stringify({ code: 40200, msg: 'Cannot start: private-token private-client private-secret', data: null })));
  await expect(client.command(mower.name, 'start')).rejects.toThrow('code 40200): Cannot start: [redacted] [redacted] [redacted]');
});

it.each(['pause', 'dock', 'cancel'] as const)('can send %s without valid telemetry, and never invents a successful status', async action => {
  await start();
  fetchApi.mockResolvedValueOnce(response({ commandResult: true })).mockResolvedValueOnce(response({}));
  await expect(client.command(mower.name, action)).resolves.toBeUndefined();
  expect(fetchApi.mock.calls[2][0]).toBe('https://api-open.mammotion.com/v1/mower/action');
  expect(fetchApi.mock.calls.filter(([url]) => url.endsWith('/v1/mower/action'))).toHaveLength(1);
});

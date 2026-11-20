import { expect, it } from 'vitest';
import { mapOfficialState } from './state-mapper';
const base = { online: 1, status: 'Standby', batteryLevel: 100, chargeStatus: 5 };

it.each([['Working', 13, 'MODE_WORKING'], ['Mowing', 13, 'MODE_WORKING'], ['Paused', 19, 'MODE_PAUSE'], ['Returning', 14, 'MODE_RETURNING'],
  ['StandBy', 0, 'MODE_IDLE'], ['Abnormal', 17, 'MODE_LOCK']])('maps official %s to the existing Home state', (status, sysStatus, modeName) => {
  expect(mapOfficialState('fixture', { ...base, status })).toMatchObject({ name: 'fixture', sysStatus, modeName, chargeState: 5 });
});
it('retains the live charge status 5 without inventing a different encoding', () => {
  expect(mapOfficialState('fixture', base)).toMatchObject({ online: true, battery: 100, chargeState: 5, hasError: false });
});
it('handles offline and unknown statuses conservatively', () => {
  expect(mapOfficialState('fixture', { ...base, status: 'Offline' }).online).toBe(false);
  expect(mapOfficialState('fixture', { ...base, status: 'New vendor status' }).hasError).toBe(true);
});
it.each([{}, { ...base, batteryLevel: -1 }, { ...base, batteryLevel: 101 }, { ...base, batteryLevel: '100' }, { ...base, online: 2 }])('rejects invalid device data %j', value => {
  expect(() => mapOfficialState('fixture', value)).toThrow('invalid mower status');
});

it('rejects the observed identity-only API response instead of inventing standby and a full battery', () => {
  expect(() => mapOfficialState('fixture', { id: 'fixture-id', name: 'fixture', online: 1, version: '2.3.35.12' }))
    .toThrow('Mammotion telemetry unavailable');
});

import { describe, expect, it } from 'vitest';

import {
  assessOfflineSyncTime,
  DEVICE_TIME_DRIFT_LIMIT_MS,
  OFFLINE_SYNC_MAX_AGE_MS,
} from '../../src/modules/attendance/index.js';

const SERVER_RECEIVED_AT = new Date('2026-10-11T03:00:00.000Z');

function deviceTime(offsetFromServerMs: number): Date {
  return new Date(SERVER_RECEIVED_AT.getTime() + offsetFromServerMs);
}

describe('offline sync timing policy', () => {
  it('accepts a short delayed airplane-mode sync within both thresholds', () => {
    const assessment = assessOfflineSyncTime(deviceTime(-4 * 60 * 1000), SERVER_RECEIVED_AT);

    expect(assessment).toMatchObject({
      clockDriftMs: 4 * 60 * 1000,
      syncAgeMs: 4 * 60 * 1000,
      exceedsClockDriftLimit: false,
      exceedsSyncAgeLimit: false,
      requiresVerification: false,
    });
  });

  it.each([
    ['device clock is exactly five minutes behind', -DEVICE_TIME_DRIFT_LIMIT_MS],
    ['device clock is exactly five minutes ahead', DEVICE_TIME_DRIFT_LIMIT_MS],
  ])('%s is within the strict drift boundary', (_label, offsetMs) => {
    expect(assessOfflineSyncTime(deviceTime(offsetMs), SERVER_RECEIVED_AT)).toMatchObject({
      clockDriftMs: DEVICE_TIME_DRIFT_LIMIT_MS,
      exceedsClockDriftLimit: false,
      exceedsSyncAgeLimit: false,
      requiresVerification: false,
    });
  });

  it.each([
    ['device clock is more than five minutes behind', -(DEVICE_TIME_DRIFT_LIMIT_MS + 1)],
    ['device clock is more than five minutes ahead', DEVICE_TIME_DRIFT_LIMIT_MS + 1],
  ])('%s requires verification', (_label, offsetMs) => {
    expect(assessOfflineSyncTime(deviceTime(offsetMs), SERVER_RECEIVED_AT)).toMatchObject({
      exceedsClockDriftLimit: true,
      requiresVerification: true,
    });
  });

  it('distinguishes an exact 24-hour age from an over-24-hour age', () => {
    const exactlyOneDayOld = assessOfflineSyncTime(
      deviceTime(-OFFLINE_SYNC_MAX_AGE_MS),
      SERVER_RECEIVED_AT,
    );
    const moreThanOneDayOld = assessOfflineSyncTime(
      deviceTime(-(OFFLINE_SYNC_MAX_AGE_MS + 1)),
      SERVER_RECEIVED_AT,
    );

    expect(exactlyOneDayOld.exceedsSyncAgeLimit).toBe(false);
    // The independent five-minute drift rule still requires review at this age.
    expect(exactlyOneDayOld).toMatchObject({
      exceedsClockDriftLimit: true,
      requiresVerification: true,
    });
    expect(moreThanOneDayOld).toMatchObject({
      exceedsSyncAgeLimit: true,
      requiresVerification: true,
    });
  });

  it('rejects invalid timestamps instead of treating them as within tolerance', () => {
    expect(() => assessOfflineSyncTime(new Date(Number.NaN), SERVER_RECEIVED_AT)).toThrow(
      RangeError,
    );
  });
});

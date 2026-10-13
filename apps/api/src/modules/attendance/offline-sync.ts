export const DEVICE_TIME_DRIFT_LIMIT_MS = 5 * 60 * 1000;
export const OFFLINE_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type OfflineSyncTimeAssessment = Readonly<{
  /** Absolute difference between the device timestamp and the server receipt timestamp. */
  clockDriftMs: number;
  /** Signed receipt-minus-device interval; a future device clock yields a negative value. */
  syncAgeMs: number;
  exceedsClockDriftLimit: boolean;
  exceedsSyncAgeLimit: boolean;
  requiresVerification: boolean;
}>;

/**
 * Evaluate a queued offline timestamp against the immutable server receipt time.
 * The client timestamp is evidence only and is never substituted for server time.
 */
export function assessOfflineSyncTime(
  deviceTime: Date,
  serverReceivedAt: Date,
): OfflineSyncTimeAssessment {
  const deviceTimeMs = deviceTime.getTime();
  const serverReceivedAtMs = serverReceivedAt.getTime();
  if (!Number.isFinite(deviceTimeMs) || !Number.isFinite(serverReceivedAtMs)) {
    throw new RangeError('Device and server receipt timestamps must be valid dates.');
  }

  const syncAgeMs = serverReceivedAtMs - deviceTimeMs;
  const clockDriftMs = Math.abs(syncAgeMs);
  const exceedsClockDriftLimit = clockDriftMs > DEVICE_TIME_DRIFT_LIMIT_MS;
  const exceedsSyncAgeLimit = syncAgeMs > OFFLINE_SYNC_MAX_AGE_MS;

  return {
    clockDriftMs,
    syncAgeMs,
    exceedsClockDriftLimit,
    exceedsSyncAgeLimit,
    requiresVerification: exceedsClockDriftLimit || exceedsSyncAgeLimit,
  };
}

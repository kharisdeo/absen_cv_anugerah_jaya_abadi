import {
  prepareAttendanceAttempt,
  submitAttendanceAttempt,
  type AttendanceApiOptions,
  type AttendanceReceipt,
} from '../../api/attendance-api.js';
import { OfflineQueueError, type OfflineAttendanceQueue } from './offline-attendance-queue.js';

export type OfflineSyncResult = Readonly<{
  acknowledged: readonly AttendanceReceipt[];
  stopped: boolean;
  error: unknown | null;
}>;

export type OfflineSyncOptions = Readonly<{
  employeeId: string;
  queue: OfflineAttendanceQueue;
  verifyOwner: () => Promise<boolean>;
  apiOptions?: AttendanceApiOptions;
  isOnline?: () => boolean;
  onReceipt?: (receipt: AttendanceReceipt) => void;
}>;

/** Foreground sync is the safe fallback; this app intentionally does not enqueue requests in a service worker. */
export function shouldSyncInForeground(
  input: Readonly<{
    online: boolean;
    authenticatedOwnerVerified: boolean;
    backgroundSyncSupported: boolean;
  }>,
): boolean {
  void input.backgroundSyncSupported;
  return input.online && input.authenticatedOwnerVerified;
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Syncs only under a freshly verified employee session. Each attempt is serial, and its immutable
 * body is encrypted before the first POST so an ambiguous response is replayed exactly.
 */
export async function syncOfflineAttendanceQueue(
  options: OfflineSyncOptions,
): Promise<OfflineSyncResult> {
  const acknowledged: AttendanceReceipt[] = [];
  const online = options.isOnline ?? isOnline;
  if (!online()) return { acknowledged, stopped: true, error: null };

  let entries;
  try {
    entries = await options.queue.list(options.employeeId);
  } catch (error) {
    return { acknowledged, stopped: true, error };
  }

  for (const listedEntry of entries) {
    if (listedEntry.payload.kind === 'receipt') continue;
    if (!online()) return { acknowledged, stopped: true, error: null };

    let lease: string | null;
    try {
      lease = await options.queue.acquireSyncLease(listedEntry.id);
    } catch (error) {
      return { acknowledged, stopped: true, error };
    }
    if (!lease) continue;

    try {
      // Refresh the server session for every queue item; a cached/offline identity is insufficient.
      if (!(await options.verifyOwner()) || !online()) {
        return { acknowledged, stopped: true, error: null };
      }

      const current = await options.queue.get(options.employeeId, listedEntry.id);
      if (!current || current.payload.kind === 'receipt') continue;
      const pending = current.payload;

      let draft = pending.draft;
      if (!draft) {
        if (!current.photo) throw new OfflineQueueError('CORRUPT');
        draft = await prepareAttendanceAttempt(
          {
            type: pending.type,
            clientRecordedAt: pending.clientRecordedAt,
            photo: current.photo,
            location: pending.location,
            liveness: { faceDetected: false, passed: false },
            networkStatus: 'OFFLINE',
            validationMethod: 'OFFLINE',
          },
          {
            ...options.apiOptions,
            createIdempotencyKey: () => pending.idempotencyKey,
          },
        );
        // Persist the exact JSON body (and intent reference) before the potentially ambiguous POST.
        await options.queue.saveDraft(options.employeeId, current.id, draft);
      }

      if (!online()) return { acknowledged, stopped: true, error: null };
      if (!(await options.verifyOwner())) {
        return { acknowledged, stopped: true, error: null };
      }
      const receipt = await submitAttendanceAttempt(draft, options.apiOptions);
      // BE-018 fails closed for offline records. Never accept an unexpected VALID receipt.
      if (receipt.validationStatus === 'VALID') {
        throw new OfflineQueueError('ACK_INVALID');
      }
      await options.queue.acknowledge(options.employeeId, current.id, receipt);
      acknowledged.push(receipt);
      options.onReceipt?.(receipt);
    } catch (error) {
      // All failures retain the encrypted item and its photo. A known 4xx stops the serial queue
      // for explicit follow-up; auth/transient failures can be retried after reconnection.
      return { acknowledged, stopped: true, error };
    } finally {
      try {
        await options.queue.releaseSyncLease(listedEntry.id, lease);
      } catch {
        // The short lease expires automatically; never delete or rewrite the attendance item here.
      }
    }
  }

  return { acknowledged, stopped: false, error: null };
}

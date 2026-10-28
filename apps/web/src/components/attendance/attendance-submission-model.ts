import type { AttendanceAttemptDraft, AttendanceLocation } from '../../api/attendance-api.js';
import type { ApiAttendanceLocationFailureReason } from '../../api/api-contract.js';
import type { LocationCaptureSnapshot } from './location-capture.js';

export type AttendanceSubmissionPlan =
  | Readonly<{
      kind: 'new';
      location: AttendanceLocation | null;
      locationFailureReason?: ApiAttendanceLocationFailureReason;
    }>
  | Readonly<{ kind: 'replay'; draft: AttendanceAttemptDraft }>
  | Readonly<{ kind: 'blocked' }>;

export function locationFailureReasonForStatus(
  status: LocationCaptureSnapshot['status'],
): ApiAttendanceLocationFailureReason | null {
  switch (status) {
    case 'denied':
      return 'PERMISSION_DENIED';
    case 'timeout':
      return 'TIMEOUT';
    case 'unavailable':
    case 'invalid':
    case 'unsupported':
    case 'error':
      return 'POSITION_UNAVAILABLE';
    default:
      return null;
  }
}

export function shouldOfferFreshCapture(
  input: Readonly<{
    hasReceipt: boolean;
    hasDraft: boolean;
    hasPhoto: boolean;
    requiresFreshCapture: boolean;
    busy: boolean;
  }>,
): boolean {
  return (
    !input.hasReceipt &&
    !input.hasDraft &&
    !input.busy &&
    (input.hasPhoto || input.requiresFreshCapture)
  );
}

/** Replays preserve the original body; only a new capture may use a freshly captured location. */
export function resolveAttendanceSubmissionPlan(
  draft: AttendanceAttemptDraft | null,
  freshLocation: AttendanceLocation | null,
  locationFailureReason: ApiAttendanceLocationFailureReason | null = null,
): AttendanceSubmissionPlan {
  if (draft) return { kind: 'replay', draft };
  if (freshLocation) return { kind: 'new', location: freshLocation };
  if (locationFailureReason) {
    return { kind: 'new', location: null, locationFailureReason };
  }
  return { kind: 'blocked' };
}

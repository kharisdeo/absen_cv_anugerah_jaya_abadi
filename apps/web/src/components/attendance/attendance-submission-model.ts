import type { AttendanceAttemptDraft, AttendanceLocation } from '../../api/attendance-api.js';

export type AttendanceSubmissionPlan =
  | Readonly<{ kind: 'new'; location: AttendanceLocation }>
  | Readonly<{ kind: 'replay'; draft: AttendanceAttemptDraft }>
  | Readonly<{ kind: 'blocked' }>;

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
): AttendanceSubmissionPlan {
  if (draft) return { kind: 'replay', draft };
  if (freshLocation) return { kind: 'new', location: freshLocation };
  return { kind: 'blocked' };
}

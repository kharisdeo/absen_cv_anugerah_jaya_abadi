import { describe, expect, it } from 'vitest';

import type { AttendanceAttemptDraft, AttendanceReceipt } from '../src/api/attendance-api.js';
import type { DecryptedOfflineAttendanceEntry } from '../src/components/attendance/offline-attendance-queue.js';
import { toOfflineQueueViewRow } from '../src/components/attendance/EmployeeOfflineAttendanceQueue.js';

const ID = '00000000-0000-4000-8000-000000000011';
const PHOTO_SENTINEL = 'SELFIE_BYTES_MUST_NOT_ENTER_REACT_STATE';
const REQUEST_BODY_SENTINEL = 'EXACT_REQUEST_BODY_MUST_NOT_ENTER_REACT_STATE';
const IDEMPOTENCY_SENTINEL = 'PRIVATE_IDEMPOTENCY_KEY_MUST_NOT_ENTER_REACT_STATE';
const GPS_SENTINEL = 'GPS_COORDINATE_MUST_NOT_ENTER_REACT_STATE';

function pendingEntry(): DecryptedOfflineAttendanceEntry {
  const draft: AttendanceAttemptDraft = {
    body: {
      idempotencyKey: IDEMPOTENCY_SENTINEL,
      type: 'CHECK_IN',
      clientRecordedAt: '2026-10-11T10:00:00+07:00',
      networkStatus: 'OFFLINE',
      location: { latitude: -6.200123, longitude: 106.800987, accuracyMeters: 12 },
      validationMethod: 'OFFLINE',
      selfie: { blob: 'PRIVATE_SIGNED_UPLOAD_REFERENCE', sizeKb: 1 },
      liveness: { faceDetected: false, passed: false },
      proofCode: null,
    },
    serializedBody: `${REQUEST_BODY_SENTINEL}:${GPS_SENTINEL}:${IDEMPOTENCY_SENTINEL}:https://private.example/signed?token=SYNTHETIC_URL_TOKEN`,
  };
  return {
    id: ID,
    keyRef: '00000000-0000-4000-8000-000000000012',
    photo: new Blob([PHOTO_SENTINEL], { type: 'image/jpeg' }),
    payload: {
      schemaVersion: 1,
      kind: 'pending',
      idempotencyKey: IDEMPOTENCY_SENTINEL,
      type: 'CHECK_IN',
      clientRecordedAt: '2026-10-11T10:00:00+07:00',
      networkStatus: 'OFFLINE',
      validationMethod: 'OFFLINE',
      location: { latitude: -6.200123, longitude: 106.800987, accuracyMeters: 12 },
      liveness: { faceDetected: false, passed: false },
      photoType: 'image/jpeg',
      photoSizeBytes: PHOTO_SENTINEL.length,
      photoBase64: PHOTO_SENTINEL,
      draft,
    },
  };
}

function receipt(): AttendanceReceipt {
  return {
    attemptId: '00000000-0000-4000-8000-000000000013',
    state: 'RECORDED',
    type: 'CHECK_IN',
    receivedAt: '2026-10-11T03:00:00.000Z',
    replayed: false,
    attendanceId: '00000000-0000-4000-8000-000000000014',
    validationStatus: 'PENDING_VERIFICATION',
  };
}

describe('employee offline queue React view model', () => {
  it('strips decrypted selfie, exact draft/body, GPS and idempotency key before rows enter state', () => {
    const row = toOfflineQueueViewRow(pendingEntry());

    expect(row).toEqual({
      id: ID,
      kind: 'pending',
      type: 'CHECK_IN',
      clientRecordedAt: '2026-10-11T10:00:00+07:00',
    });
    const serializedRow = JSON.stringify(row);
    for (const secret of [
      PHOTO_SENTINEL,
      REQUEST_BODY_SENTINEL,
      IDEMPOTENCY_SENTINEL,
      GPS_SENTINEL,
      'PRIVATE_SIGNED_UPLOAD_REFERENCE',
      'https://private.example/signed?token=SYNTHETIC_URL_TOKEN',
      'location',
      'photoBase64',
      'serializedBody',
    ]) {
      expect(serializedRow).not.toContain(secret);
    }
  });

  it('retains only a receipt and local row ID for an acknowledged entry', () => {
    const entry: DecryptedOfflineAttendanceEntry = {
      id: ID,
      keyRef: '00000000-0000-4000-8000-000000000012',
      photo: null,
      payload: { schemaVersion: 1, kind: 'receipt', receipt: receipt() },
    };

    expect(toOfflineQueueViewRow(entry)).toEqual({
      id: ID,
      kind: 'receipt',
      receipt: receipt(),
    });
  });
});

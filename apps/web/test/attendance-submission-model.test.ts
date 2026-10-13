import { describe, expect, it } from 'vitest';

import type { AttendanceAttemptDraft } from '../src/api/attendance-api.js';
import { resolveAttendanceSubmissionPlan } from '../src/components/attendance/attendance-submission-model.js';
import { AttendanceSubmitGate } from '../src/components/attendance/attendance-submit-gate.js';

const firstFix = { latitude: -6.2, longitude: 106.8, accuracyMeters: 10 };
const retakeFix = { latitude: -6.2002, longitude: 106.8003, accuracyMeters: 7 };

const draft: AttendanceAttemptDraft = {
  body: {
    idempotencyKey: '00000000-0000-4000-8000-000000000003',
    type: 'CHECK_IN',
    clientRecordedAt: '2026-10-11T10:00:00+07:00',
    networkStatus: 'ONLINE',
    location: firstFix,
    validationMethod: 'GPS',
    selfie: { blob: '00000000-0000-4000-8000-000000000002', sizeKb: 1 },
    liveness: { faceDetected: false, passed: false },
    proofCode: null,
  },
  serializedBody: '{"idempotencyKey":"stable"}',
};

describe('attendance submission model', () => {
  it('uses a fresh GPS fix for a new/retaken attempt, but replays the original draft unchanged', () => {
    expect(resolveAttendanceSubmissionPlan(null, firstFix)).toEqual({
      kind: 'new',
      location: firstFix,
    });
    expect(resolveAttendanceSubmissionPlan(null, retakeFix)).toEqual({
      kind: 'new',
      location: retakeFix,
    });
    expect(resolveAttendanceSubmissionPlan(draft, retakeFix)).toEqual({ kind: 'replay', draft });
    expect(resolveAttendanceSubmissionPlan(null, null)).toEqual({ kind: 'blocked' });
  });

  it('allows only one concurrent submit operation', async () => {
    const gate = new AttendanceSubmitGate();
    let finish: ((value: string) => void) | undefined;
    const operation = () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      });

    const first = gate.run(operation);
    const second = await gate.run(operation);

    expect(second).toBeNull();
    finish?.('receipt');
    await expect(first).resolves.toBe('receipt');
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });
});

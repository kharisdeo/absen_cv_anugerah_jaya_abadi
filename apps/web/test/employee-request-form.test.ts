import { describe, expect, it } from 'vitest';

import {
  createRequestSubmissionGate,
  emptyEmployeeRequestDraft,
  EmployeeRequestFormError,
  MAX_DOCTOR_NOTE_BYTES,
  toAttendanceRequestCreateInput,
  validateEmployeeRequestDraft,
} from '../src/pages/employee-request-form.js';

const validDates = { startDate: '2026-10-12', endDate: '2026-10-13' };

function draft(overrides: Partial<ReturnType<typeof emptyEmployeeRequestDraft>> = {}) {
  return {
    ...emptyEmployeeRequestDraft(),
    ...validDates,
    reason: 'Keperluan keluarga',
    ...overrides,
  };
}

function file(contentType: string, bytes: readonly number[], size?: number): File {
  const data = new Uint8Array(size ?? bytes.length);
  data.set(bytes.slice(0, data.length));
  return new File([data], 'surat-dokter', { type: contentType });
}

describe('employee request form validation and serialization', () => {
  it('accepts a valid leave range and rejects impossible/reversed dates and invalid reason', () => {
    expect(validateEmployeeRequestDraft(draft())).toEqual({});
    expect(
      validateEmployeeRequestDraft(draft({ startDate: '2026-02-29', endDate: '2026-03-01' })),
    ).toHaveProperty('startDate');
    expect(
      validateEmployeeRequestDraft(draft({ startDate: '2026-10-14', endDate: '2026-10-13' })),
    ).toHaveProperty('endDate');
    expect(validateEmployeeRequestDraft(draft({ reason: '   ' }))).toHaveProperty('reason');
    expect(validateEmployeeRequestDraft(draft({ reason: 'x'.repeat(1_001) }))).toHaveProperty(
      'reason',
    );
    expect(validateEmployeeRequestDraft(draft({ reason: `valid\u0001invalid` }))).toHaveProperty(
      'reason',
    );
  });

  it('allows only supported request types and never creates a correction payload', async () => {
    const correction = draft({ requestType: 'CORRECTION' });
    expect(validateEmployeeRequestDraft(correction)).toHaveProperty('requestType');
    await expect(toAttendanceRequestCreateInput(correction)).rejects.toBeInstanceOf(
      EmployeeRequestFormError,
    );

    const leave = await toAttendanceRequestCreateInput(draft());
    expect(leave).toEqual({
      requestType: 'LEAVE',
      startDate: validDates.startDate,
      endDate: validDates.endDate,
      reason: 'Keperluan keluarga',
    });
    expect(leave).not.toHaveProperty('doctorNote');
    expect(leave).not.toHaveProperty('requestedOvertimeMinutes');
  });

  it('requires a positive integer duration only for overtime and emits no unrelated fields', async () => {
    for (const value of ['', '0', '-2', '1.5', '1e2', '9007199254740992']) {
      expect(
        validateEmployeeRequestDraft(
          draft({ requestType: 'OVERTIME', requestedOvertimeMinutes: value }),
        ),
      ).toHaveProperty('requestedOvertimeMinutes');
    }

    const overtime = await toAttendanceRequestCreateInput(
      draft({ requestType: 'OVERTIME', requestedOvertimeMinutes: '90' }),
    );
    expect(overtime).toEqual({
      requestType: 'OVERTIME',
      startDate: validDates.startDate,
      endDate: validDates.endDate,
      reason: 'Keperluan keluarga',
      requestedOvertimeMinutes: 90,
    });
    expect(overtime).not.toHaveProperty('employeeId');
    expect(overtime).not.toHaveProperty('status');
    expect(overtime).not.toHaveProperty('doctorNote');
  });

  it('requires a supported doctor-note image under 5 MiB and checks its actual signature', async () => {
    expect(validateEmployeeRequestDraft(draft({ requestType: 'SICK' }))).toHaveProperty(
      'doctorNoteFile',
    );
    expect(
      validateEmployeeRequestDraft(
        draft({ requestType: 'SICK', doctorNoteFile: file('image/gif', [0x47, 0x49, 0x46]) }),
      ),
    ).toHaveProperty('doctorNoteFile');
    expect(
      validateEmployeeRequestDraft(
        draft({
          requestType: 'SICK',
          doctorNoteFile: file('image/png', [0x89, 0x50, 0x4e, 0x47], MAX_DOCTOR_NOTE_BYTES + 1),
        }),
      ),
    ).toHaveProperty('doctorNoteFile');
    await expect(
      toAttendanceRequestCreateInput(
        draft({
          requestType: 'SICK',
          doctorNoteFile: file('image/png', [0x00, 0x01, 0x02]),
        }),
      ),
    ).rejects.toThrow('Isi file tidak sesuai');

    const validNote = file('image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sick = await toAttendanceRequestCreateInput(
      draft({ requestType: 'SICK', doctorNoteFile: validNote }),
    );
    expect(sick).toEqual({
      requestType: 'SICK',
      startDate: validDates.startDate,
      endDate: validDates.endDate,
      reason: 'Keperluan keluarga',
      doctorNote: {
        contentType: 'image/png',
        dataBase64: 'iVBORw0KGgo=',
      },
    });
    expect(sick).not.toHaveProperty('requestedOvertimeMinutes');
  });

  it('rejects an attachment selected for a non-sickness request', () => {
    expect(
      validateEmployeeRequestDraft(
        draft({ doctorNoteFile: file('image/png', [0x89, 0x50, 0x4e, 0x47]) }),
      ),
    ).toHaveProperty('doctorNoteFile');
  });

  it('prevents overlapping submissions while the first request is pending', async () => {
    const gate = createRequestSubmissionGate();
    let finishFirst!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let callCount = 0;
    const first = gate(async () => {
      callCount += 1;
      await pending;
    });

    await expect(
      gate(async () => {
        callCount += 1;
      }),
    ).resolves.toBe(false);
    expect(callCount).toBe(1);
    finishFirst();
    await expect(first).resolves.toBe(true);
  });
});

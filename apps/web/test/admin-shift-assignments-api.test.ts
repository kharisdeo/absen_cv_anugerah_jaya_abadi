import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AdminShiftAssignmentsApiError,
  adminShiftAssignmentsApi,
} from '../src/api/admin-shift-assignments-api.js';

const employeeId = '00000000-0000-4000-8000-000000000701';
const shiftId = '00000000-0000-4000-8000-000000000702';
const storeId = '00000000-0000-4000-8000-000000000703';
const assignmentId = '00000000-0000-4000-8000-000000000704';

const assignment = {
  id: assignmentId,
  employeeId,
  workShiftId: shiftId,
  storeId: null,
  assignedByUserAccountId: null,
  effectiveFrom: '2026-11-01',
  effectiveTo: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  employee: { id: employeeId, nik: 'AJ-701', fullName: 'Siti Aminah', status: 'ACTIVE' },
  workShift: {
    id: shiftId,
    name: 'Shift Pagi',
    startTime: '08:00:00',
    endTime: '17:00:00',
    breakMinutes: 60,
    lateToleranceMinutes: 10,
    workDays: [1, 2, 3, 4, 5],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

const createInput = {
  employeeId,
  workShiftId: shiftId,
  storeId: null,
  effectiveFrom: '2026-11-01',
  effectiveTo: null,
};

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('admin shift assignments API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads assignments without cache and serializes supported filters exactly', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([assignment]));
    fetchMock.mockResolvedValueOnce(jsonResponse([assignment]));

    await expect(adminShiftAssignmentsApi.listAssignments()).resolves.toEqual([assignment]);
    await adminShiftAssignmentsApi.listAssignments({
      employeeId,
      storeId: 'global',
      businessDate: '2026-11-02',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/admin/shift-assignments');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/admin/shift-assignments?employeeId=${employeeId}&storeId=global&businessDate=2026-11-02`,
    );
  });

  it('creates, patches changed fields, and deactivates by inclusive end date', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(assignment, 201));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...assignment, storeId }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...assignment, effectiveTo: '2026-11-30' }));

    await adminShiftAssignmentsApi.createAssignment(createInput);
    await adminShiftAssignmentsApi.updateAssignment(assignmentId, { storeId });
    await adminShiftAssignmentsApi.deactivateAssignment(assignmentId, '2026-11-30');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/admin/shift-assignments');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'POST', body: JSON.stringify(createInput) }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/admin/shift-assignments/${assignmentId}`);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ storeId }) }),
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/v1/admin/shift-assignments/${assignmentId}/deactivate`,
    );
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ effectiveTo: '2026-11-30' }),
      }),
    );
  });

  it('rejects empty patches locally and rejects malformed DTOs or mismatched deactivation dates', async () => {
    await expect(adminShiftAssignmentsApi.updateAssignment(assignmentId, {})).rejects.toMatchObject(
      {
        status: 400,
        code: 'INVALID_SCHEDULE_INPUT',
      } satisfies Partial<AdminShiftAssignmentsApiError>,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(jsonResponse([{ ...assignment, effectiveFrom: '2026-02-30' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(assignment));
    await expect(adminShiftAssignmentsApi.listAssignments()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    } satisfies Partial<AdminShiftAssignmentsApiError>);
    await expect(
      adminShiftAssignmentsApi.deactivateAssignment(assignmentId, '2026-11-30'),
    ).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });
  });

  it('keeps only the stable server error code', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: 'Private server text',
          detail: 'Do not show',
          code: 'SHIFT_ASSIGNMENT_CONFLICT',
        }),
        { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );

    await expect(adminShiftAssignmentsApi.listAssignments()).rejects.toMatchObject({
      status: 409,
      code: 'SHIFT_ASSIGNMENT_CONFLICT',
    });
  });
});

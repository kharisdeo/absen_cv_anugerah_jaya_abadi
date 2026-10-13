import { describe, expect, it } from 'vitest';

import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import type { AuditLog } from '../../src/generated/prisma/client.js';
import type { AuditActor, RecordAuditEventInput } from '../../src/modules/audit/index.js';
import {
  DeviceBindingService,
  type DeviceBindingApprovalInput,
  type DeviceBindingApprovalResult,
  type DeviceBindingDto,
  type DeviceBindingEnrollmentInput,
  type DeviceBindingEnrollmentResult,
  type DeviceBindingMutation,
  type DeviceBindingRepository,
  type DeviceBindingRevocationInput,
} from '../../src/modules/device-binding/index.js';

const ADMIN_ID = 'd4bb1445-d860-40df-a8c6-cdd898daef80';
const OTHER_ADMIN_ID = '6436b4e6-4908-47c1-8c04-7d40f46c85c2';
const EMPLOYEE_ID = '4d04a7c2-35e8-499a-8a3b-78c730164e5b';
const BINDING_ONE_ID = '102ab810-4e1a-4ea6-bf2e-7fa89e7c39c1';
const BINDING_TWO_ID = '202ab810-4e1a-4ea6-bf2e-7fa89e7c39c2';
const BINDING_THREE_ID = '302ab810-4e1a-4ea6-bf2e-7fa89e7c39c3';
const REQUEST_ID = '902ab810-4e1a-4ea6-bf2e-7fa89e7c39c9';
const NOW = new Date('2026-10-11T03:04:05.000Z');

type StoredBinding = DeviceBindingDto & {
  deviceIdHash: string;
  approvedByUserAccountId: string | null;
};

type StoredSession = {
  id: string;
  deviceBindingId: string;
  tokenHash: string;
  revokedAt: Date | null;
};

const admin: AuditActor = { userAccountId: ADMIN_ID, role: UserRole.ADMIN };
const employee: AuditActor = {
  userAccountId: OTHER_ADMIN_ID,
  role: UserRole.EMPLOYEE,
  employeeId: EMPLOYEE_ID,
};

class FakeDeviceBindingAdminRepository implements DeviceBindingRepository {
  readonly rows = new Map<string, StoredBinding>();
  readonly sessions: StoredSession[] = [];
  readonly calls: string[] = [];
  private readonly employeeLocks = new Map<string, Promise<void>>();
  private nextId = 0;

  seed(
    id: string,
    status: DeviceBindingStatus,
    overrides: Partial<StoredBinding> = {},
  ): StoredBinding {
    const row: StoredBinding = {
      id,
      employeeId: EMPLOYEE_ID,
      deviceName: `Device ${id.slice(0, 4)}`,
      deviceIdHash: `private-device-hash-${id}`,
      status,
      requestedAt: new Date('2026-10-10T08:00:00.000Z'),
      approvedAt: status === DeviceBindingStatus.APPROVED ? new Date(NOW.getTime() - 1_000) : null,
      revokedAt: status === DeviceBindingStatus.REVOKED ? new Date(NOW.getTime() - 500) : null,
      approvedByUserAccountId: status === DeviceBindingStatus.APPROVED ? OTHER_ADMIN_ID : null,
      createdAt: new Date('2026-10-10T07:00:00.000Z'),
      updatedAt: new Date('2026-10-10T08:00:00.000Z'),
      ...overrides,
    };
    this.rows.set(id, row);
    return row;
  }

  seedSession(bindingId: string, id: string): StoredSession {
    const session: StoredSession = {
      id,
      deviceBindingId: bindingId,
      tokenHash: `private-session-hash-${id}`,
      revokedAt: null,
    };
    this.sessions.push(session);
    return session;
  }

  async enroll(input: DeviceBindingEnrollmentInput): Promise<DeviceBindingEnrollmentResult> {
    this.calls.push('enroll');
    this.nextId += 1;
    const now = input.requestedAt;
    const row = this.seed(`enrollment-${this.nextId}`, DeviceBindingStatus.PENDING, {
      employeeId: input.employeeId,
      deviceName: input.deviceName,
      deviceIdHash: input.deviceIdHash,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { binding: this.toDto(row), outcome: 'created' };
  }

  async listPending(): Promise<readonly DeviceBindingDto[]> {
    this.calls.push('listPending');
    return [...this.rows.values()]
      .filter((row) => row.status === DeviceBindingStatus.PENDING)
      .map((row) => this.toDto(row));
  }

  async approve(input: DeviceBindingApprovalInput): Promise<DeviceBindingApprovalResult> {
    this.calls.push('approve');
    const initial = this.rows.get(input.bindingId);
    if (!initial) return { outcome: 'not_found' };

    return this.withEmployeeLock(initial.employeeId, async () => {
      const target = this.rows.get(input.bindingId);
      if (!target) return { outcome: 'not_found' };
      if (target.status !== DeviceBindingStatus.PENDING) {
        return { outcome: 'invalid_state', binding: this.toDto(target) };
      }

      const replaced = [...this.rows.values()].filter(
        (row) =>
          row.employeeId === target.employeeId &&
          row.id !== target.id &&
          row.status === DeviceBindingStatus.APPROVED,
      );
      const revoked: DeviceBindingMutation[] = [];
      for (const previous of replaced) {
        const after: StoredBinding = {
          ...previous,
          status: DeviceBindingStatus.REVOKED,
          revokedAt: input.approvedAt,
          updatedAt: input.approvedAt,
        };
        this.rows.set(after.id, after);
        this.revokeSessions(after.id, input.approvedAt);
        revoked.push({ before: this.toDto(previous), after: this.toDto(after) });
      }

      const after: StoredBinding = {
        ...target,
        status: DeviceBindingStatus.APPROVED,
        approvedByUserAccountId: input.approvedByUserAccountId,
        approvedAt: input.approvedAt,
        revokedAt: null,
        updatedAt: input.approvedAt,
      };
      this.rows.set(after.id, after);
      return {
        outcome: 'approved',
        mutation: { before: this.toDto(target), after: this.toDto(after) },
        revoked,
      };
    });
  }

  async revoke(input: DeviceBindingRevocationInput): Promise<DeviceBindingMutation | null> {
    this.calls.push('revoke');
    const initial = this.rows.get(input.bindingId);
    if (!initial) return null;

    return this.withEmployeeLock(initial.employeeId, async () => {
      const before = this.rows.get(input.bindingId);
      if (!before) return null;
      this.revokeSessions(input.bindingId, input.revokedAt);
      if (before.status === DeviceBindingStatus.REVOKED && before.revokedAt !== null) {
        return { before: this.toDto(before), after: this.toDto(before) };
      }

      const after: StoredBinding = {
        ...before,
        status: DeviceBindingStatus.REVOKED,
        revokedAt: before.revokedAt ?? input.revokedAt,
        updatedAt: input.revokedAt,
      };
      this.rows.set(after.id, after);
      return { before: this.toDto(before), after: this.toDto(after) };
    });
  }

  private revokeSessions(bindingId: string, revokedAt: Date): void {
    for (const session of this.sessions) {
      if (session.deviceBindingId === bindingId && session.revokedAt === null) {
        session.revokedAt = revokedAt;
      }
    }
  }

  private async withEmployeeLock<T>(employeeId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.employeeLocks.get(employeeId) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.employeeLocks.set(employeeId, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.employeeLocks.get(employeeId) === current) this.employeeLocks.delete(employeeId);
    }
  }

  private toDto(row: StoredBinding): DeviceBindingDto {
    return {
      id: row.id,
      employeeId: row.employeeId,
      deviceName: row.deviceName,
      status: row.status,
      requestedAt: row.requestedAt,
      approvedAt: row.approvedAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function setup() {
  const repository = new FakeDeviceBindingAdminRepository();
  const auditEvents: RecordAuditEventInput[] = [];
  const audit = {
    record: async (event: RecordAuditEventInput) => {
      auditEvents.push(event);
      return {} as AuditLog;
    },
  };
  const service = new DeviceBindingService({ repository, audit, now: () => new Date(NOW) });
  return { repository, auditEvents, service };
}

const context = { clientIp: '192.0.2.10', requestId: REQUEST_ID };

describe('device binding Admin approval and revocation', () => {
  it('denies non-Admins before calling the repository', async () => {
    const harness = setup();
    await expect(harness.service.listPending(employee)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    await expect(harness.service.approve(employee, BINDING_ONE_ID)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    await expect(harness.service.revoke(employee, BINDING_ONE_ID)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    expect(harness.repository.calls).toEqual([]);
  });

  it('lists pending bindings using only the safe DTO fields', async () => {
    const harness = setup();
    harness.repository.seed(BINDING_ONE_ID, DeviceBindingStatus.PENDING);
    harness.repository.seed(BINDING_TWO_ID, DeviceBindingStatus.APPROVED);

    const result = await harness.service.listPending(admin);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: BINDING_ONE_ID,
      employeeId: EMPLOYEE_ID,
      deviceName: `Device ${BINDING_ONE_ID.slice(0, 4)}`,
      status: DeviceBindingStatus.PENDING,
      requestedAt: new Date('2026-10-10T08:00:00.000Z'),
      approvedAt: null,
      revokedAt: null,
      createdAt: new Date('2026-10-10T07:00:00.000Z'),
      updatedAt: new Date('2026-10-10T08:00:00.000Z'),
    });
    expect(JSON.stringify(result)).not.toContain('deviceIdHash');
    expect(JSON.stringify(result)).not.toContain('private-device-hash');
  });

  it('approves a pending binding and audits safe before/after snapshots with request context', async () => {
    const harness = setup();
    harness.repository.seed(BINDING_ONE_ID, DeviceBindingStatus.PENDING);

    const result = await harness.service.approve(admin, BINDING_ONE_ID, context);

    expect(result).toMatchObject({
      id: BINDING_ONE_ID,
      status: DeviceBindingStatus.APPROVED,
      approvedAt: NOW,
      revokedAt: null,
    });
    expect(harness.auditEvents).toHaveLength(1);
    expect(harness.auditEvents[0]).toMatchObject({
      actor: admin,
      action: 'device_binding.approved',
      entityType: 'DeviceBinding',
      entityId: BINDING_ONE_ID,
      clientIp: context.clientIp,
      requestId: context.requestId,
      before: { id: BINDING_ONE_ID, status: DeviceBindingStatus.PENDING },
      after: {
        id: BINDING_ONE_ID,
        employeeId: EMPLOYEE_ID,
        status: DeviceBindingStatus.APPROVED,
        approvedAt: NOW,
      },
    });
    expect(JSON.stringify(harness.auditEvents)).not.toContain('deviceIdHash');
    expect(JSON.stringify(harness.auditEvents)).not.toContain('private-device-hash');
  });

  it('replaces an approved binding and revokes all its active sessions in the approval operation', async () => {
    const harness = setup();
    harness.repository.seed(BINDING_ONE_ID, DeviceBindingStatus.APPROVED);
    harness.repository.seed(BINDING_TWO_ID, DeviceBindingStatus.PENDING);
    harness.repository.seedSession(BINDING_ONE_ID, 'old-session-1');
    harness.repository.seedSession(BINDING_ONE_ID, 'old-session-2');
    harness.repository.seedSession(BINDING_TWO_ID, 'pending-session');

    await harness.service.approve(admin, BINDING_TWO_ID, context);

    expect(harness.repository.rows.get(BINDING_ONE_ID)?.status).toBe(DeviceBindingStatus.REVOKED);
    expect(
      harness.repository.sessions.filter((row) => row.deviceBindingId === BINDING_ONE_ID),
    ).toEqual([
      expect.objectContaining({ revokedAt: NOW }),
      expect.objectContaining({ revokedAt: NOW }),
    ]);
    expect(
      harness.repository.sessions.find((row) => row.id === 'pending-session')?.revokedAt,
    ).toBeNull();
    expect(harness.auditEvents.map(({ action }) => action)).toEqual([
      'device_binding.approved',
      'device_binding.revoked',
    ]);
    expect(harness.auditEvents[1]).toMatchObject({
      entityId: BINDING_ONE_ID,
      clientIp: context.clientIp,
      requestId: context.requestId,
      before: { status: DeviceBindingStatus.APPROVED },
      after: { status: DeviceBindingStatus.REVOKED, revokedAt: NOW },
    });
  });

  it('rejects missing or non-pending bindings with 404 and 409 respectively', async () => {
    const harness = setup();
    harness.repository.seed(BINDING_ONE_ID, DeviceBindingStatus.APPROVED);
    harness.repository.seed(BINDING_TWO_ID, DeviceBindingStatus.REVOKED);

    await expect(harness.service.approve(admin, BINDING_THREE_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: 'DEVICE_BINDING_NOT_FOUND',
    });
    await expect(harness.service.approve(admin, BINDING_ONE_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEVICE_BINDING_STATE_CONFLICT',
    });
    await expect(harness.service.approve(admin, BINDING_TWO_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEVICE_BINDING_STATE_CONFLICT',
    });
    await expect(harness.service.approve(admin, 'not-a-uuid')).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_INPUT',
    });
    expect(harness.auditEvents).toHaveLength(0);
  });

  it('revokes bindings, revokes their sessions, and remains safe on repeated revocation', async () => {
    const harness = setup();
    harness.repository.seed(BINDING_ONE_ID, DeviceBindingStatus.APPROVED);
    harness.repository.seedSession(BINDING_ONE_ID, 'active-session');

    const first = await harness.service.revoke(admin, BINDING_ONE_ID, context);
    harness.repository.seedSession(BINDING_ONE_ID, 'late-active-session');
    const second = await harness.service.revoke(admin, BINDING_ONE_ID, context);

    expect(first.status).toBe(DeviceBindingStatus.REVOKED);
    expect(second.status).toBe(DeviceBindingStatus.REVOKED);
    expect(
      harness.repository.sessions.every(
        (session) => session.revokedAt?.getTime() === NOW.getTime(),
      ),
    ).toBe(true);
    expect(harness.auditEvents).toHaveLength(1);
    expect(harness.auditEvents[0]).toMatchObject({
      action: 'device_binding.revoked',
      entityId: BINDING_ONE_ID,
      clientIp: context.clientIp,
      requestId: context.requestId,
      before: { status: DeviceBindingStatus.APPROVED },
      after: { status: DeviceBindingStatus.REVOKED, revokedAt: NOW },
    });
    expect(JSON.stringify(harness.auditEvents)).not.toContain('private-device-hash');
    expect(JSON.stringify(harness.auditEvents)).not.toContain('private-session-hash');
  });

  it('serializes concurrent approvals for one employee and leaves exactly one approved binding', async () => {
    const harness = setup();
    harness.repository.seed(BINDING_ONE_ID, DeviceBindingStatus.APPROVED);
    harness.repository.seed(BINDING_TWO_ID, DeviceBindingStatus.PENDING);
    harness.repository.seed(BINDING_THREE_ID, DeviceBindingStatus.PENDING);
    harness.repository.seedSession(BINDING_ONE_ID, 'previous-approved-session');
    harness.repository.seedSession(BINDING_TWO_ID, 'first-approved-session');

    await Promise.all([
      harness.service.approve(admin, BINDING_TWO_ID, context),
      harness.service.approve(
        { userAccountId: OTHER_ADMIN_ID, role: UserRole.ADMIN },
        BINDING_THREE_ID,
        context,
      ),
    ]);

    const approved = [...harness.repository.rows.values()].filter(
      (row) => row.status === DeviceBindingStatus.APPROVED,
    );
    expect(approved).toHaveLength(1);
    expect(approved[0]?.id).toBe(BINDING_THREE_ID);
    expect(harness.repository.rows.get(BINDING_ONE_ID)?.status).toBe(DeviceBindingStatus.REVOKED);
    expect(harness.repository.rows.get(BINDING_TWO_ID)?.status).toBe(DeviceBindingStatus.REVOKED);
    expect(
      harness.repository.sessions.find((row) => row.id === 'previous-approved-session')?.revokedAt,
    ).toEqual(NOW);
    expect(
      harness.repository.sessions.find((row) => row.id === 'first-approved-session')?.revokedAt,
    ).toEqual(NOW);
  });
});

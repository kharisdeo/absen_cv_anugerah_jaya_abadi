import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DeviceBindingStatus, UserRole } from '../../src/generated/prisma/enums.js';
import type { AuditLog } from '../../src/generated/prisma/client.js';
import type { RecordAuditEventInput } from '../../src/modules/audit/index.js';
import {
  DeviceBindingService,
  type DeviceBindingApprovalResult,
  type DeviceBindingDto,
  type DeviceBindingEnrollmentInput,
  type DeviceBindingEnrollmentResult,
  type DeviceBindingMutation,
  type DeviceBindingRepository,
  type DeviceEnroller,
} from '../../src/modules/device-binding/index.js';

const ACCOUNT_ID = 'd4bb1445-d860-40df-a8c6-cdd898daef80';
const EMPLOYEE_ID = '4d04a7c2-35e8-499a-8a3b-78c730164e5b';
const DEVICE_TOKEN = 'QmFzZTY0VXJsRGV2aWNlVG9rZW5Gb3JVbml0VGVzdHM';
const REQUESTED_AT = new Date('2026-10-11T02:03:04.000Z');
const APPROVED_BY = '6436b4e6-4908-47c1-8c04-7d40f46c85c2';

type StoredBinding = DeviceBindingDto & { approvedByUserAccountId: string | null };

function employeeEnroller(overrides: Partial<DeviceEnroller> = {}): DeviceEnroller {
  return {
    userAccountId: ACCOUNT_ID,
    employeeId: EMPLOYEE_ID,
    role: UserRole.EMPLOYEE,
    ...overrides,
  };
}

function dto(row: StoredBinding): DeviceBindingDto {
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

class FakeDeviceBindingRepository implements DeviceBindingRepository {
  readonly rows = new Map<string, StoredBinding>();
  readonly inputs: DeviceBindingEnrollmentInput[] = [];
  private nextId = 0;

  async enroll(input: DeviceBindingEnrollmentInput): Promise<DeviceBindingEnrollmentResult> {
    this.inputs.push(input);
    const key = `${input.employeeId}:${input.deviceIdHash}`;
    const existing = this.rows.get(key);
    if (existing && existing.status !== DeviceBindingStatus.REVOKED) {
      return { binding: dto(existing), outcome: 'unchanged' };
    }

    if (existing) {
      const reactivated: StoredBinding = {
        ...existing,
        deviceName: input.deviceName,
        status: DeviceBindingStatus.PENDING,
        requestedAt: input.requestedAt,
        approvedByUserAccountId: null,
        approvedAt: null,
        revokedAt: null,
        updatedAt: input.requestedAt,
      };
      this.rows.set(key, reactivated);
      return { binding: dto(reactivated), outcome: 'reactivated' };
    }

    this.nextId += 1;
    const created: StoredBinding = {
      id: `binding-${this.nextId}`,
      employeeId: input.employeeId,
      deviceName: input.deviceName,
      status: DeviceBindingStatus.PENDING,
      requestedAt: input.requestedAt,
      approvedByUserAccountId: null,
      approvedAt: null,
      revokedAt: null,
      createdAt: input.requestedAt,
      updatedAt: input.requestedAt,
    };
    this.rows.set(key, created);
    return { binding: dto(created), outcome: 'created' };
  }

  async listPending(): Promise<readonly DeviceBindingDto[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === DeviceBindingStatus.PENDING)
      .map(dto);
  }

  async approve(): Promise<DeviceBindingApprovalResult> {
    return { outcome: 'not_found' };
  }

  async revoke(): Promise<DeviceBindingMutation | null> {
    return null;
  }
}

function setup() {
  const repository = new FakeDeviceBindingRepository();
  const auditEvents: RecordAuditEventInput[] = [];
  const audit = {
    record: async (event: RecordAuditEventInput) => {
      auditEvents.push(event);
      return {} as AuditLog;
    },
  };
  const service = new DeviceBindingService({
    repository,
    audit,
    now: () => new Date(REQUESTED_AT),
  });
  return { service, repository, auditEvents };
}

function storedFor(repository: FakeDeviceBindingRepository, hash: string): StoredBinding {
  const row = repository.rows.get(`${EMPLOYEE_ID}:${hash}`);
  if (!row) throw new Error('Expected device binding to exist.');
  return row;
}

describe('device binding enrollment', () => {
  it('accepts only employee and supervisor trusted contexts with valid account and employee IDs', async () => {
    const harness = setup();
    const supervisor = employeeEnroller({ role: UserRole.SUPERVISOR });
    await expect(
      harness.service.enroll(supervisor, { deviceToken: DEVICE_TOKEN, deviceName: 'Phone' }),
    ).resolves.toMatchObject({ status: DeviceBindingStatus.PENDING });

    await expect(
      harness.service.enroll(
        employeeEnroller({ role: UserRole.ADMIN } as unknown as Partial<DeviceEnroller>),
        { deviceToken: DEVICE_TOKEN, deviceName: 'Phone' },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    await expect(
      harness.service.enroll(employeeEnroller({ employeeId: 'not-an-id' }), {
        deviceToken: DEVICE_TOKEN,
        deviceName: 'Phone',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_INPUT' });
  });

  it('hashes the token before repository access and never returns or audits the token or hash', async () => {
    const harness = setup();
    const expectedHash = createHash('sha256').update(DEVICE_TOKEN, 'ascii').digest('hex');
    const binding = await harness.service.enroll(employeeEnroller(), {
      deviceToken: DEVICE_TOKEN,
      deviceName: '  Work phone  ',
    });

    expect(harness.repository.inputs[0]).toMatchObject({
      employeeId: EMPLOYEE_ID,
      deviceIdHash: expectedHash,
      deviceName: 'Work phone',
    });
    expect(binding.deviceName).toBe('Work phone');
    expect(binding).not.toHaveProperty('deviceToken');
    expect(binding).not.toHaveProperty('deviceIdHash');
    expect(JSON.stringify(binding)).not.toContain(DEVICE_TOKEN);
    expect(JSON.stringify(binding)).not.toContain(expectedHash);
    expect(JSON.stringify(harness.auditEvents)).not.toContain(DEVICE_TOKEN);
    expect(JSON.stringify(harness.auditEvents)).not.toContain(expectedHash);
    expect(harness.auditEvents[0]).toMatchObject({
      action: 'device_binding.enrolled',
      entityType: 'DeviceBinding',
      entityId: binding.id,
      after: {
        id: binding.id,
        employeeId: EMPLOYEE_ID,
        deviceName: 'Work phone',
        status: DeviceBindingStatus.PENDING,
      },
    });
    expect(harness.auditEvents[0]?.after).toEqual({
      id: binding.id,
      employeeId: EMPLOYEE_ID,
      deviceName: 'Work phone',
      status: DeviceBindingStatus.PENDING,
    });
    expect(harness.auditEvents[0]).not.toHaveProperty('deviceIdHash');
  });

  it('keeps pending and approved enrollments idempotent, then reactivates a revoked row in place', async () => {
    const harness = setup();
    const expectedHash = createHash('sha256').update(DEVICE_TOKEN, 'ascii').digest('hex');
    const input = { deviceToken: DEVICE_TOKEN, deviceName: 'Work phone' };

    const first = await harness.service.enroll(employeeEnroller(), input);
    const pendingRetry = await harness.service.enroll(employeeEnroller(), input);
    expect(first.status).toBe(DeviceBindingStatus.PENDING);
    expect(pendingRetry.id).toBe(first.id);
    expect(harness.repository.rows.size).toBe(1);
    expect(harness.auditEvents).toHaveLength(1);

    const row = storedFor(harness.repository, expectedHash);
    const approvedAt = new Date('2026-10-11T03:00:00.000Z');
    harness.repository.rows.set(`${EMPLOYEE_ID}:${expectedHash}`, {
      ...row,
      status: DeviceBindingStatus.APPROVED,
      approvedByUserAccountId: APPROVED_BY,
      approvedAt,
    });
    const approvedRetry = await harness.service.enroll(employeeEnroller(), input);
    expect(approvedRetry).toMatchObject({ id: first.id, status: DeviceBindingStatus.APPROVED });
    expect(harness.auditEvents).toHaveLength(1);

    harness.repository.rows.set(`${EMPLOYEE_ID}:${expectedHash}`, {
      ...storedFor(harness.repository, expectedHash),
      status: DeviceBindingStatus.REVOKED,
      approvedByUserAccountId: APPROVED_BY,
      approvedAt,
      revokedAt: new Date('2026-10-11T03:30:00.000Z'),
    });
    const reactivated = await harness.service.enroll(employeeEnroller(), {
      ...input,
      deviceName: 'Replacement phone label',
    });
    expect(reactivated).toMatchObject({
      id: first.id,
      employeeId: EMPLOYEE_ID,
      deviceName: 'Replacement phone label',
      status: DeviceBindingStatus.PENDING,
      requestedAt: REQUESTED_AT,
      approvedAt: null,
      revokedAt: null,
    });
    expect(storedFor(harness.repository, expectedHash).approvedByUserAccountId).toBeNull();
    expect(harness.repository.rows.size).toBe(1);
    expect(harness.auditEvents).toHaveLength(2);
    expect(harness.auditEvents[1]).toMatchObject({ action: 'device_binding.reactivated' });
    expect(JSON.stringify(harness.auditEvents)).not.toContain(DEVICE_TOKEN);
    expect(JSON.stringify(harness.auditEvents)).not.toContain(expectedHash);
  });

  it('rejects tokens outside the bounded base64url-like format', async () => {
    const harness = setup();
    for (const deviceToken of [
      'a'.repeat(31),
      'a'.repeat(129),
      `${'a'.repeat(31)}+`,
      `${'a'.repeat(31)} `,
      'é'.repeat(32),
    ]) {
      await expect(
        harness.service.enroll(employeeEnroller(), { deviceToken, deviceName: 'Phone' }),
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_INPUT' });
    }
    expect(harness.repository.inputs).toHaveLength(0);
  });

  it('trims names and rejects empty, controlled, or overlong names', async () => {
    const harness = setup();
    const binding = await harness.service.enroll(employeeEnroller(), {
      deviceToken: DEVICE_TOKEN,
      deviceName: '  Staff handset  ',
    });
    expect(binding.deviceName).toBe('Staff handset');

    for (const deviceName of ['', '   ', 'Phone\nName', 'Phone\u007fName', 'x'.repeat(101)]) {
      await expect(
        harness.service.enroll(employeeEnroller(), { deviceToken: DEVICE_TOKEN, deviceName }),
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_INPUT' });
    }
    expect(harness.repository.inputs).toHaveLength(1);
  });

  it('rejects a name that would copy the token or hash into persistence or audit', async () => {
    const harness = setup();
    const hash = createHash('sha256').update(DEVICE_TOKEN, 'ascii').digest('hex');

    await expect(
      harness.service.enroll(employeeEnroller(), {
        deviceToken: DEVICE_TOKEN,
        deviceName: DEVICE_TOKEN,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_INPUT' });
    await expect(
      harness.service.enroll(employeeEnroller(), {
        deviceToken: DEVICE_TOKEN,
        deviceName: hash,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_INPUT' });
    expect(harness.repository.inputs).toHaveLength(0);
    expect(harness.auditEvents).toHaveLength(0);
  });

  it('does not copy a token or its hash from optional context into the audit event', async () => {
    const harness = setup();
    const hash = createHash('sha256').update(DEVICE_TOKEN, 'ascii').digest('hex');
    await harness.service.enroll(
      employeeEnroller(),
      { deviceToken: DEVICE_TOKEN, deviceName: 'Phone' },
      { requestId: DEVICE_TOKEN },
    );
    expect(JSON.stringify(harness.auditEvents)).not.toContain(DEVICE_TOKEN);
    expect(JSON.stringify(harness.auditEvents)).not.toContain(hash);
    expect(harness.auditEvents[0]).not.toHaveProperty('requestId');
  });
});

import { DeviceBindingStatus } from '../../src/generated/prisma/enums.js';
import type { AuditService } from '../../src/modules/audit/index.js';
import {
  DeviceBindingService,
  type DeviceBindingApprovalInput,
  type DeviceBindingApprovalResult,
  type DeviceBindingDto,
  type DeviceBindingEnrollmentInput,
  type DeviceBindingEnrollmentResult,
  type DeviceBindingMutation,
  type DeviceBindingRevocationInput,
  type DeviceBindingRepository,
} from '../../src/modules/device-binding/index.js';

type StoredBinding = DeviceBindingDto & { deviceIdHash: string };

export class FakeDeviceBindingRepository implements DeviceBindingRepository {
  readonly rows = new Map<string, StoredBinding>();
  readonly enrollmentInputs: DeviceBindingEnrollmentInput[] = [];
  private nextId = 0;

  async enroll(input: DeviceBindingEnrollmentInput): Promise<DeviceBindingEnrollmentResult> {
    this.enrollmentInputs.push(input);
    const existing = [...this.rows.values()].find(
      (row) => row.employeeId === input.employeeId && row.deviceIdHash === input.deviceIdHash,
    );
    if (existing && existing.status !== DeviceBindingStatus.REVOKED) {
      return { binding: this.toDto(existing), outcome: 'unchanged' };
    }

    if (existing) {
      const reactivated: StoredBinding = {
        ...existing,
        deviceName: input.deviceName,
        status: DeviceBindingStatus.PENDING,
        requestedAt: input.requestedAt,
        approvedAt: null,
        revokedAt: null,
        updatedAt: input.requestedAt,
      };
      this.rows.set(reactivated.id, reactivated);
      return { binding: this.toDto(reactivated), outcome: 'reactivated' };
    }

    this.nextId += 1;
    const row: StoredBinding = {
      id: `00000000-0000-4000-8000-${String(this.nextId).padStart(12, '0')}`,
      employeeId: input.employeeId,
      deviceIdHash: input.deviceIdHash,
      deviceName: input.deviceName,
      status: DeviceBindingStatus.PENDING,
      requestedAt: input.requestedAt,
      approvedAt: null,
      revokedAt: null,
      createdAt: input.requestedAt,
      updatedAt: input.requestedAt,
    };
    this.rows.set(row.id, row);
    return { binding: this.toDto(row), outcome: 'created' };
  }

  async listPending(): Promise<readonly DeviceBindingDto[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === DeviceBindingStatus.PENDING)
      .map((row) => this.toDto(row));
  }

  async approve(input: DeviceBindingApprovalInput): Promise<DeviceBindingApprovalResult> {
    const target = this.findById(input.bindingId);
    if (!target) return { outcome: 'not_found' };
    if (target.status !== DeviceBindingStatus.PENDING) {
      return { outcome: 'invalid_state', binding: this.toDto(target) };
    }

    const revoked: DeviceBindingMutation[] = [];
    for (const previous of this.rows.values()) {
      if (
        previous.employeeId !== target.employeeId ||
        previous.id === target.id ||
        previous.status !== DeviceBindingStatus.APPROVED
      ) {
        continue;
      }
      const after: StoredBinding = {
        ...previous,
        status: DeviceBindingStatus.REVOKED,
        revokedAt: input.approvedAt,
        updatedAt: input.approvedAt,
      };
      this.rows.set(after.id, after);
      revoked.push({ before: this.toDto(previous), after: this.toDto(after) });
    }

    const after: StoredBinding = {
      ...target,
      status: DeviceBindingStatus.APPROVED,
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
  }

  async revoke(input: DeviceBindingRevocationInput): Promise<DeviceBindingMutation | null> {
    const before = this.findById(input.bindingId);
    if (!before) return null;
    const after: StoredBinding = {
      ...before,
      status: DeviceBindingStatus.REVOKED,
      revokedAt: before.revokedAt ?? input.revokedAt,
      updatedAt: input.revokedAt,
    };
    this.rows.set(after.id, after);
    return { before: this.toDto(before), after: this.toDto(after) };
  }

  findById(id: string): StoredBinding | null {
    return this.rows.get(id) ?? null;
  }

  setStatus(id: string, status: DeviceBindingStatus): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Unknown fake device binding ${id}.`);
    const changedAt = new Date(row.updatedAt.getTime() + 1);
    this.rows.set(id, {
      ...row,
      status,
      approvedAt: status === DeviceBindingStatus.APPROVED ? changedAt : row.approvedAt,
      revokedAt: status === DeviceBindingStatus.REVOKED ? changedAt : null,
      updatedAt: changedAt,
    });
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

export function createFakeDeviceBindingService(
  repository: FakeDeviceBindingRepository,
  audit: Pick<AuditService, 'record'>,
  now?: () => Date,
): DeviceBindingService {
  return new DeviceBindingService({ repository, audit, ...(now ? { now } : {}) });
}

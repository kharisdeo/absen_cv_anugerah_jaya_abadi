import { DeviceBindingStatus } from '../../generated/prisma/enums.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type {
  DeviceBindingDto,
  DeviceBindingApprovalInput,
  DeviceBindingApprovalResult,
  DeviceBindingEnrollmentInput,
  DeviceBindingEnrollmentResult,
  DeviceBindingMutation,
  DeviceBindingRevocationInput,
  DeviceBindingRepository,
} from './index.js';

const deviceBindingSelect = {
  id: true,
  employeeId: true,
  deviceName: true,
  status: true,
  requestedAt: true,
  approvedAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type DeviceBindingRow = Prisma.DeviceBindingGetPayload<{ select: typeof deviceBindingSelect }>;

function toDto(row: DeviceBindingRow): DeviceBindingDto {
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

/** Shared by device enrollment, approval, and authentication transactions for one employee. */
export async function acquireDeviceBindingEmployeeLock(
  tx: Prisma.TransactionClient,
  employeeId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`
      WITH device_binding_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtext('device_binding_employee'),
          hashtext(${employeeId})
        )
      )
      SELECT TRUE AS locked FROM device_binding_lock
    `,
  );
}

export class PrismaDeviceBindingRepository implements DeviceBindingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async enroll(input: DeviceBindingEnrollmentInput): Promise<DeviceBindingEnrollmentResult> {
    return this.prisma.$transaction(async (tx) => {
      await acquireDeviceBindingEmployeeLock(tx, input.employeeId);

      const existing = await tx.deviceBinding.findUnique({
        where: {
          employeeId_deviceIdHash: {
            employeeId: input.employeeId,
            deviceIdHash: input.deviceIdHash,
          },
        },
        select: deviceBindingSelect,
      });

      if (!existing) {
        const created = await tx.deviceBinding.create({
          data: {
            employeeId: input.employeeId,
            deviceIdHash: input.deviceIdHash,
            deviceName: input.deviceName,
            status: DeviceBindingStatus.PENDING,
            requestedAt: input.requestedAt,
          },
          select: deviceBindingSelect,
        });
        return { binding: toDto(created), outcome: 'created' };
      }

      if (existing.status !== DeviceBindingStatus.REVOKED) {
        return { binding: toDto(existing), outcome: 'unchanged' };
      }

      await tx.session.updateMany({
        where: { deviceBindingId: existing.id, revokedAt: null },
        data: { revokedAt: input.requestedAt },
      });

      const reactivated = await tx.deviceBinding.update({
        where: { id: existing.id },
        data: {
          deviceName: input.deviceName,
          status: DeviceBindingStatus.PENDING,
          requestedAt: input.requestedAt,
          approvedByUserAccountId: null,
          approvedAt: null,
          revokedAt: null,
        },
        select: deviceBindingSelect,
      });
      return { binding: toDto(reactivated), outcome: 'reactivated' };
    });
  }

  async listPending(): Promise<readonly DeviceBindingDto[]> {
    const rows = await this.prisma.deviceBinding.findMany({
      where: { status: DeviceBindingStatus.PENDING },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      select: deviceBindingSelect,
    });
    return rows.map(toDto);
  }

  async approve(input: DeviceBindingApprovalInput): Promise<DeviceBindingApprovalResult> {
    return this.prisma.$transaction(async (tx) => {
      const initial = await tx.deviceBinding.findUnique({
        where: { id: input.bindingId },
        select: { employeeId: true },
      });
      if (!initial) return { outcome: 'not_found' };

      await acquireDeviceBindingEmployeeLock(tx, initial.employeeId);

      const target = await tx.deviceBinding.findUnique({
        where: { id: input.bindingId },
        select: deviceBindingSelect,
      });
      if (!target) return { outcome: 'not_found' };
      if (target.status !== DeviceBindingStatus.PENDING) {
        return { outcome: 'invalid_state', binding: toDto(target) };
      }

      const approvedBindings = await tx.deviceBinding.findMany({
        where: {
          employeeId: initial.employeeId,
          status: DeviceBindingStatus.APPROVED,
          id: { not: input.bindingId },
        },
        select: deviceBindingSelect,
      });
      const revoked: DeviceBindingMutation[] = [];
      for (const binding of approvedBindings) {
        const updated = await tx.deviceBinding.update({
          where: { id: binding.id },
          data: {
            status: DeviceBindingStatus.REVOKED,
            revokedAt: input.approvedAt,
          },
          select: deviceBindingSelect,
        });
        revoked.push({ before: toDto(binding), after: toDto(updated) });
      }

      if (approvedBindings.length > 0) {
        await tx.session.updateMany({
          where: {
            deviceBindingId: { in: approvedBindings.map(({ id }) => id) },
            revokedAt: null,
          },
          data: { revokedAt: input.approvedAt },
        });
      }

      const approved = await tx.deviceBinding.update({
        where: { id: input.bindingId },
        data: {
          status: DeviceBindingStatus.APPROVED,
          approvedByUserAccountId: input.approvedByUserAccountId,
          approvedAt: input.approvedAt,
          revokedAt: null,
        },
        select: deviceBindingSelect,
      });
      return {
        outcome: 'approved',
        mutation: { before: toDto(target), after: toDto(approved) },
        revoked,
      };
    });
  }

  async revoke(input: DeviceBindingRevocationInput): Promise<DeviceBindingMutation | null> {
    return this.prisma.$transaction(async (tx) => {
      const initial = await tx.deviceBinding.findUnique({
        where: { id: input.bindingId },
        select: { employeeId: true },
      });
      if (!initial) return null;

      await acquireDeviceBindingEmployeeLock(tx, initial.employeeId);

      const target = await tx.deviceBinding.findUnique({
        where: { id: input.bindingId },
        select: deviceBindingSelect,
      });
      if (!target) return null;

      await tx.session.updateMany({
        where: { deviceBindingId: input.bindingId, revokedAt: null },
        data: { revokedAt: input.revokedAt },
      });

      const after =
        target.status === DeviceBindingStatus.REVOKED && target.revokedAt !== null
          ? target
          : await tx.deviceBinding.update({
              where: { id: input.bindingId },
              data: {
                status: DeviceBindingStatus.REVOKED,
                revokedAt: target.revokedAt ?? input.revokedAt,
              },
              select: deviceBindingSelect,
            });
      return { before: toDto(target), after: toDto(after) };
    });
  }
}

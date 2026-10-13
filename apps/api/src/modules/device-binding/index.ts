import { createHash } from 'node:crypto';

import { DeviceBindingStatus, UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuditActor, AuditService } from '../audit/index.js';

export type DeviceEnroller = Readonly<{
  userAccountId: string;
  employeeId: string;
  role: typeof UserRole.EMPLOYEE | typeof UserRole.SUPERVISOR;
}>;

export type DeviceBindingDto = Readonly<{
  id: string;
  employeeId: string;
  deviceName: string;
  status: DeviceBindingStatus;
  requestedAt: Date;
  approvedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type DeviceBindingEnrollmentInput = Readonly<{
  employeeId: string;
  deviceIdHash: string;
  deviceName: string;
  requestedAt: Date;
}>;

export type DeviceBindingEnrollmentResult = Readonly<{
  binding: DeviceBindingDto;
  outcome: 'created' | 'unchanged' | 'reactivated';
}>;

export type DeviceBindingMutation = Readonly<{
  before: DeviceBindingDto;
  after: DeviceBindingDto;
}>;

export type DeviceBindingApprovalResult =
  | Readonly<{
      outcome: 'approved';
      mutation: DeviceBindingMutation;
      revoked: readonly DeviceBindingMutation[];
    }>
  | Readonly<{ outcome: 'not_found' }>
  | Readonly<{ outcome: 'invalid_state'; binding: DeviceBindingDto }>;

export type DeviceBindingApprovalInput = Readonly<{
  bindingId: string;
  approvedByUserAccountId: string;
  approvedAt: Date;
}>;

export type DeviceBindingRevocationInput = Readonly<{
  bindingId: string;
  revokedAt: Date;
}>;

/** Enrollment must be idempotent for an employee and token hash across API instances. */
export interface DeviceBindingRepository {
  enroll(input: DeviceBindingEnrollmentInput): Promise<DeviceBindingEnrollmentResult>;
  listPending(): Promise<readonly DeviceBindingDto[]>;
  approve(input: DeviceBindingApprovalInput): Promise<DeviceBindingApprovalResult>;
  revoke(input: DeviceBindingRevocationInput): Promise<DeviceBindingMutation | null>;
}

export type DeviceBindingAuditContext = Readonly<{
  clientIp?: string;
  requestId?: string;
}>;

export type DeviceEnrollmentInput = Readonly<{
  deviceToken: unknown;
  deviceName: unknown;
}>;

export interface DeviceBindingServiceOptions {
  repository: DeviceBindingRepository;
  audit: Pick<AuditService, 'record'>;
  now?: () => Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function invalidInput(): AppError {
  return new AppError(400, 'INVALID_INPUT', 'Data pendaftaran perangkat tidak valid.');
}

function forbidden(): AppError {
  return new AppError(403, 'FORBIDDEN', 'Peran ini tidak dapat mendaftarkan perangkat.');
}

function adminForbidden(): AppError {
  return new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola perangkat.');
}

function bindingNotFound(): AppError {
  return new AppError(404, 'DEVICE_BINDING_NOT_FOUND', 'Pendaftaran perangkat tidak ditemukan.');
}

function bindingStateConflict(): AppError {
  return new AppError(
    409,
    'DEVICE_BINDING_STATE_CONFLICT',
    'Status pendaftaran perangkat tidak dapat disetujui.',
  );
}

function normalizeBindingId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw invalidInput();
  return value;
}

function assertAdmin(actor: AuditActor): void {
  if (actor.role !== UserRole.ADMIN) throw adminForbidden();
}

function safeDto(binding: DeviceBindingDto): DeviceBindingDto {
  return {
    id: binding.id,
    employeeId: binding.employeeId,
    deviceName: binding.deviceName,
    status: binding.status,
    requestedAt: binding.requestedAt,
    approvedAt: binding.approvedAt,
    revokedAt: binding.revokedAt,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function bindingSnapshot(binding: DeviceBindingDto): Record<string, unknown> {
  return safeDto(binding);
}

function sameBindingSnapshot(left: DeviceBindingDto, right: DeviceBindingDto): boolean {
  return JSON.stringify(bindingSnapshot(left)) === JSON.stringify(bindingSnapshot(right));
}

function auditContext(
  context: DeviceBindingAuditContext,
): Pick<DeviceBindingAuditContext, 'clientIp' | 'requestId'> {
  return {
    ...(context.clientIp ? { clientIp: context.clientIp } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
  };
}

function normalizeEnroller(value: DeviceEnroller): DeviceEnroller {
  if (typeof value !== 'object' || value === null) throw invalidInput();

  const candidate = value as unknown as Record<string, unknown>;
  if (
    typeof candidate.userAccountId !== 'string' ||
    !UUID_PATTERN.test(candidate.userAccountId) ||
    typeof candidate.employeeId !== 'string' ||
    !UUID_PATTERN.test(candidate.employeeId)
  ) {
    throw invalidInput();
  }
  if (candidate.role !== UserRole.EMPLOYEE && candidate.role !== UserRole.SUPERVISOR) {
    throw forbidden();
  }

  return {
    userAccountId: candidate.userAccountId,
    employeeId: candidate.employeeId,
    role: candidate.role,
  };
}

function normalizeDeviceToken(value: unknown): string {
  if (typeof value !== 'string' || !DEVICE_TOKEN_PATTERN.test(value)) throw invalidInput();
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function normalizeDeviceName(value: unknown, deviceToken: string, deviceIdHash: string): string {
  if (typeof value !== 'string' || hasControlCharacter(value)) throw invalidInput();
  const name = value.trim();
  if (
    name.length === 0 ||
    name.length > 100 ||
    name.includes(deviceToken) ||
    name.includes(deviceIdHash)
  ) {
    throw invalidInput();
  }
  return name;
}

function auditActor(enroller: DeviceEnroller): AuditActor {
  if (enroller.role === UserRole.EMPLOYEE) {
    return {
      userAccountId: enroller.userAccountId,
      role: enroller.role,
      employeeId: enroller.employeeId,
    };
  }
  return { userAccountId: enroller.userAccountId, role: enroller.role };
}

export class DeviceBindingService {
  private readonly now: () => Date;

  constructor(private readonly options: DeviceBindingServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async enroll(
    enroller: DeviceEnroller,
    input: DeviceEnrollmentInput,
    context: DeviceBindingAuditContext = {},
  ): Promise<DeviceBindingDto> {
    const trustedEnroller = normalizeEnroller(enroller);
    const deviceToken = normalizeDeviceToken(input.deviceToken);
    const deviceIdHash = createHash('sha256').update(deviceToken, 'ascii').digest('hex');
    const deviceName = normalizeDeviceName(input.deviceName, deviceToken, deviceIdHash);
    const result = await this.options.repository.enroll({
      employeeId: trustedEnroller.employeeId,
      deviceIdHash,
      deviceName,
      requestedAt: this.now(),
    });

    if (result.outcome === 'created' || result.outcome === 'reactivated') {
      const requestId =
        context.requestId && context.requestId !== deviceToken && context.requestId !== deviceIdHash
          ? context.requestId
          : undefined;
      const auditDeviceName =
        result.binding.deviceName.includes(deviceToken) ||
        result.binding.deviceName.includes(deviceIdHash)
          ? '[redacted]'
          : result.binding.deviceName;
      await this.options.audit.record({
        actor: auditActor(trustedEnroller),
        action:
          result.outcome === 'created' ? 'device_binding.enrolled' : 'device_binding.reactivated',
        entityType: 'DeviceBinding',
        entityId: result.binding.id,
        after: {
          id: result.binding.id,
          employeeId: result.binding.employeeId,
          deviceName: auditDeviceName,
          status: result.binding.status,
        },
        ...(context.clientIp ? { clientIp: context.clientIp } : {}),
        ...(requestId ? { requestId } : {}),
      });
    }

    return result.binding;
  }

  async listPending(actor: AuditActor): Promise<readonly DeviceBindingDto[]> {
    assertAdmin(actor);
    return (await this.options.repository.listPending()).map(safeDto);
  }

  async approve(
    actor: AuditActor,
    bindingId: string,
    context: DeviceBindingAuditContext = {},
  ): Promise<DeviceBindingDto> {
    assertAdmin(actor);
    const id = normalizeBindingId(bindingId);
    const result = await this.options.repository.approve({
      bindingId: id,
      approvedByUserAccountId: actor.userAccountId,
      approvedAt: this.now(),
    });

    if (result.outcome === 'not_found') throw bindingNotFound();
    if (result.outcome === 'invalid_state') throw bindingStateConflict();

    const mutation = {
      before: safeDto(result.mutation.before),
      after: safeDto(result.mutation.after),
    };
    await this.options.audit.record({
      actor,
      action: 'device_binding.approved',
      entityType: 'DeviceBinding',
      entityId: id,
      before: bindingSnapshot(mutation.before),
      after: bindingSnapshot(mutation.after),
      ...auditContext(context),
    });

    for (const revoked of result.revoked) {
      const safeRevoked = {
        before: safeDto(revoked.before),
        after: safeDto(revoked.after),
      };
      await this.options.audit.record({
        actor,
        action: 'device_binding.revoked',
        entityType: 'DeviceBinding',
        entityId: safeRevoked.after.id,
        before: bindingSnapshot(safeRevoked.before),
        after: bindingSnapshot(safeRevoked.after),
        reason: 'Replaced by another approved device binding.',
        ...auditContext(context),
      });
    }

    return mutation.after;
  }

  async revoke(
    actor: AuditActor,
    bindingId: string,
    context: DeviceBindingAuditContext = {},
  ): Promise<DeviceBindingDto> {
    assertAdmin(actor);
    const id = normalizeBindingId(bindingId);
    const mutation = await this.options.repository.revoke({
      bindingId: id,
      revokedAt: this.now(),
    });
    if (!mutation) throw bindingNotFound();

    const safeMutation = {
      before: safeDto(mutation.before),
      after: safeDto(mutation.after),
    };
    if (!sameBindingSnapshot(safeMutation.before, safeMutation.after)) {
      await this.options.audit.record({
        actor,
        action: 'device_binding.revoked',
        entityType: 'DeviceBinding',
        entityId: id,
        before: bindingSnapshot(safeMutation.before),
        after: bindingSnapshot(safeMutation.after),
        ...auditContext(context),
      });
    }
    return safeMutation.after;
  }
}

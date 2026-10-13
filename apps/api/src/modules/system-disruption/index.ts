import { randomUUID } from 'node:crypto';

import { UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuditActor, AuditService } from '../audit/index.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;

export type SystemDisruptionRecord = Readonly<{
  id: string;
  storeId: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  isActive: boolean;
  createdByUserAccountId: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type SystemDisruptionDto = Readonly<{
  id: string;
  storeId: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type SystemDisruptionCreateInput = Readonly<{
  storeId?: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
}>;

export type SystemDisruptionFilter = Readonly<{
  storeId?: string;
  page?: number;
  pageSize?: number;
}>;

export type SystemDisruptionPage = Readonly<{
  items: readonly SystemDisruptionDto[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

export interface SystemDisruptionRepository {
  create(
    input: Readonly<{
      id: string;
      storeId: string | null;
      startsAt: Date;
      endsAt: Date;
      reason: string;
      createdByUserAccountId: string;
    }>,
  ): Promise<SystemDisruptionRecord>;
  list(
    input: Readonly<{
      storeId?: string;
      skip: number;
      take: number;
    }>,
  ): Promise<Readonly<{ items: readonly SystemDisruptionRecord[]; hasNextPage: boolean }>>;
}

export type SystemDisruptionRequestContext = Readonly<{ clientIp?: string; requestId?: string }>;

function invalidInput(message = 'Data gangguan sistem tidak valid.'): AppError {
  return new AppError(400, 'INVALID_SYSTEM_DISRUPTION', message);
}

function assertAdmin(actor: AuditActor): void {
  if (actor.role !== UserRole.ADMIN) {
    throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola gangguan sistem.');
  }
}

function normalizeUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalidInput(`${field} tidak valid.`);
  }
  return value.toLowerCase();
}

function normalizeStoreId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return normalizeUuid(value, 'storeId');
}

function parseTimestamp(value: unknown, field: string): Date {
  if (typeof value !== 'string')
    throw invalidInput(`${field} harus berupa timestamp ISO dengan zona waktu.`);
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) throw invalidInput(`${field} harus berupa timestamp ISO dengan zona waktu.`);
  const calendarDate = new Date(`${match[1]}T00:00:00.000Z`);
  const parsed = new Date(value);
  if (
    Number.isNaN(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== match[1] ||
    Number.isNaN(parsed.getTime())
  ) {
    throw invalidInput(`${field} bukan timestamp kalender yang valid.`);
  }
  return parsed;
}

function normalizeReason(value: unknown): string {
  if (typeof value !== 'string') throw invalidInput('reason wajib berupa teks.');
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 500 ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw invalidInput('reason wajib diisi dan maksimal 500 karakter.');
  }
  return normalized;
}

function normalizeFilter(input: SystemDisruptionFilter) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 25;
  if (!Number.isInteger(page) || page < 1 || page > 10_000) {
    throw invalidInput('page di luar batas.');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw invalidInput('pageSize harus antara 1 dan 50.');
  }
  return {
    page,
    pageSize,
    ...(input.storeId === undefined ? {} : { storeId: normalizeUuid(input.storeId, 'storeId') }),
  };
}

function toDto(row: SystemDisruptionRecord): SystemDisruptionDto {
  return {
    id: row.id,
    storeId: row.storeId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function auditContext(context: SystemDisruptionRequestContext) {
  return {
    ...(context.clientIp ? { clientIp: context.clientIp } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
  };
}

export class SystemDisruptionService {
  constructor(
    private readonly repository: SystemDisruptionRepository,
    private readonly audit: Pick<AuditService, 'record'>,
  ) {}

  async create(
    actor: AuditActor,
    input: SystemDisruptionCreateInput,
    context: SystemDisruptionRequestContext = {},
  ): Promise<SystemDisruptionDto> {
    assertAdmin(actor);
    const storeId = normalizeStoreId(input.storeId);
    const startsAt = parseTimestamp(input.startsAt, 'startsAt');
    const endsAt = parseTimestamp(input.endsAt, 'endsAt');
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw invalidInput('endsAt harus setelah startsAt.');
    }
    const reason = normalizeReason(input.reason);
    const row = await this.repository.create({
      id: randomUUID(),
      storeId,
      startsAt,
      endsAt,
      reason,
      createdByUserAccountId: normalizeUuid(actor.userAccountId, 'actor.userAccountId'),
    });
    const disruption = toDto(row);
    await this.audit.record({
      actor,
      action: 'system_disruption.create',
      entityType: 'system_disruption',
      entityId: disruption.id,
      after: {
        storeId: disruption.storeId,
        startsAt: disruption.startsAt,
        endsAt: disruption.endsAt,
        isActive: disruption.isActive,
      },
      reason: disruption.reason,
      ...auditContext(context),
    });
    return disruption;
  }

  async list(
    actor: AuditActor,
    filter: SystemDisruptionFilter = {},
  ): Promise<SystemDisruptionPage> {
    assertAdmin(actor);
    const normalized = normalizeFilter(filter);
    const result = await this.repository.list({
      ...(normalized.storeId === undefined ? {} : { storeId: normalized.storeId }),
      skip: (normalized.page - 1) * normalized.pageSize,
      take: normalized.pageSize + 1,
    });
    return {
      items: result.items.slice(0, normalized.pageSize).map(toDto),
      page: normalized.page,
      pageSize: normalized.pageSize,
      hasNextPage: result.hasNextPage,
    };
  }
}

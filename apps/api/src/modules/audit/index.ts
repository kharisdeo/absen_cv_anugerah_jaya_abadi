import { isIP } from 'node:net';

import { UserRole } from '../../generated/prisma/enums.js';
import type { AuditLog, Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import type { AuthorizationActor } from '../authorization/index.js';
import { assertBusinessDate } from '../time/index.js';

/** A verified authorization actor paired with the account ID from the same trusted session. */
export type AuditActor = AuthorizationActor & { readonly userAccountId: string };

export type AuditLogCreateData = Readonly<{
  actorUserAccountId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeData?: Prisma.InputJsonValue;
  afterData?: Prisma.InputJsonValue;
  reason: string | null;
  clientIp: string | null;
  deviceIdHash: string | null;
  requestId: string | null;
}>;

export type AuditLogWhere = Readonly<{
  actorUserAccountId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  occurredAt?: Readonly<{ gte?: Date; lte?: Date }>;
}>;

export type AuditLogFindManyQuery = Readonly<{
  where: AuditLogWhere;
  skip: number;
  take: number;
  orderBy: readonly [{ readonly occurredAt: 'desc' }, { readonly id: 'desc' }];
}>;

/** Intentionally limited to append and read operations; persistence owns occurredAt's default. */
export interface AuditLogRepository {
  create(data: AuditLogCreateData): Promise<AuditLog>;
  findMany(query: AuditLogFindManyQuery): Promise<readonly AuditLog[]>;
}

export type RecordAuditEventInput = Readonly<{
  actor: AuditActor | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  clientIp?: string | null;
  deviceIdHash?: string | null;
  requestId?: string | null;
}>;

export type AuditLogFilterInput = Readonly<{
  actorUserAccountId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}>;

export type AuditLogPage = Readonly<{
  items: readonly AuditLog[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;
const MAX_SNAPSHOT_DEPTH = 12;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/;
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'passphrase',
  'token',
  'cookie',
  'secret',
  'credential',
  'authorization',
  'auth',
  'session',
  'selfie',
  'photo',
  'image',
  'gps',
  'latitude',
  'longitude',
  'coordinate',
  'geolocation',
  'location',
  'base64',
  'biometric',
  'privatekey',
  'apikey',
  'clientip',
  'ipaddress',
  'remoteaddress',
] as const;

const ORDER_BY = [{ occurredAt: 'desc' }, { id: 'desc' }] as const;

function invalidInput(message = 'Data audit tidak valid.'): AppError {
  return new AppError(400, 'INVALID_AUDIT_INPUT', message);
}

function normalizeRequiredText(value: unknown, field: string, maxLength = 100): string {
  if (typeof value !== 'string') throw invalidInput(`${field} wajib berupa teks.`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw invalidInput(`${field} tidak valid.`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  return normalizeRequiredText(value, field, maxLength);
}

function normalizeActionOrEntityType(value: unknown, field: string): string {
  const normalized = normalizeRequiredText(value, field, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(normalized)) {
    throw invalidInput(
      `${field} hanya boleh berisi huruf, angka, titik, garis bawah, titik dua, atau tanda hubung.`,
    );
  }
  return normalized;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized === 'lat' ||
    normalized === 'lng' ||
    normalized === 'lon' ||
    SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))
  );
}

function sanitizeSnapshotValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
  allowStoreGeofenceCoordinates: boolean,
): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (depth > MAX_SNAPSHOT_DEPTH || typeof value !== 'object') throw invalidInput();

  if (ancestors.has(value)) throw invalidInput();
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        sanitizeSnapshotValue(item, ancestors, depth + 1, allowStoreGeofenceCoordinates),
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidInput();

    const sanitized: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, child] of Object.entries(value)) {
      const isTopLevelStoreCoordinate =
        allowStoreGeofenceCoordinates && depth === 0 && (key === 'latitude' || key === 'longitude');
      if (isSensitiveKey(key) && !isTopLevelStoreCoordinate) continue;
      sanitized[key] = sanitizeSnapshotValue(
        child,
        ancestors,
        depth + 1,
        allowStoreGeofenceCoordinates,
      );
    }
    return sanitized as Prisma.InputJsonObject;
  } finally {
    ancestors.delete(value);
  }
}

function sanitizeSnapshot(
  value: unknown,
  allowStoreGeofenceCoordinates = false,
): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidInput();
  return sanitizeSnapshotValue(
    value,
    new WeakSet<object>(),
    0,
    allowStoreGeofenceCoordinates,
  ) as Prisma.InputJsonValue;
}

function normalizeUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value))
    throw invalidInput(`${field} tidak valid.`);
  return value.toLowerCase();
}

function parseTimestamp(value: unknown, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw invalidInput(`${field} harus berupa timestamp ISO dengan zona waktu.`);
  }
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) throw invalidInput(`${field} harus berupa timestamp ISO dengan zona waktu.`);

  try {
    assertBusinessDate(match[1]!);
  } catch {
    throw invalidInput(`${field} tidak valid.`);
  }

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[6] === 'Z' ? 0 : Number(match[7]);
  const offsetMinute = match[6] === 'Z' ? 0 : Number(match[8]);
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw invalidInput(`${field} tidak valid.`);
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalidInput(`${field} tidak valid.`);
  return date;
}

function normalizeFilter(input: AuditLogFilterInput = {}): {
  where: AuditLogWhere;
  page: number;
  pageSize: number;
} {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalidInput();
  const allowedKeys = new Set([
    'actorUserAccountId',
    'action',
    'entityType',
    'entityId',
    'from',
    'to',
    'page',
    'pageSize',
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw invalidInput();

  const actorUserAccountId = normalizeUuid(input.actorUserAccountId, 'actorUserAccountId');
  const action =
    input.action === undefined ? undefined : normalizeActionOrEntityType(input.action, 'action');
  const entityType =
    input.entityType === undefined
      ? undefined
      : normalizeActionOrEntityType(input.entityType, 'entityType');
  const entityId =
    input.entityId === undefined
      ? undefined
      : normalizeRequiredText(input.entityId, 'entityId', 128);
  const from = parseTimestamp(input.from, 'from');
  const to = parseTimestamp(input.to, 'to');
  if (from && to && from.getTime() > to.getTime())
    throw invalidInput('Rentang waktu audit tidak valid.');

  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE)
    throw invalidInput('page di luar batas.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw invalidInput('pageSize di luar batas.');
  }

  const where: AuditLogWhere = {
    ...(actorUserAccountId ? { actorUserAccountId } : {}),
    ...(action ? { action } : {}),
    ...(entityType ? { entityType } : {}),
    ...(entityId ? { entityId } : {}),
    ...(from || to
      ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  };
  return { where, page, pageSize };
}

export class AuditService {
  constructor(private readonly repository: AuditLogRepository) {}

  /** Builds a server-authored event; occurredAt is deliberately omitted for the DB default. */
  private createData(input: RecordAuditEventInput): AuditLogCreateData {
    const actorUserAccountId = input.actor
      ? normalizeUuid(input.actor.userAccountId, 'actor.userAccountId')
      : null;
    const clientIp = normalizeOptionalText(input.clientIp, 'clientIp', 64);
    if (clientIp !== null && isIP(clientIp) === 0) throw invalidInput('clientIp tidak valid.');

    // Store geofence coordinates are business configuration and must remain auditable.
    // This narrow Admin-only event allowlist does not preserve coordinates in employee
    // attendance or arbitrary nested snapshots.
    const allowStoreGeofenceCoordinates =
      input.actor?.role === UserRole.ADMIN &&
      input.entityType === 'store' &&
      ['store.create', 'store.update', 'store.deactivate'].includes(input.action);
    const beforeData = sanitizeSnapshot(input.before, allowStoreGeofenceCoordinates);
    const afterData = sanitizeSnapshot(input.after, allowStoreGeofenceCoordinates);
    return {
      actorUserAccountId,
      action: normalizeActionOrEntityType(input.action, 'action'),
      entityType: normalizeActionOrEntityType(input.entityType, 'entityType'),
      entityId: normalizeOptionalText(input.entityId, 'entityId', 128),
      ...(beforeData === undefined ? {} : { beforeData }),
      ...(afterData === undefined ? {} : { afterData }),
      reason: normalizeOptionalText(input.reason, 'reason', 500),
      clientIp,
      deviceIdHash: normalizeOptionalText(input.deviceIdHash, 'deviceIdHash', 128),
      requestId: normalizeUuid(input.requestId, 'requestId'),
    };
  }

  record(input: RecordAuditEventInput): Promise<AuditLog> {
    return this.repository.create(this.createData(input));
  }

  /** Writes through the caller's Prisma transaction so the audited mutation is atomic. */
  recordInTransaction(
    transaction: Prisma.TransactionClient,
    input: RecordAuditEventInput,
  ): Promise<AuditLog> {
    return transaction.auditLog.create({ data: this.createData(input) });
  }

  /** Read-only, bounded audit listing. The actor is trusted server-side authorization context. */
  async list(actor: AuthorizationActor, filter: AuditLogFilterInput = {}): Promise<AuditLogPage> {
    if (actor.role !== UserRole.ADMIN) {
      throw new AppError(403, 'FORBIDDEN', 'Anda tidak memiliki akses ke audit log.');
    }

    const { where, page, pageSize } = normalizeFilter(filter);
    const rows = await this.repository.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize + 1,
      orderBy: ORDER_BY,
    });
    return {
      items: rows.slice(0, pageSize),
      page,
      pageSize,
      hasNextPage: rows.length > pageSize,
    };
  }
}

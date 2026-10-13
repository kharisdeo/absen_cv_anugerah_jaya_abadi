import type { AuditLog } from '../generated/prisma/client.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import type { AuditService } from '../modules/audit/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import { requireSession, setNoStore, type AuthRoutesOptions } from './auth.js';

const auditTimestampSchema = z.string().datetime({ offset: true }).max(35);
const auditLogQuerySchema = z
  .object({
    actorUserAccountId: z.string().uuid().optional(),
    action: z.string().min(1).max(100).optional(),
    entityType: z.string().min(1).max(100).optional(),
    entityId: z.string().min(1).max(128).optional(),
    from: auditTimestampSchema.optional(),
    to: auditTimestampSchema.optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

type AuditLogDto = Pick<
  AuditLog,
  | 'id'
  | 'actorUserAccountId'
  | 'occurredAt'
  | 'clientIp'
  | 'deviceIdHash'
  | 'action'
  | 'entityType'
  | 'entityId'
  | 'beforeData'
  | 'afterData'
  | 'reason'
  | 'requestId'
>;

export type AuditLogRoutesOptions = Readonly<{
  service: Pick<AuditService, 'list'>;
  auth: AuthRoutesOptions;
}>;

function invalidInput(): AppError {
  return new AppError(400, 'INVALID_AUDIT_INPUT', 'Filter audit tidak valid.');
}

function toAuditLogDto(row: AuditLog): AuditLogDto {
  return {
    id: row.id,
    actorUserAccountId: row.actorUserAccountId,
    occurredAt: row.occurredAt,
    clientIp: row.clientIp,
    deviceIdHash: row.deviceIdHash,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    beforeData: row.beforeData,
    afterData: row.afterData,
    reason: row.reason,
    requestId: row.requestId,
  };
}

async function noStoreOnSend(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  setNoStore(reply);
  return payload;
}

export async function registerAuditLogRoutes(
  app: FastifyInstance,
  options: AuditLogRoutesOptions,
): Promise<void> {
  app.get(
    `${API_PREFIX}/admin/audit-logs`,
    {
      config: {
        rateLimit: options.auth.sensitiveRateLimit ?? { max: 30, timeWindow: '1 minute' },
      },
      onRequest: async (_request, reply) => setNoStore(reply),
      onSend: noStoreOnSend,
    },
    async (request, reply) => {
      const query = auditLogQuerySchema.safeParse(request.query);
      if (!query.success) throw invalidInput();

      const session = await requireSession(request, reply, options.auth);
      const result = await options.service.list(session.principal, {
        ...(query.data.actorUserAccountId === undefined
          ? {}
          : { actorUserAccountId: query.data.actorUserAccountId }),
        ...(query.data.action === undefined ? {} : { action: query.data.action }),
        ...(query.data.entityType === undefined ? {} : { entityType: query.data.entityType }),
        ...(query.data.entityId === undefined ? {} : { entityId: query.data.entityId }),
        ...(query.data.from === undefined ? {} : { from: query.data.from }),
        ...(query.data.to === undefined ? {} : { to: query.data.to }),
        ...(query.data.page === undefined ? {} : { page: query.data.page }),
        ...(query.data.pageSize === undefined ? {} : { pageSize: query.data.pageSize }),
      });
      return { ...result, items: result.items.map(toAuditLogDto) };
    },
  );
}

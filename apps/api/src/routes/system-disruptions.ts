import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { UserRole } from '../generated/prisma/enums.js';
import { AppError } from '../errors/app-error.js';
import type { AuditActor } from '../modules/audit/index.js';
import type { SystemDisruptionService } from '../modules/system-disruption/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import {
  assertAllowedOrigin,
  requestContext,
  requireSession,
  setNoStore,
  type AuthRoutesOptions,
} from './auth.js';

const timestampSchema = z.string().min(1).max(40);
const storeIdSchema = z.string().uuid();
const createBodySchema = z
  .object({
    storeId: storeIdSchema.nullable().optional(),
    startsAt: timestampSchema,
    endsAt: timestampSchema,
    reason: z.string().min(1).max(500),
  })
  .strict();
const listQuerySchema = z
  .object({
    storeId: storeIdSchema.optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

export type SystemDisruptionRoutesOptions = Readonly<{
  service: SystemDisruptionService;
  auth: AuthRoutesOptions;
}>;

function invalidInput(): AppError {
  return new AppError(
    400,
    'INVALID_SYSTEM_DISRUPTION',
    'Parameter atau data gangguan sistem tidak valid.',
  );
}

function auditActor(principal: { userAccountId: string; role: UserRole }): AuditActor {
  return { userAccountId: principal.userAccountId, role: principal.role };
}

function assertAdmin(principal: { role: UserRole }): void {
  if (principal.role !== UserRole.ADMIN) {
    throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola gangguan sistem.');
  }
}

async function setNoStoreOnSend(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  setNoStore(reply);
  return payload;
}

export async function registerSystemDisruptionRoutes(
  app: FastifyInstance,
  options: SystemDisruptionRoutesOptions,
): Promise<void> {
  const base = `${API_PREFIX}/admin/system-disruptions`;
  const authorizeAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = await requireSession(request, reply, options.auth);
    assertAdmin(session.principal);
  };
  const readOptions = {
    config: { rateLimit: options.auth.sensitiveRateLimit ?? { max: 20, timeWindow: '15 minutes' } },
    onRequest: async (_request: FastifyRequest, reply: FastifyReply) => setNoStore(reply),
    onSend: setNoStoreOnSend,
    preHandler: authorizeAdmin,
  } as const;
  const writeOptions = {
    config: { rateLimit: options.auth.sensitiveRateLimit ?? { max: 10, timeWindow: '15 minutes' } },
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      setNoStore(reply);
      assertAllowedOrigin(request, options.auth);
    },
    onSend: setNoStoreOnSend,
    preHandler: authorizeAdmin,
  } as const;

  app.get(base, readOptions, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) throw invalidInput();
    const session = await requireSession(request, reply, options.auth);
    return options.service.list(auditActor(session.principal), {
      ...(query.data.storeId === undefined ? {} : { storeId: query.data.storeId }),
      ...(query.data.page === undefined ? {} : { page: query.data.page }),
      ...(query.data.pageSize === undefined ? {} : { pageSize: query.data.pageSize }),
    });
  });

  app.post(base, writeOptions, async (request, reply) => {
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) throw invalidInput();
    const session = await requireSession(request, reply, options.auth);
    return reply.code(201).send(
      await options.service.create(
        auditActor(session.principal),
        {
          startsAt: body.data.startsAt,
          endsAt: body.data.endsAt,
          reason: body.data.reason,
          ...(body.data.storeId === undefined ? {} : { storeId: body.data.storeId }),
        },
        requestContext(request),
      ),
    );
  });
}

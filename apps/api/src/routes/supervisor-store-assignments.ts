import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import type { SupervisorStoreAssignmentService } from '../modules/supervisor-store-assignment/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import { assertAllowedOrigin, requireSession, setNoStore, type AuthRoutesOptions } from './auth.js';

const UUID = z.string().uuid();
const createSchema = z.object({ supervisorUserAccountId: UUID, storeId: UUID }).strict();
const paramsSchema = z.object({ supervisorUserAccountId: UUID, storeId: UUID }).strict();
const querySchema = z
  .object({ supervisorUserAccountId: UUID.optional(), storeId: UUID.optional() })
  .strict();

export type SupervisorStoreAssignmentRoutesOptions = Readonly<{
  service: SupervisorStoreAssignmentService;
  auth: AuthRoutesOptions;
}>;

function invalidInput(): AppError {
  return new AppError(
    400,
    'INVALID_SUPERVISOR_STORE_ASSIGNMENT',
    'Data penugasan Supervisor tidak valid.',
  );
}

async function setNoStoreOnRequest(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  setNoStore(reply);
}

async function setNoStoreOnSend(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  setNoStore(reply);
  return payload;
}

export async function registerSupervisorStoreAssignmentRoutes(
  app: FastifyInstance,
  options: SupervisorStoreAssignmentRoutesOptions,
): Promise<void> {
  const base = `${API_PREFIX}/admin/supervisor-store-assignments`;
  const writeOptions = {
    config: {
      rateLimit: options.auth.sensitiveRateLimit ?? { max: 10, timeWindow: '15 minutes' },
    },
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      setNoStore(reply);
      assertAllowedOrigin(request, options.auth);
    },
    onSend: setNoStoreOnSend,
  } as const;
  const readOptions = {
    config: {
      rateLimit: options.auth.sensitiveRateLimit ?? { max: 5, timeWindow: '15 minutes' },
    },
    onRequest: setNoStoreOnRequest,
    onSend: setNoStoreOnSend,
  } as const;

  app.get(base, readOptions, async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) throw invalidInput();
    const session = await requireSession(request, reply, options.auth);
    return options.service.list(session.principal, {
      ...(query.data.supervisorUserAccountId === undefined
        ? {}
        : { supervisorUserAccountId: query.data.supervisorUserAccountId }),
      ...(query.data.storeId === undefined ? {} : { storeId: query.data.storeId }),
    });
  });

  app.post(base, writeOptions, async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) throw invalidInput();
    const session = await requireSession(request, reply, options.auth);
    return reply
      .code(201)
      .send(await options.service.create(session.principal, body.data, request.id));
  });

  app.delete<{ Params: { supervisorUserAccountId: string; storeId: string } }>(
    `${base}/:supervisorUserAccountId/:storeId`,
    writeOptions,
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      await options.service.delete(session.principal, params.data, request.id);
      return reply.code(204).send();
    },
  );
}

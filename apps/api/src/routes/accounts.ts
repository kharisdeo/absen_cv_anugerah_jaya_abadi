import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AccountStatus, UserRole } from '../generated/prisma/enums.js';
import { AppError } from '../errors/app-error.js';
import type { AuditActor } from '../modules/audit/index.js';
import type { AuthPrincipal } from '../modules/auth/contracts.js';
import type { AccountDto, AccountService } from '../modules/account/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import {
  assertAllowedOrigin,
  requestContext,
  requireSession,
  setNoStore,
  type AuthRoutesOptions,
} from './auth.js';

const accountParams = z.object({ accountId: z.string().uuid() }).strict();
const username = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    }),
  );
const role = z.enum([UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.EMPLOYEE]);
const status = z.enum([AccountStatus.ACTIVE, AccountStatus.INACTIVE, AccountStatus.SUSPENDED]);
const employeeId = z.string().uuid().nullable();
const createAccountBody = z
  .object({
    username,
    role,
    status: status.optional(),
    employeeId: employeeId.optional(),
  })
  .strict();
const updateAccountBody = z
  .object({
    username: username.optional(),
    role: role.optional(),
    status: status.optional(),
    employeeId: employeeId.optional(),
  })
  .strict();
const deactivateBody = z.object({}).strict().optional();

export type AccountRoutesOptions = Readonly<{
  service: AccountService;
  auth: AuthRoutesOptions;
}>;

function invalidInput(): AppError {
  return new AppError(400, 'INVALID_ACCOUNT_INPUT', 'Payload data akun tidak valid.');
}

function assertAdmin(principal: AuthPrincipal): void {
  if (principal.role !== UserRole.ADMIN) {
    throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola akun.');
  }
}

function auditActor(principal: AuthPrincipal): AuditActor {
  return { userAccountId: principal.userAccountId, role: UserRole.ADMIN };
}

function toSafeDto(account: AccountDto): AccountDto {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    status: account.status,
    employeeId: account.employeeId,
    mustChangePassword: account.mustChangePassword,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

async function setNoStoreOnSend(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  setNoStore(reply);
  return payload;
}

async function authorizeAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthRoutesOptions,
): Promise<void> {
  const session = await requireSession(request, reply, auth);
  assertAdmin(session.principal);
}

export async function registerAccountRoutes(
  app: FastifyInstance,
  options: AccountRoutesOptions,
): Promise<void> {
  const base = `${API_PREFIX}/admin/accounts`;
  const sensitiveRateLimit = options.auth.sensitiveRateLimit ?? {
    max: 5,
    timeWindow: '15 minutes',
  };

  app.get(
    base,
    {
      onRequest: async (_request, reply) => setNoStore(reply),
      onSend: setNoStoreOnSend,
      preHandler: async (request, reply) => authorizeAdmin(request, reply, options.auth),
    },
    async (request, reply) => {
      const session = await requireSession(request, reply, options.auth);
      const rows = await options.service.list(auditActor(session.principal));
      return rows.map(toSafeDto);
    },
  );

  app.get<{ Params: { accountId: string } }>(
    `${base}/:accountId`,
    {
      onRequest: async (_request, reply) => setNoStore(reply),
      onSend: setNoStoreOnSend,
      preHandler: async (request, reply) => authorizeAdmin(request, reply, options.auth),
    },
    async (request, reply) => {
      const params = accountParams.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const account = await options.service.get(
        auditActor(session.principal),
        params.data.accountId,
      );
      return toSafeDto(account);
    },
  );

  app.post(
    base,
    {
      config: { rateLimit: sensitiveRateLimit },
      onRequest: async (request, reply) => {
        setNoStore(reply);
        assertAllowedOrigin(request, options.auth);
      },
      onSend: setNoStoreOnSend,
      preHandler: async (request, reply) => authorizeAdmin(request, reply, options.auth),
    },
    async (request, reply) => {
      const parsed = createAccountBody.safeParse(request.body);
      if (!parsed.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const created = await options.service.create(
        auditActor(session.principal),
        {
          username: parsed.data.username,
          role: parsed.data.role,
          ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
          ...(parsed.data.employeeId === undefined ? {} : { employeeId: parsed.data.employeeId }),
        },
        requestContext(request),
      );
      return reply.code(201).send({
        account: toSafeDto(created.account),
        temporaryPassword: created.temporaryPassword,
      });
    },
  );

  app.patch<{ Params: { accountId: string } }>(
    `${base}/:accountId`,
    {
      config: { rateLimit: sensitiveRateLimit },
      onRequest: async (request, reply) => {
        setNoStore(reply);
        assertAllowedOrigin(request, options.auth);
      },
      onSend: setNoStoreOnSend,
      preHandler: async (request, reply) => authorizeAdmin(request, reply, options.auth),
    },
    async (request, reply) => {
      const params = accountParams.safeParse(request.params);
      const parsed = updateAccountBody.safeParse(request.body);
      if (!params.success || !parsed.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const account = await options.service.update(
        auditActor(session.principal),
        params.data.accountId,
        {
          ...(parsed.data.username === undefined ? {} : { username: parsed.data.username }),
          ...(parsed.data.role === undefined ? {} : { role: parsed.data.role }),
          ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
          ...(parsed.data.employeeId === undefined ? {} : { employeeId: parsed.data.employeeId }),
        },
        requestContext(request),
      );
      return toSafeDto(account);
    },
  );

  app.post<{ Params: { accountId: string } }>(
    `${base}/:accountId/deactivate`,
    {
      config: { rateLimit: sensitiveRateLimit },
      onRequest: async (request, reply) => {
        setNoStore(reply);
        assertAllowedOrigin(request, options.auth);
      },
      onSend: setNoStoreOnSend,
      preHandler: async (request, reply) => authorizeAdmin(request, reply, options.auth),
    },
    async (request, reply) => {
      const params = accountParams.safeParse(request.params);
      const parsed = deactivateBody.safeParse(request.body);
      if (!params.success || !parsed.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const account = await options.service.deactivate(
        auditActor(session.principal),
        params.data.accountId,
        requestContext(request),
      );
      return toSafeDto(account);
    },
  );
}

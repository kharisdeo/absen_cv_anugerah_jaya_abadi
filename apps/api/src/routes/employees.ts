import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { EmployeeStatus, UserRole } from '../generated/prisma/enums.js';
import { AppError } from '../errors/app-error.js';
import type { AuditActor } from '../modules/audit/index.js';
import type { AuthPrincipal } from '../modules/auth/contracts.js';
import type { EmployeeDto, EmployeeService } from '../modules/employee/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import {
  assertAllowedOrigin,
  requestContext,
  requireSession,
  setNoStore,
  type AuthRoutesOptions,
} from './auth.js';

const employeeParams = z.object({ employeeId: z.string().uuid() }).strict();
const employmentDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();
const employeeFields = {
  nik: z.string().min(1).max(64),
  fullName: z.string().min(1).max(150),
  position: z.string().max(100).nullable(),
  status: z.enum([EmployeeStatus.ACTIVE, EmployeeStatus.INACTIVE]),
  employmentDate,
};
const createEmployeeBody = z
  .object({
    nik: employeeFields.nik,
    fullName: employeeFields.fullName,
    position: employeeFields.position.optional(),
    status: employeeFields.status.optional(),
    employmentDate: employeeFields.employmentDate.optional(),
  })
  .strict();
const updateEmployeeBody = z
  .object({
    nik: employeeFields.nik.optional(),
    fullName: employeeFields.fullName.optional(),
    position: employeeFields.position.optional(),
    status: employeeFields.status.optional(),
    employmentDate: employeeFields.employmentDate.optional(),
  })
  .strict();

export type EmployeeRoutesOptions = Readonly<{
  service: EmployeeService;
  auth: AuthRoutesOptions;
}>;

function invalidInput(): AppError {
  return new AppError(400, 'INVALID_EMPLOYEE_INPUT', 'Payload data karyawan tidak valid.');
}

function assertAdmin(principal: AuthPrincipal): void {
  if (principal.role !== UserRole.ADMIN) {
    throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola data karyawan.');
  }
}

function auditActor(principal: AuthPrincipal): AuditActor {
  if (principal.role === UserRole.EMPLOYEE) {
    return {
      userAccountId: principal.userAccountId,
      role: principal.role,
      employeeId: principal.employeeId,
    };
  }
  return { userAccountId: principal.userAccountId, role: principal.role };
}

function toSafeDto(employee: EmployeeDto): EmployeeDto {
  return {
    id: employee.id,
    nik: employee.nik,
    fullName: employee.fullName,
    position: employee.position,
    status: employee.status,
    employmentDate: employee.employmentDate,
    createdAt: employee.createdAt,
    updatedAt: employee.updatedAt,
  };
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

export async function registerEmployeeRoutes(
  app: FastifyInstance,
  options: EmployeeRoutesOptions,
): Promise<void> {
  const base = `${API_PREFIX}/admin/employees`;
  const sensitiveRateLimit = options.auth.sensitiveRateLimit ?? {
    max: 5,
    timeWindow: '15 minutes',
  };
  const authorizeRead = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = await requireSession(request, reply, options.auth);
    assertAdmin(session.principal);
  };
  app.get(
    base,
    {
      onRequest: setNoStoreOnRequest,
      onSend: setNoStoreOnSend,
      preHandler: authorizeRead,
    },
    async (request, reply) => {
      const session = await requireSession(request, reply, options.auth);
      const rows = await options.service.list(auditActor(session.principal));
      return rows.map(toSafeDto);
    },
  );

  app.get<{ Params: { employeeId: string } }>(
    `${base}/:employeeId`,
    {
      onRequest: setNoStoreOnRequest,
      onSend: setNoStoreOnSend,
      preHandler: authorizeRead,
    },
    async (request, reply) => {
      const params = employeeParams.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const employee = await options.service.get(
        auditActor(session.principal),
        params.data.employeeId,
      );
      return toSafeDto(employee);
    },
  );

  app.post(
    base,
    {
      config: { rateLimit: sensitiveRateLimit },
      onRequest: async (request, reply) => {
        await setNoStoreOnRequest(request, reply);
        assertAllowedOrigin(request, options.auth);
      },
      onSend: setNoStoreOnSend,
      preHandler: authorizeRead,
    },
    async (request, reply) => {
      const parsed = createEmployeeBody.safeParse(request.body);
      if (!parsed.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const input = {
        nik: parsed.data.nik,
        fullName: parsed.data.fullName,
        ...(parsed.data.position === undefined ? {} : { position: parsed.data.position }),
        ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
        ...(parsed.data.employmentDate === undefined
          ? {}
          : { employmentDate: parsed.data.employmentDate }),
      };
      const employee = await options.service.create(
        auditActor(session.principal),
        input,
        requestContext(request),
      );
      return reply.code(201).send(toSafeDto(employee));
    },
  );

  app.patch<{ Params: { employeeId: string } }>(
    `${base}/:employeeId`,
    {
      config: { rateLimit: sensitiveRateLimit },
      onRequest: async (request, reply) => {
        await setNoStoreOnRequest(request, reply);
        assertAllowedOrigin(request, options.auth);
      },
      onSend: setNoStoreOnSend,
      preHandler: authorizeRead,
    },
    async (request, reply) => {
      const params = employeeParams.safeParse(request.params);
      const parsed = updateEmployeeBody.safeParse(request.body);
      if (!params.success || !parsed.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const input = {
        ...(parsed.data.nik === undefined ? {} : { nik: parsed.data.nik }),
        ...(parsed.data.fullName === undefined ? {} : { fullName: parsed.data.fullName }),
        ...(parsed.data.position === undefined ? {} : { position: parsed.data.position }),
        ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
        ...(parsed.data.employmentDate === undefined
          ? {}
          : { employmentDate: parsed.data.employmentDate }),
      };
      const employee = await options.service.update(
        auditActor(session.principal),
        params.data.employeeId,
        input,
        requestContext(request),
      );
      return toSafeDto(employee);
    },
  );

  app.post<{ Params: { employeeId: string } }>(
    `${base}/:employeeId/deactivate`,
    {
      config: { rateLimit: sensitiveRateLimit },
      onRequest: async (request, reply) => {
        await setNoStoreOnRequest(request, reply);
        assertAllowedOrigin(request, options.auth);
      },
      onSend: setNoStoreOnSend,
      preHandler: authorizeRead,
    },
    async (request, reply) => {
      const params = employeeParams.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const employee = await options.service.deactivate(
        auditActor(session.principal),
        params.data.employeeId,
        requestContext(request),
      );
      return toSafeDto(employee);
    },
  );
}

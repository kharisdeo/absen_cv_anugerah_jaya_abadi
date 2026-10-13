import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import type { AuditActor } from '../modules/audit/index.js';
import type { AuthPrincipal } from '../modules/auth/contracts.js';
import type { EmployeeStoreAssignmentDto, StoreDto, StoreService } from '../modules/store/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import {
  assertAllowedOrigin,
  requestContext,
  requireSession,
  setNoStore,
  type AuthRoutesOptions,
} from './auth.js';

const storeParams = z.object({ storeId: z.string().uuid() }).strict();
const assignmentParams = z
  .object({ storeId: z.string().uuid(), employeeId: z.string().uuid() })
  .strict();
const positiveInt = z.number().int().min(1).max(2_147_483_647);
const storeFields = {
  name: z.string().min(1).max(160),
  address: z.string().max(500).nullable(),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  radiusMeters: positiveInt,
  accuracyLimitMeters: positiveInt,
  wifiPublicIp: z.string().max(45).nullable(),
  isActive: z.boolean(),
};
const createStoreBody = z
  .object({
    name: storeFields.name,
    address: storeFields.address.optional(),
    latitude: storeFields.latitude,
    longitude: storeFields.longitude,
    radiusMeters: storeFields.radiusMeters.optional(),
    accuracyLimitMeters: storeFields.accuracyLimitMeters.optional(),
    wifiPublicIp: storeFields.wifiPublicIp.optional(),
    isActive: storeFields.isActive.optional(),
  })
  .strict();
const updateStoreBody = z
  .object({
    name: storeFields.name.optional(),
    address: storeFields.address.optional(),
    latitude: storeFields.latitude.optional(),
    longitude: storeFields.longitude.optional(),
    radiusMeters: storeFields.radiusMeters.optional(),
    accuracyLimitMeters: storeFields.accuracyLimitMeters.optional(),
    wifiPublicIp: storeFields.wifiPublicIp.optional(),
    isActive: storeFields.isActive.optional(),
  })
  .strict();
const emptyBody = z.object({}).strict().optional();

export type StoreRoutesOptions = Readonly<{ service: StoreService; auth: AuthRoutesOptions }>;

function invalidInput(): AppError {
  return new AppError(400, 'INVALID_STORE_INPUT', 'Parameter atau payload toko tidak valid.');
}

function assertAdmin(principal: AuthPrincipal): void {
  if (principal.role !== 'ADMIN') {
    throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola toko.');
  }
}

function auditActor(principal: AuthPrincipal): AuditActor {
  return { userAccountId: principal.userAccountId, role: principal.role };
}

function toSafeStoreDto(store: StoreDto): StoreDto {
  return {
    id: store.id,
    name: store.name,
    address: store.address,
    latitude: store.latitude,
    longitude: store.longitude,
    radiusMeters: store.radiusMeters,
    accuracyLimitMeters: store.accuracyLimitMeters,
    wifiPublicIp: store.wifiPublicIp,
    isActive: store.isActive,
    createdAt: store.createdAt,
    updatedAt: store.updatedAt,
  };
}

function toSafeAssignmentDto(assignment: EmployeeStoreAssignmentDto): EmployeeStoreAssignmentDto {
  return {
    storeId: assignment.storeId,
    employeeId: assignment.employeeId,
    assignedByUserAccountId: assignment.assignedByUserAccountId,
    assignedAt: assignment.assignedAt,
    employee: {
      id: assignment.employee.id,
      nik: assignment.employee.nik,
      fullName: assignment.employee.fullName,
      status: assignment.employee.status,
    },
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

export async function registerStoreRoutes(
  app: FastifyInstance,
  options: StoreRoutesOptions,
): Promise<void> {
  const base = `${API_PREFIX}/admin/stores`;
  const sensitiveRateLimit = options.auth.sensitiveRateLimit ?? {
    max: 5,
    timeWindow: '15 minutes',
  };
  const authorizeAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = await requireSession(request, reply, options.auth);
    assertAdmin(session.principal);
  };

  app.get(
    base,
    { onRequest: setNoStoreOnRequest, onSend: setNoStoreOnSend, preHandler: authorizeAdmin },
    async (request, reply) => {
      const session = await requireSession(request, reply, options.auth);
      return (await options.service.list(auditActor(session.principal))).map(toSafeStoreDto);
    },
  );

  app.get<{ Params: { storeId: string } }>(
    `${base}/:storeId`,
    { onRequest: setNoStoreOnRequest, onSend: setNoStoreOnSend, preHandler: authorizeAdmin },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return toSafeStoreDto(
        await options.service.get(auditActor(session.principal), params.data.storeId),
      );
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
      preHandler: authorizeAdmin,
    },
    async (request, reply) => {
      const parsed = createStoreBody.safeParse(request.body);
      if (!parsed.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const input = {
        name: parsed.data.name,
        latitude: parsed.data.latitude,
        longitude: parsed.data.longitude,
        ...(parsed.data.address === undefined ? {} : { address: parsed.data.address }),
        ...(parsed.data.radiusMeters === undefined
          ? {}
          : { radiusMeters: parsed.data.radiusMeters }),
        ...(parsed.data.accuracyLimitMeters === undefined
          ? {}
          : { accuracyLimitMeters: parsed.data.accuracyLimitMeters }),
        ...(parsed.data.wifiPublicIp === undefined
          ? {}
          : { wifiPublicIp: parsed.data.wifiPublicIp }),
        ...(parsed.data.isActive === undefined ? {} : { isActive: parsed.data.isActive }),
      };
      const created = await options.service.create(
        auditActor(session.principal),
        input,
        requestContext(request),
      );
      return reply.code(201).send(toSafeStoreDto(created));
    },
  );

  app.patch<{ Params: { storeId: string } }>(
    `${base}/:storeId`,
    {
      config: { rateLimit: sensitiveRateLimit },
      onRequest: async (request, reply) => {
        await setNoStoreOnRequest(request, reply);
        assertAllowedOrigin(request, options.auth);
      },
      onSend: setNoStoreOnSend,
      preHandler: authorizeAdmin,
    },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      const parsed = updateStoreBody.safeParse(request.body);
      if (!params.success || !parsed.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const input = {
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(parsed.data.address === undefined ? {} : { address: parsed.data.address }),
        ...(parsed.data.latitude === undefined ? {} : { latitude: parsed.data.latitude }),
        ...(parsed.data.longitude === undefined ? {} : { longitude: parsed.data.longitude }),
        ...(parsed.data.radiusMeters === undefined
          ? {}
          : { radiusMeters: parsed.data.radiusMeters }),
        ...(parsed.data.accuracyLimitMeters === undefined
          ? {}
          : { accuracyLimitMeters: parsed.data.accuracyLimitMeters }),
        ...(parsed.data.wifiPublicIp === undefined
          ? {}
          : { wifiPublicIp: parsed.data.wifiPublicIp }),
        ...(parsed.data.isActive === undefined ? {} : { isActive: parsed.data.isActive }),
      };
      const updated = await options.service.update(
        auditActor(session.principal),
        params.data.storeId,
        input,
        requestContext(request),
      );
      return toSafeStoreDto(updated);
    },
  );

  app.post<{ Params: { storeId: string } }>(
    `${base}/:storeId/deactivate`,
    {
      config: { rateLimit: sensitiveRateLimit },
      onRequest: async (request, reply) => {
        await setNoStoreOnRequest(request, reply);
        assertAllowedOrigin(request, options.auth);
      },
      onSend: setNoStoreOnSend,
      preHandler: authorizeAdmin,
    },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      const body = emptyBody.safeParse(request.body);
      if (!params.success || !body.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const updated = await options.service.deactivate(
        auditActor(session.principal),
        params.data.storeId,
        requestContext(request),
      );
      return toSafeStoreDto(updated);
    },
  );

  app.get<{ Params: { storeId: string } }>(
    `${base}/:storeId/assignments`,
    { onRequest: setNoStoreOnRequest, onSend: setNoStoreOnSend, preHandler: authorizeAdmin },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return (
        await options.service.listAssignments(auditActor(session.principal), params.data.storeId)
      ).map(toSafeAssignmentDto);
    },
  );

  app.put<{ Params: { storeId: string; employeeId: string } }>(
    `${base}/:storeId/assignments/:employeeId`,
    {
      config: { rateLimit: sensitiveRateLimit },
      onRequest: async (request, reply) => {
        await setNoStoreOnRequest(request, reply);
        assertAllowedOrigin(request, options.auth);
      },
      onSend: setNoStoreOnSend,
      preHandler: authorizeAdmin,
    },
    async (request, reply) => {
      const params = assignmentParams.safeParse(request.params);
      const body = emptyBody.safeParse(request.body);
      if (!params.success || !body.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const assignment = await options.service.assignEmployee(
        auditActor(session.principal),
        params.data.storeId,
        params.data.employeeId,
        requestContext(request),
      );
      return reply.code(200).send(toSafeAssignmentDto(assignment));
    },
  );

  app.delete<{ Params: { storeId: string; employeeId: string } }>(
    `${base}/:storeId/assignments/:employeeId`,
    {
      config: { rateLimit: sensitiveRateLimit },
      onRequest: async (request, reply) => {
        await setNoStoreOnRequest(request, reply);
        assertAllowedOrigin(request, options.auth);
      },
      onSend: setNoStoreOnSend,
      preHandler: authorizeAdmin,
    },
    async (request, reply) => {
      const params = assignmentParams.safeParse(request.params);
      const body = emptyBody.safeParse(request.body);
      if (!params.success || !body.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      await options.service.removeEmployee(
        auditActor(session.principal),
        params.data.storeId,
        params.data.employeeId,
        requestContext(request),
      );
      return reply.code(204).send();
    },
  );
}

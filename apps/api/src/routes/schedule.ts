import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import type { AuditActor } from '../modules/audit/index.js';
import type { AuthPrincipal } from '../modules/auth/contracts.js';
import type {
  HolidayCreateData,
  HolidayUpdateData,
  ScheduleService,
  ShiftAssignmentCreateData,
  ShiftAssignmentUpdateData,
  WorkShiftCreateData,
  WorkShiftUpdateData,
} from '../modules/schedule/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import {
  assertAllowedOrigin,
  requestContext,
  requireSession,
  setNoStore,
  type AuthRoutesOptions,
} from './auth.js';

const UUID = z.string().uuid();
const DATE_SHAPE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const CLOCK_SHAPE = z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/);
const postgresInteger = z.number().int().min(0).max(2_147_483_647);
const weekdays = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .refine((values) => new Set(values).size === values.length);
const storeScope = z.union([z.literal('global'), UUID]);
const holidayScope = z.union([z.literal('national'), UUID]);

const shiftCreateBody = z
  .object({
    name: z.string(),
    startTime: CLOCK_SHAPE,
    endTime: CLOCK_SHAPE,
    breakMinutes: postgresInteger.optional(),
    lateToleranceMinutes: postgresInteger.optional(),
    workDays: weekdays,
    isActive: z.boolean().optional(),
  })
  .strict();

const shiftUpdateBody = z
  .object({
    name: z.string().optional(),
    startTime: CLOCK_SHAPE.optional(),
    endTime: CLOCK_SHAPE.optional(),
    breakMinutes: postgresInteger.optional(),
    lateToleranceMinutes: postgresInteger.optional(),
    workDays: weekdays.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const assignmentCreateBody = z
  .object({
    employeeId: UUID,
    workShiftId: UUID,
    storeId: UUID.nullable().optional(),
    effectiveFrom: DATE_SHAPE,
    effectiveTo: DATE_SHAPE.nullable().optional(),
  })
  .strict();

const assignmentUpdateBody = z
  .object({
    workShiftId: UUID.optional(),
    storeId: UUID.nullable().optional(),
    effectiveFrom: DATE_SHAPE.optional(),
    effectiveTo: DATE_SHAPE.nullable().optional(),
  })
  .strict();

const assignmentDeactivateBody = z.object({ effectiveTo: DATE_SHAPE }).strict();

const holidayCreateBody = z
  .object({
    storeId: UUID.nullable().optional(),
    holidayDate: DATE_SHAPE,
    description: z.string(),
  })
  .strict();

const holidayUpdateBody = z
  .object({
    storeId: UUID.nullable().optional(),
    holidayDate: DATE_SHAPE.optional(),
    description: z.string().optional(),
  })
  .strict();

const shiftParams = z.object({ shiftId: UUID }).strict();
const assignmentParams = z.object({ assignmentId: UUID }).strict();
const holidayParams = z.object({ holidayId: UUID }).strict();
const emptyBody = z.object({}).strict().optional();

const assignmentListQuery = z
  .object({
    employeeId: UUID.optional(),
    storeId: storeScope.optional(),
    businessDate: DATE_SHAPE.optional(),
  })
  .strict();

const holidayListQuery = z
  .object({
    from: DATE_SHAPE.optional(),
    to: DATE_SHAPE.optional(),
    storeId: holidayScope.optional(),
  })
  .strict();

export type ScheduleRoutesOptions = Readonly<{ service: ScheduleService; auth: AuthRoutesOptions }>;

function invalidInput(): AppError {
  return new AppError(400, 'INVALID_SCHEDULE_INPUT', 'Parameter atau payload jadwal tidak valid.');
}

function assertAdmin(principal: AuthPrincipal): void {
  if (principal.role !== 'ADMIN') {
    throw new AppError(403, 'FORBIDDEN', 'Hanya Admin yang dapat mengelola jadwal.');
  }
}

function auditActor(principal: AuthPrincipal): AuditActor {
  return { userAccountId: principal.userAccountId, role: principal.role };
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

function parseScope(
  value: string | undefined,
  globalLabel: 'global' | 'national',
): { readonly storeId?: never } | { readonly storeId: string | null } {
  if (value === undefined) return {};
  return { storeId: value === globalLabel ? null : value };
}

export async function registerScheduleRoutes(
  app: FastifyInstance,
  options: ScheduleRoutesOptions,
): Promise<void> {
  const shiftsBase = `${API_PREFIX}/admin/shifts`;
  const assignmentsBase = `${API_PREFIX}/admin/shift-assignments`;
  const holidaysBase = `${API_PREFIX}/admin/holidays`;
  const sensitiveRateLimit = options.auth.sensitiveRateLimit ?? {
    max: 5,
    timeWindow: '15 minutes',
  };
  const authorizeAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = await requireSession(request, reply, options.auth);
    assertAdmin(session.principal);
  };
  const writeOptions = {
    config: { rateLimit: sensitiveRateLimit },
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      await setNoStoreOnRequest(request, reply);
      assertAllowedOrigin(request, options.auth);
    },
    onSend: setNoStoreOnSend,
    preHandler: authorizeAdmin,
  } as const;
  const readOptions = {
    onRequest: setNoStoreOnRequest,
    onSend: setNoStoreOnSend,
    preHandler: authorizeAdmin,
  } as const;

  app.get(shiftsBase, readOptions, async (request, reply) => {
    const session = await requireSession(request, reply, options.auth);
    return options.service.listShifts(auditActor(session.principal));
  });

  app.get<{ Params: { shiftId: string } }>(
    `${shiftsBase}/:shiftId`,
    readOptions,
    async (request, reply) => {
      const params = shiftParams.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.getShift(auditActor(session.principal), params.data.shiftId);
    },
  );

  app.post(shiftsBase, writeOptions, async (request, reply) => {
    const body = shiftCreateBody.safeParse(request.body);
    if (!body.success) throw invalidInput();
    const session = await requireSession(request, reply, options.auth);
    const input: WorkShiftCreateData = {
      name: body.data.name,
      startTime: body.data.startTime,
      endTime: body.data.endTime,
      ...(body.data.breakMinutes === undefined ? {} : { breakMinutes: body.data.breakMinutes }),
      ...(body.data.lateToleranceMinutes === undefined
        ? {}
        : { lateToleranceMinutes: body.data.lateToleranceMinutes }),
      workDays: body.data.workDays,
      ...(body.data.isActive === undefined ? {} : { isActive: body.data.isActive }),
    };
    return reply
      .code(201)
      .send(
        await options.service.createShift(
          auditActor(session.principal),
          input,
          requestContext(request),
        ),
      );
  });

  app.patch<{ Params: { shiftId: string } }>(
    `${shiftsBase}/:shiftId`,
    writeOptions,
    async (request, reply) => {
      const params = shiftParams.safeParse(request.params);
      const body = shiftUpdateBody.safeParse(request.body);
      if (!params.success || !body.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const input: WorkShiftUpdateData = {
        ...(body.data.name === undefined ? {} : { name: body.data.name }),
        ...(body.data.startTime === undefined ? {} : { startTime: body.data.startTime }),
        ...(body.data.endTime === undefined ? {} : { endTime: body.data.endTime }),
        ...(body.data.breakMinutes === undefined ? {} : { breakMinutes: body.data.breakMinutes }),
        ...(body.data.lateToleranceMinutes === undefined
          ? {}
          : { lateToleranceMinutes: body.data.lateToleranceMinutes }),
        ...(body.data.workDays === undefined ? {} : { workDays: body.data.workDays }),
        ...(body.data.isActive === undefined ? {} : { isActive: body.data.isActive }),
      };
      return options.service.updateShift(
        auditActor(session.principal),
        params.data.shiftId,
        input,
        requestContext(request),
      );
    },
  );

  app.post<{ Params: { shiftId: string } }>(
    `${shiftsBase}/:shiftId/deactivate`,
    writeOptions,
    async (request, reply) => {
      const params = shiftParams.safeParse(request.params);
      if (!params.success || !emptyBody.safeParse(request.body).success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.deactivateShift(
        auditActor(session.principal),
        params.data.shiftId,
        requestContext(request),
      );
    },
  );

  app.get(assignmentsBase, readOptions, async (request, reply) => {
    const query = assignmentListQuery.safeParse(request.query);
    if (!query.success) throw invalidInput();
    const session = await requireSession(request, reply, options.auth);
    const scope = parseScope(query.data.storeId, 'global');
    return options.service.listAssignments(auditActor(session.principal), {
      ...(query.data.employeeId === undefined ? {} : { employeeId: query.data.employeeId }),
      ...scope,
      ...(query.data.businessDate === undefined ? {} : { businessDate: query.data.businessDate }),
    });
  });

  app.get<{ Params: { assignmentId: string } }>(
    `${assignmentsBase}/:assignmentId`,
    readOptions,
    async (request, reply) => {
      const params = assignmentParams.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.getAssignment(auditActor(session.principal), params.data.assignmentId);
    },
  );

  app.post(assignmentsBase, writeOptions, async (request, reply) => {
    const body = assignmentCreateBody.safeParse(request.body);
    if (!body.success) throw invalidInput();
    const session = await requireSession(request, reply, options.auth);
    const input: ShiftAssignmentCreateData = {
      employeeId: body.data.employeeId,
      workShiftId: body.data.workShiftId,
      effectiveFrom: body.data.effectiveFrom,
      ...(body.data.storeId === undefined ? {} : { storeId: body.data.storeId }),
      ...(body.data.effectiveTo === undefined ? {} : { effectiveTo: body.data.effectiveTo }),
    };
    return reply
      .code(201)
      .send(
        await options.service.createAssignment(
          auditActor(session.principal),
          input,
          requestContext(request),
        ),
      );
  });

  app.patch<{ Params: { assignmentId: string } }>(
    `${assignmentsBase}/:assignmentId`,
    writeOptions,
    async (request, reply) => {
      const params = assignmentParams.safeParse(request.params);
      const body = assignmentUpdateBody.safeParse(request.body);
      if (!params.success || !body.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const input: ShiftAssignmentUpdateData = {
        ...(body.data.workShiftId === undefined ? {} : { workShiftId: body.data.workShiftId }),
        ...(body.data.storeId === undefined ? {} : { storeId: body.data.storeId }),
        ...(body.data.effectiveFrom === undefined
          ? {}
          : { effectiveFrom: body.data.effectiveFrom }),
        ...(body.data.effectiveTo === undefined ? {} : { effectiveTo: body.data.effectiveTo }),
      };
      return options.service.updateAssignment(
        auditActor(session.principal),
        params.data.assignmentId,
        input,
        requestContext(request),
      );
    },
  );

  app.post<{ Params: { assignmentId: string } }>(
    `${assignmentsBase}/:assignmentId/deactivate`,
    writeOptions,
    async (request, reply) => {
      const params = assignmentParams.safeParse(request.params);
      const body = assignmentDeactivateBody.safeParse(request.body);
      if (!params.success || !body.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.deactivateAssignment(
        auditActor(session.principal),
        params.data.assignmentId,
        body.data.effectiveTo,
        requestContext(request),
      );
    },
  );

  app.get(holidaysBase, readOptions, async (request, reply) => {
    const query = holidayListQuery.safeParse(request.query);
    if (!query.success) throw invalidInput();
    const session = await requireSession(request, reply, options.auth);
    const scope = parseScope(query.data.storeId, 'national');
    return options.service.listHolidays(auditActor(session.principal), {
      ...(query.data.from === undefined ? {} : { from: query.data.from }),
      ...(query.data.to === undefined ? {} : { to: query.data.to }),
      ...scope,
    });
  });

  app.get<{ Params: { holidayId: string } }>(
    `${holidaysBase}/:holidayId`,
    readOptions,
    async (request, reply) => {
      const params = holidayParams.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.getHoliday(auditActor(session.principal), params.data.holidayId);
    },
  );

  app.post(holidaysBase, writeOptions, async (request, reply) => {
    const body = holidayCreateBody.safeParse(request.body);
    if (!body.success) throw invalidInput();
    const session = await requireSession(request, reply, options.auth);
    const input: HolidayCreateData = {
      holidayDate: body.data.holidayDate,
      description: body.data.description,
      ...(body.data.storeId === undefined ? {} : { storeId: body.data.storeId }),
    };
    return reply
      .code(201)
      .send(
        await options.service.createHoliday(
          auditActor(session.principal),
          input,
          requestContext(request),
        ),
      );
  });

  app.patch<{ Params: { holidayId: string } }>(
    `${holidaysBase}/:holidayId`,
    writeOptions,
    async (request, reply) => {
      const params = holidayParams.safeParse(request.params);
      const body = holidayUpdateBody.safeParse(request.body);
      if (!params.success || !body.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      const input: HolidayUpdateData = {
        ...(body.data.storeId === undefined ? {} : { storeId: body.data.storeId }),
        ...(body.data.holidayDate === undefined ? {} : { holidayDate: body.data.holidayDate }),
        ...(body.data.description === undefined ? {} : { description: body.data.description }),
      };
      return options.service.updateHoliday(
        auditActor(session.principal),
        params.data.holidayId,
        input,
        requestContext(request),
      );
    },
  );

  app.delete<{ Params: { holidayId: string } }>(
    `${holidaysBase}/:holidayId`,
    writeOptions,
    async (request, reply) => {
      const params = holidayParams.safeParse(request.params);
      if (!params.success || !emptyBody.safeParse(request.body).success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      await options.service.deleteHoliday(
        auditActor(session.principal),
        params.data.holidayId,
        requestContext(request),
      );
      return reply.code(204).send();
    },
  );
}

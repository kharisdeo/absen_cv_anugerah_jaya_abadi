import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { RequestStatus } from '../generated/prisma/enums.js';
import { AppError } from '../errors/app-error.js';
import {
  EMPLOYEE_REQUEST_TYPES,
  type AttendanceRequestService,
} from '../modules/attendance-requests/index.js';
import {
  DOCTOR_NOTE_CONTENT_TYPES,
  MAX_DOCTOR_NOTE_BYTES,
} from '../modules/attendance-requests/private-request-attachment-storage.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import { assertAllowedOrigin, requireSession, setNoStore, type AuthRoutesOptions } from './auth.js';

const requestIdParams = z.object({ requestId: z.string().uuid() }).strict();
const requestTypeSchema = z.enum([...EMPLOYEE_REQUEST_TYPES]);
const decisionSchema = z.enum([RequestStatus.APPROVED, RequestStatus.REJECTED]);
const statusSchema = z.enum([
  RequestStatus.PENDING,
  RequestStatus.APPROVED,
  RequestStatus.REJECTED,
  RequestStatus.CANCELLED,
]);
const doctorNoteSchema = z
  .object({
    contentType: z.enum([...DOCTOR_NOTE_CONTENT_TYPES]),
    dataBase64: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_DOCTOR_NOTE_BYTES * 4) / 3) + 4),
  })
  .strict();
const createBodySchema = z
  .object({
    requestType: requestTypeSchema,
    startDate: z.string().max(10),
    endDate: z.string().max(10),
    reason: z.string().max(1_000),
    requestedOvertimeMinutes: z.number().int().min(1).max(2_147_483_647).optional(),
    doctorNote: doctorNoteSchema.optional(),
  })
  .strict();
const decisionBodySchema = z
  .object({
    decision: decisionSchema,
    decisionNote: z.string().min(1).max(500),
  })
  .strict();
const listQuerySchema = z
  .object({
    requestType: requestTypeSchema.optional(),
    status: statusSchema.optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

export type AttendanceRequestRoutesOptions = Readonly<{
  service: AttendanceRequestService;
  auth: AuthRoutesOptions;
}>;

function invalidInput(): AppError {
  return new AppError(
    400,
    'INVALID_ATTENDANCE_REQUEST',
    'Parameter atau data pengajuan tidak valid.',
  );
}

async function noStoreOnSend(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  setNoStore(reply);
  return payload;
}

export async function registerAttendanceRequestRoutes(
  app: FastifyInstance,
  options: AttendanceRequestRoutesOptions,
): Promise<void> {
  const base = `${API_PREFIX}/attendance/requests`;
  const rateLimit = options.auth.sensitiveRateLimit ?? { max: 10, timeWindow: '15 minutes' };
  const readOptions = {
    config: { rateLimit },
    onRequest: async (_request: FastifyRequest, reply: FastifyReply) => setNoStore(reply),
    onSend: noStoreOnSend,
  } as const;
  const writeOptions = {
    config: { rateLimit },
    bodyLimit: 7 * 1024 * 1024,
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      setNoStore(reply);
      assertAllowedOrigin(request, options.auth);
    },
    onSend: noStoreOnSend,
  } as const;

  app.get(base, readOptions, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) throw invalidInput();
    const session = await requireSession(request, reply, options.auth);
    return options.service.list(session.principal, {
      ...(query.data.requestType === undefined ? {} : { requestType: query.data.requestType }),
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
      ...(query.data.page === undefined ? {} : { page: query.data.page }),
      ...(query.data.pageSize === undefined ? {} : { pageSize: query.data.pageSize }),
    });
  });

  app.post(base, writeOptions, async (request, reply) => {
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) throw invalidInput();
    const session = await requireSession(request, reply, options.auth);
    const result = await options.service.create(
      session.principal,
      {
        requestType: body.data.requestType,
        startDate: body.data.startDate,
        endDate: body.data.endDate,
        reason: body.data.reason,
        ...(body.data.requestedOvertimeMinutes === undefined
          ? {}
          : { requestedOvertimeMinutes: body.data.requestedOvertimeMinutes }),
        ...(body.data.doctorNote === undefined ? {} : { doctorNote: body.data.doctorNote }),
      },
      { requestId: request.id },
    );
    return reply.code(201).send(result);
  });

  app.get<{ Params: { requestId: string } }>(
    `${base}/:requestId/attachment-url`,
    readOptions,
    async (request, reply) => {
      const params = requestIdParams.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.createAttachmentReadUrl(session.principal, params.data.requestId);
    },
  );

  app.post<{ Params: { requestId: string } }>(
    `${base}/:requestId/decision`,
    writeOptions,
    async (request, reply) => {
      const params = requestIdParams.safeParse(request.params);
      const body = decisionBodySchema.safeParse(request.body);
      if (!params.success || !body.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.decide(session.principal, params.data.requestId, body.data, {
        requestId: request.id,
      });
    },
  );

  app.get<{ Params: { requestId: string } }>(
    `${base}/:requestId`,
    readOptions,
    async (request, reply) => {
      const params = requestIdParams.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.detail(session.principal, params.data.requestId);
    },
  );
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import type { AttendanceVerificationService } from '../modules/attendance/verification-workflow.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import { assertAllowedOrigin, requireSession, setNoStore, type AuthRoutesOptions } from './auth.js';

const UUID = z.string().uuid();
const paramsSchema = z.object({ attendanceId: UUID }).strict();
const querySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(50).optional(),
    storeId: UUID.optional(),
  })
  .strict();
const decisionSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    reason: z.string().max(500).optional(),
  })
  .strict();

export type AttendanceVerificationRoutesOptions = Readonly<{
  service: AttendanceVerificationService;
  auth: AuthRoutesOptions;
}>;

function invalidInput(): AppError {
  return new AppError(
    400,
    'INVALID_VERIFICATION_INPUT',
    'Parameter atau data verifikasi absensi tidak valid.',
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

export async function registerAttendanceVerificationRoutes(
  app: FastifyInstance,
  options: AttendanceVerificationRoutesOptions,
): Promise<void> {
  const base = `${API_PREFIX}/attendance/verifications`;
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
    return options.service.listQueue(session.principal, {
      ...(query.data.page === undefined ? {} : { page: query.data.page }),
      ...(query.data.pageSize === undefined ? {} : { pageSize: query.data.pageSize }),
      ...(query.data.storeId === undefined ? {} : { storeId: query.data.storeId }),
    });
  });

  app.get<{ Params: { attendanceId: string } }>(
    `${base}/:attendanceId/selfie-url`,
    readOptions,
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.createSelfieReadUrl(session.principal, params.data.attendanceId);
    },
  );

  app.post<{ Params: { attendanceId: string } }>(
    `${base}/:attendanceId/decision`,
    writeOptions,
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const body = decisionSchema.safeParse(request.body);
      if (!params.success || !body.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.decide(
        session.principal,
        params.data.attendanceId,
        {
          decision: body.data.decision,
          ...(body.data.reason === undefined ? {} : { reason: body.data.reason }),
        },
        request.id,
      );
    },
  );

  app.get<{ Params: { attendanceId: string } }>(
    `${base}/:attendanceId`,
    readOptions,
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.getDetail(session.principal, params.data.attendanceId);
    },
  );
}

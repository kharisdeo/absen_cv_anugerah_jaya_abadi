import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../errors/app-error.js';
import type { AttendanceAttemptService } from '../modules/attendance/index.js';
import { attendanceAttemptBodySchema } from '../modules/attendance/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import { assertAllowedOrigin, requireSession, setNoStore, type AuthRoutesOptions } from './auth.js';

export const MAX_ATTENDANCE_ATTEMPT_BODY_BYTES = 300 * 1024;

export type AttendanceAttemptRoutesOptions = Readonly<{
  service: AttendanceAttemptService;
  auth: AuthRoutesOptions;
}>;

function invalidAttemptInput(): AppError {
  return new AppError(400, 'INVALID_ATTENDANCE_ATTEMPT', 'Payload percobaan absensi tidak valid.');
}

async function setNoStoreOnSend(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  setNoStore(reply);
  return payload;
}

export async function registerAttendanceAttemptRoutes(
  app: FastifyInstance,
  options: AttendanceAttemptRoutesOptions,
): Promise<void> {
  const routePath = `${API_PREFIX}/attendance/attempts`;
  const rateLimit = options.auth.sensitiveRateLimit ?? {
    max: 5,
    timeWindow: '15 minutes',
  };

  app.post(
    routePath,
    {
      bodyLimit: MAX_ATTENDANCE_ATTEMPT_BODY_BYTES,
      config: { rateLimit },
      onRequest: async (request, reply) => {
        setNoStore(reply);
        assertAllowedOrigin(request, options.auth);
        await requireSession(request, reply, options.auth);
      },
      onSend: setNoStoreOnSend,
    },
    async (request, reply) => {
      const parsed = attendanceAttemptBodySchema.safeParse(request.body);
      if (!parsed.success) throw invalidAttemptInput();

      const principal = request.authSession?.principal;
      if (!principal) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
      }

      const receipt = await options.service.createAttempt(principal, parsed.data, {
        clientIp: request.ip,
        requestId: request.id,
      });

      reply.code(receipt.replayed ? 200 : 202);
      return receipt;
    },
  );
}

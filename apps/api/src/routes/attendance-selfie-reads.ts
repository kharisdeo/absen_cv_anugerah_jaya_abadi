import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import type { AuditService } from '../modules/audit/index.js';
import type { SelfieUploadService } from '../modules/attendance/selfie-upload.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import { setNoStore, type AuthRoutesOptions } from './auth.js';

const paramsSchema = z.object({ attemptId: z.string().uuid() }).strict();

export type AttendanceSelfieReadRoutesOptions = Readonly<{
  service: SelfieUploadService;
  auth: AuthRoutesOptions;
  audit?: AuditService;
}>;

async function setNoStoreOnSend(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  setNoStore(reply);
  return payload;
}

export async function registerAttendanceSelfieReadRoutes(
  app: FastifyInstance,
  options: AttendanceSelfieReadRoutesOptions,
): Promise<void> {
  const rateLimit = options.auth.sensitiveRateLimit ?? {
    max: 5,
    timeWindow: '15 minutes',
  };
  app.get<{ Params: { attemptId: string } }>(
    `${API_PREFIX}/admin/attendance-attempts/:attemptId/selfie-url`,
    {
      config: { rateLimit },
      onRequest: async (_request, reply) => setNoStore(reply),
      onSend: setNoStoreOnSend,
    },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        throw new AppError(400, 'INVALID_SELFIE_REFERENCE', 'Referensi bukti selfie tidak valid.');
      }
      const principal = request.authSession?.principal;
      if (!principal) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
      }
      const signed = await options.service.createReadUrl(principal, params.data.attemptId);
      await options.audit?.record({
        actor: { userAccountId: principal.userAccountId, role: principal.role },
        action: 'attendance.selfie.read-url.create',
        entityType: 'attendance_attempt',
        entityId: params.data.attemptId,
        after: { expiresAt: signed.expiresAt },
        clientIp: request.ip,
        requestId: request.id,
      });
      reply.header('cache-control', 'no-store');
      return signed;
    },
  );
}

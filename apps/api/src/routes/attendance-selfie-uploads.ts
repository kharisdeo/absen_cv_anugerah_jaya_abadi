import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../errors/app-error.js';
import type { SelfieUploadService } from '../modules/attendance/selfie-upload.js';
import { selfieUploadIntentBodySchema } from '../modules/attendance/selfie-upload.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import { assertAllowedOrigin, requireSession, setNoStore, type AuthRoutesOptions } from './auth.js';

const MAX_INTENT_BODY_BYTES = 2 * 1024;

export type AttendanceSelfieUploadRoutesOptions = Readonly<{
  service: SelfieUploadService;
  auth: AuthRoutesOptions;
}>;

function invalidInput(): AppError {
  return new AppError(400, 'INVALID_SELFIE_UPLOAD_INTENT', 'Payload upload selfie tidak valid.');
}

async function setNoStoreOnSend(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  setNoStore(reply);
  return payload;
}

export async function registerAttendanceSelfieUploadRoutes(
  app: FastifyInstance,
  options: AttendanceSelfieUploadRoutesOptions,
): Promise<void> {
  const routePath = `${API_PREFIX}/attendance/selfie-upload-intents`;
  const rateLimit = options.auth.sensitiveRateLimit ?? {
    max: 5,
    timeWindow: '15 minutes',
  };

  app.post(
    routePath,
    {
      bodyLimit: MAX_INTENT_BODY_BYTES,
      config: { rateLimit },
      onRequest: async (request, reply) => {
        setNoStore(reply);
        assertAllowedOrigin(request, options.auth);
        await requireSession(request, reply, options.auth);
      },
      onSend: setNoStoreOnSend,
    },
    async (request, reply) => {
      const parsed = selfieUploadIntentBodySchema.safeParse(request.body);
      if (!parsed.success) throw invalidInput();

      const principal = request.authSession?.principal;
      if (!principal) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
      }

      const intent = await options.service.createUploadIntent(principal, parsed.data);
      reply.code(201);
      return intent;
    },
  );
}

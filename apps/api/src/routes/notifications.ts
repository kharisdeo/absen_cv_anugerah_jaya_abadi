import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import type { NotificationService } from '../modules/notifications/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import { assertAllowedOrigin, requireSession, setNoStore, type AuthRoutesOptions } from './auth.js';

const listQuerySchema = z
  .object({
    read: z.enum(['ALL', 'READ', 'UNREAD']).optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
const notificationParamsSchema = z.object({ notificationId: z.string().uuid() }).strict();

export type NotificationRoutesOptions = Readonly<{
  service: NotificationService;
  auth: AuthRoutesOptions;
}>;

function invalidInput(): AppError {
  return new AppError(400, 'INVALID_NOTIFICATION_INPUT', 'Parameter notifikasi tidak valid.');
}

async function noStoreOnSend(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  setNoStore(reply);
  return payload;
}

export async function registerNotificationRoutes(
  app: FastifyInstance,
  options: NotificationRoutesOptions,
): Promise<void> {
  const base = `${API_PREFIX}/notifications`;
  app.get(
    base,
    {
      onRequest: async (_request, reply) => setNoStore(reply),
      onSend: noStoreOnSend,
    },
    async (request, reply) => {
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.list(session.principal, {
        read: query.data.read ?? 'ALL',
        ...(query.data.page === undefined ? {} : { page: query.data.page }),
        ...(query.data.pageSize === undefined ? {} : { pageSize: query.data.pageSize }),
      });
    },
  );

  app.patch<{ Params: { notificationId: string } }>(
    `${base}/:notificationId/read`,
    {
      config: {
        rateLimit: options.auth.sensitiveRateLimit ?? { max: 30, timeWindow: '1 minute' },
      },
      onRequest: async (request, reply) => {
        setNoStore(reply);
        assertAllowedOrigin(request, options.auth);
      },
      onSend: noStoreOnSend,
    },
    async (request, reply) => {
      const params = notificationParamsSchema.safeParse(request.params);
      if (!params.success) throw invalidInput();
      const session = await requireSession(request, reply, options.auth);
      return options.service.markRead(session.principal, params.data.notificationId);
    },
  );
}

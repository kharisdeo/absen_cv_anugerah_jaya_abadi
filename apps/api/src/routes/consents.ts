import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import { ConsentService } from '../modules/consent/index.js';
import { API_PREFIX } from '../shared/api-prefix.js';
import {
  assertAllowedOrigin,
  requestContext,
  requireSession,
  setNoStore,
  type AuthRoutesOptions,
} from './auth.js';

const acceptBody = z
  .object({ policyVersion: z.string().min(1).max(100), accepted: z.literal(true) })
  .strict();
const historyQuery = z
  .object({
    accountId: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type ConsentRoutesOptions = Readonly<{
  service: ConsentService;
  auth: AuthRoutesOptions;
  sensitiveRateLimit?: Readonly<{ max: number; timeWindow: string }>;
}>;

function invalidInput(): AppError {
  return new AppError(400, 'INVALID_INPUT', 'Payload consent tidak valid.');
}

export async function registerConsentRoutes(
  app: FastifyInstance,
  options: ConsentRoutesOptions,
): Promise<void> {
  const base = `${API_PREFIX}/consents`;
  const sensitiveRateLimit = options.sensitiveRateLimit ?? {
    max: 10,
    timeWindow: '15 minutes',
  };

  app.get(`${base}/current`, async (request, reply) => {
    const session = await requireSession(request, reply, options.auth);
    setNoStore(reply);
    return options.service.current(session.principal.userAccountId);
  });

  app.post(
    base,
    {
      config: { rateLimit: sensitiveRateLimit },
      preHandler: async (request, reply) => {
        assertAllowedOrigin(request, options.auth);
        await requireSession(request, reply, options.auth);
      },
    },
    async (request, reply) => {
      const parsed = acceptBody.safeParse(request.body);
      if (!parsed.success) throw invalidInput();
      const session = request.authSession;
      if (!session)
        throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
      const result = await options.service.accept(
        session.principal,
        parsed.data,
        requestContext(request),
      );
      setNoStore(reply);
      return {
        policyVersion: result.record.policyVersion,
        acceptedAt: result.record.acceptedAt,
        alreadyAccepted: result.alreadyAccepted,
      };
    },
  );

  app.get(`${base}/history`, async (request, reply) => {
    const session = await requireSession(request, reply, options.auth);
    const parsed = historyQuery.safeParse(request.query);
    if (!parsed.success) throw invalidInput();
    setNoStore(reply);
    return options.service.history(session.principal, {
      ...(parsed.data.accountId ? { accountId: parsed.data.accountId } : {}),
      ...(parsed.data.page === undefined ? {} : { page: parsed.data.page }),
      ...(parsed.data.pageSize === undefined ? {} : { pageSize: parsed.data.pageSize }),
    });
  });
}

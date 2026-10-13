import type { FastifyInstance } from 'fastify';

import type { ReadinessProbe } from '../db/readiness.js';
import { API_PREFIX } from '../shared/api-prefix.js';

export async function registerHealthRoute(
  app: FastifyInstance,
  readiness?: ReadinessProbe,
  appVersion?: string,
): Promise<void> {
  app.get(`${API_PREFIX}/health`, async (_request, reply) => {
    if (appVersion !== undefined) reply.header('X-App-Version', appVersion);
    return { status: 'ok' as const };
  });

  app.get(`${API_PREFIX}/ready`, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!readiness) return reply.code(503).send({ status: 'unavailable' as const });

    try {
      await readiness();
      return { status: 'ok' as const };
    } catch {
      return reply.code(503).send({ status: 'unavailable' as const });
    }
  });
}

import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';

export type ReadinessProbe = () => Promise<void>;

/** Check database connectivity without exposing the query result or connection details. */
export function createDatabaseReadinessProbe(
  prisma: Pick<PrismaClient, '$queryRaw'>,
): ReadinessProbe {
  return async () => {
    await prisma.$queryRaw(Prisma.sql`SELECT 1`);
  };
}

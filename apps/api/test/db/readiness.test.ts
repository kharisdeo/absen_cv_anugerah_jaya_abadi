import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createDatabaseReadinessProbe } from '../../src/db/readiness.js';

describe('database readiness probe', () => {
  it('executes a static parameterized SELECT 1 through Prisma', async () => {
    const queryRaw = vi.fn(async (...args: unknown[]) => {
      void args;
      return [{ result: 1 }];
    });
    const prisma = { $queryRaw: queryRaw } as unknown as Pick<PrismaClient, '$queryRaw'>;

    await createDatabaseReadinessProbe(prisma)();

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0]?.[0]).toMatchObject({ sql: 'SELECT 1', values: [] });
  });
});

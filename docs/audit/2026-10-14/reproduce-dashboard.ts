import { createPrismaClient } from '../../../apps/api/src/db/prisma.js';
import { PrismaDashboardRepository } from '../../../apps/api/src/modules/dashboard/prisma-repository.js';
import { assertEphemeralDatabaseUrl } from '../../../apps/api/test/postgres-smoke-guard.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
assertEphemeralDatabaseUrl(databaseUrl);
const prisma = createPrismaClient(databaseUrl);
try {
  const repository = new PrismaDashboardRepository(prisma);
  await repository.employeeDashboard({
    userAccountId: '10000000-0000-4000-8000-000000000001',
    employeeId: '10000000-0000-4000-8000-000000000002',
    date: '2026-10-14',
    historyPage: 1,
    historyPageSize: 10,
    requestPage: 1,
    requestPageSize: 10,
  });
  console.info('Employee dashboard query completed.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Query failed.');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

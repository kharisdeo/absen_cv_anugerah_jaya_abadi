import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client.js';

export function createPrismaClient(databaseUrl: string | undefined): PrismaClient {
  if (!databaseUrl) throw new Error('DATABASE_URL wajib dikonfigurasi untuk API.');
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

import { env } from '../config/env.js';
import { createPrismaClient } from '../db/prisma.js';
import { DailyAttendanceService } from '../modules/daily-attendance/index.js';
import { PrismaDailyAttendanceRepository } from '../modules/daily-attendance/prisma-repository.js';

if (!env.DATABASE_URL)
  throw new Error('DATABASE_URL wajib dikonfigurasi untuk evaluasi status harian.');

const prisma = createPrismaClient(env.DATABASE_URL);

try {
  const service = new DailyAttendanceService(new PrismaDailyAttendanceRepository(prisma));
  const result = await service.runAbsentJob();
  console.info(JSON.stringify({ task: 'daily-attendance-status', ...result }));
} catch {
  console.error(JSON.stringify({ task: 'daily-attendance-status', status: 'failed' }));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

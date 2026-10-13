import { env } from '../config/env.js';
import { createPrismaClient } from '../db/prisma.js';
import { PrismaSelfieUploadIntentRepository } from '../modules/attendance/prisma-selfie-upload-repository.js';
import {
  S3PrivateSelfieStorage,
  type PrivateSelfieStorage,
} from '../modules/attendance/private-selfie-storage.js';
import { SelfieUploadService } from '../modules/attendance/selfie-upload.js';
import { runSelfieRetentionJob } from './selfie-retention-runner.js';

if (!env.DATABASE_URL) throw new Error('DATABASE_URL wajib dikonfigurasi untuk purge selfie.');
if (!env.STORAGE_BUCKET || !env.STORAGE_ACCESS_KEY || !env.STORAGE_SECRET_KEY) {
  throw new Error('Konfigurasi private selfie storage wajib tersedia untuk purge selfie.');
}

const prisma = createPrismaClient(env.DATABASE_URL);
const storage: PrivateSelfieStorage & { close(): Promise<void> } = new S3PrivateSelfieStorage({
  ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT } : {}),
  region: env.STORAGE_REGION,
  bucket: env.STORAGE_BUCKET,
  accessKey: env.STORAGE_ACCESS_KEY,
  secretKey: env.STORAGE_SECRET_KEY,
});
const service = new SelfieUploadService(
  new PrismaSelfieUploadIntentRepository(prisma),
  storage,
  env.SELFIE_UPLOAD_URL_TTL_SECONDS,
);

try {
  const result = await runSelfieRetentionJob((batchSize) => service.purgeExpiredBatch(batchSize));
  if (result.status === 'failed') {
    console.error(JSON.stringify({ task: 'selfie-retention', status: 'failed' }));
  } else {
    console.info(
      JSON.stringify({
        task: 'selfie-retention',
        attachedPurged: result.attachedPurged,
        stagingPurged: result.stagingPurged,
        failures: result.failures,
        reachedBatchLimit: result.reachedBatchLimit,
      }),
    );
  }
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
} finally {
  await prisma.$disconnect();
  await storage.close();
}

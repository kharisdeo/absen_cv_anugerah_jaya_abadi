import { env } from '../config/env.js';
import { createPrismaClient } from '../db/prisma.js';
import { PrismaSelfieUploadIntentRepository } from '../modules/attendance/prisma-selfie-upload-repository.js';
import {
  S3PrivateSelfieStorage,
  type PrivateSelfieStorage,
} from '../modules/attendance/private-selfie-storage.js';
import { SelfieUploadService } from '../modules/attendance/selfie-upload.js';
import { runSelfieRetentionDryRun, runSelfieRetentionJob } from './selfie-retention-runner.js';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--dry-run')) {
  console.error('Usage: selfie-retention [--dry-run]');
  process.exit(2);
}
const dryRun = args[0] === '--dry-run';

if (!env.DATABASE_URL) throw new Error('DATABASE_URL wajib dikonfigurasi untuk job selfie.');
const prisma = createPrismaClient(env.DATABASE_URL);
const repository = new PrismaSelfieUploadIntentRepository(prisma);
let storage: (PrivateSelfieStorage & { close(): Promise<void> }) | null = null;

try {
  if (dryRun) {
    const result = await runSelfieRetentionDryRun(() =>
      repository.previewRetentionCandidates({ now: new Date(), take: 500 }),
    );
    if (result.status === 'failed') {
      console.error(JSON.stringify({ task: 'selfie-retention', status: 'dry-run-failed' }));
    } else {
      console.info(
        JSON.stringify({
          task: 'selfie-retention',
          status: result.status,
          ...result.preview,
          mutationsPerformed: false,
        }),
      );
    }
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } else {
    if (!env.STORAGE_BUCKET || !env.STORAGE_ACCESS_KEY || !env.STORAGE_SECRET_KEY) {
      throw new Error('Konfigurasi private selfie storage wajib tersedia untuk purge selfie.');
    }
    storage = new S3PrivateSelfieStorage({
      ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT } : {}),
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY,
      secretKey: env.STORAGE_SECRET_KEY,
    });
    const service = new SelfieUploadService(repository, storage, env.SELFIE_UPLOAD_URL_TTL_SECONDS);
    const result = await runSelfieRetentionJob(async (batchSize) => {
      const watermarking = await service.watermarkPendingBatch(batchSize);
      const retention = await service.purgeExpiredBatch(batchSize);
      return {
        ...retention,
        watermarked: watermarking.watermarked,
        failures: retention.failures + watermarking.failures,
      };
    });
    if (result.status === 'failed') {
      console.error(JSON.stringify({ task: 'selfie-retention', status: 'failed' }));
    } else {
      console.info(
        JSON.stringify({
          task: 'selfie-retention',
          watermarked: result.watermarked,
          attachedPurged: result.attachedPurged,
          stagingPurged: result.stagingPurged,
          failures: result.failures,
          reachedBatchLimit: result.reachedBatchLimit,
        }),
      );
    }
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  }
} finally {
  await prisma.$disconnect();
  await storage?.close();
}

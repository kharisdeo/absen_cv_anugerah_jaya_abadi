export type SelfieRetentionBatchResult = Readonly<{
  attachedPurged: number;
  stagingPurged: number;
  failures: number;
}>;

export type SelfieRetentionJobResult =
  | Readonly<{
      status: 'completed';
      attachedPurged: number;
      stagingPurged: number;
      failures: number;
      reachedBatchLimit: boolean;
      exitCode: 0 | 1;
    }>
  | Readonly<{ status: 'failed'; exitCode: 1 }>;

const BATCH_SIZE = 500;
const MAX_BATCHES = 100;

/** Runs the bounded retention loop and returns the same success/failure decision used by the CLI. */
export async function runSelfieRetentionJob(
  purgeExpiredBatch: (batchSize: number) => Promise<SelfieRetentionBatchResult>,
): Promise<SelfieRetentionJobResult> {
  const totals = { attachedPurged: 0, stagingPurged: 0, failures: 0 };
  let reachedBatchLimit = true;

  try {
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const result = await purgeExpiredBatch(BATCH_SIZE);
      totals.attachedPurged += result.attachedPurged;
      totals.stagingPurged += result.stagingPurged;
      totals.failures += result.failures;

      if (result.failures > 0) {
        reachedBatchLimit = false;
        break;
      }
      if (result.attachedPurged < BATCH_SIZE && result.stagingPurged < BATCH_SIZE) {
        reachedBatchLimit = false;
        break;
      }
    }
  } catch {
    return { status: 'failed', exitCode: 1 };
  }

  return {
    status: 'completed',
    ...totals,
    reachedBatchLimit,
    exitCode: totals.failures > 0 || reachedBatchLimit ? 1 : 0,
  };
}

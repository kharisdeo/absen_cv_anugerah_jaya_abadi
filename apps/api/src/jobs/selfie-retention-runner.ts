export type SelfieRetentionBatchResult = Readonly<{
  watermarked: number;
  attachedPurged: number;
  stagingPurged: number;
  failures: number;
}>;

export type SelfieRetentionDryRunResult<T = unknown> =
  | Readonly<{
      status: 'dry-run';
      preview: T;
      exitCode: 0;
    }>
  | Readonly<{ status: 'failed'; exitCode: 1 }>;

export type SelfieRetentionJobResult =
  | Readonly<{
      status: 'completed';
      attachedPurged: number;
      stagingPurged: number;
      watermarked: number;
      failures: number;
      reachedBatchLimit: boolean;
      exitCode: 0 | 1;
    }>
  | Readonly<{ status: 'failed'; exitCode: 1 }>;

const BATCH_SIZE = 500;
const MAX_BATCHES = 100;

/** Invokes only the injected read-only preview operation; it has no mutation callback. */
export async function runSelfieRetentionDryRun<T>(
  previewCandidates: () => Promise<T>,
): Promise<SelfieRetentionDryRunResult<T>> {
  try {
    return { status: 'dry-run', preview: await previewCandidates(), exitCode: 0 };
  } catch {
    return { status: 'failed', exitCode: 1 };
  }
}

/** Runs the bounded retention loop and returns the same success/failure decision used by the CLI. */
export async function runSelfieRetentionJob(
  purgeExpiredBatch: (batchSize: number) => Promise<SelfieRetentionBatchResult>,
): Promise<SelfieRetentionJobResult> {
  const totals = { attachedPurged: 0, stagingPurged: 0, watermarked: 0, failures: 0 };
  let reachedBatchLimit = true;

  try {
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const result = await purgeExpiredBatch(BATCH_SIZE);
      totals.attachedPurged += result.attachedPurged;
      totals.stagingPurged += result.stagingPurged;
      totals.watermarked += result.watermarked;
      totals.failures += result.failures;

      if (result.failures > 0) {
        reachedBatchLimit = false;
        break;
      }
      if (
        result.watermarked < BATCH_SIZE &&
        result.attachedPurged < BATCH_SIZE &&
        result.stagingPurged < BATCH_SIZE
      ) {
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

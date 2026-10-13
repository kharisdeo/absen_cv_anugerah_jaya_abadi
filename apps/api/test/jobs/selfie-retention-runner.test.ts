import { describe, expect, it, vi } from 'vitest';

import { runSelfieRetentionJob } from '../../src/jobs/selfie-retention-runner.js';

describe('selfie retention job runner', () => {
  it('drains full batches, totals the result, and exits successfully when the queue is empty', async () => {
    const purgeExpiredBatch = vi
      .fn()
      .mockResolvedValueOnce({ attachedPurged: 500, stagingPurged: 0, failures: 0 })
      .mockResolvedValueOnce({ attachedPurged: 120, stagingPurged: 40, failures: 0 });

    await expect(runSelfieRetentionJob(purgeExpiredBatch)).resolves.toEqual({
      status: 'completed',
      attachedPurged: 620,
      stagingPurged: 40,
      failures: 0,
      reachedBatchLimit: false,
      exitCode: 0,
    });
    expect(purgeExpiredBatch).toHaveBeenNthCalledWith(1, 500);
    expect(purgeExpiredBatch).toHaveBeenNthCalledWith(2, 500);
    expect(purgeExpiredBatch).toHaveBeenCalledTimes(2);
  });

  it('stops on a partial cleanup failure and returns a failing exit code with totals', async () => {
    const purgeExpiredBatch = vi
      .fn()
      .mockResolvedValueOnce({ attachedPurged: 3, stagingPurged: 2, failures: 1 });

    await expect(runSelfieRetentionJob(purgeExpiredBatch)).resolves.toEqual({
      status: 'completed',
      attachedPurged: 3,
      stagingPurged: 2,
      failures: 1,
      reachedBatchLimit: false,
      exitCode: 1,
    });
    expect(purgeExpiredBatch).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the job reaches its 100-batch cap', async () => {
    const purgeExpiredBatch = vi.fn(async () => ({
      attachedPurged: 500,
      stagingPurged: 500,
      failures: 0,
    }));

    const result = await runSelfieRetentionJob(purgeExpiredBatch);

    expect(result).toMatchObject({ status: 'completed', reachedBatchLimit: true, exitCode: 1 });
    expect(purgeExpiredBatch).toHaveBeenCalledTimes(100);
  });

  it('returns a generic failing outcome if a batch throws without leaking provider details', async () => {
    const purgeExpiredBatch = vi.fn(async () => {
      throw new Error('synthetic database or storage failure detail');
    });

    await expect(runSelfieRetentionJob(purgeExpiredBatch)).resolves.toEqual({
      status: 'failed',
      exitCode: 1,
    });
    expect(purgeExpiredBatch).toHaveBeenCalledTimes(1);
  });
});

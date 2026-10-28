import { describe, expect, it, vi } from 'vitest';

import {
  runSelfieRetentionDryRun,
  runSelfieRetentionJob,
} from '../../src/jobs/selfie-retention-runner.js';

describe('selfie retention job runner', () => {
  it('runs a dry-run through only the injected read-only candidate preview', async () => {
    const previewCandidates = vi.fn(async () => ({
      watermarkCandidates: 2,
      attachedStagingCandidates: 1,
      expiredAttachedCandidates: 3,
      expiredPendingCandidates: 4,
    }));

    await expect(runSelfieRetentionDryRun(previewCandidates)).resolves.toEqual({
      status: 'dry-run',
      preview: {
        watermarkCandidates: 2,
        attachedStagingCandidates: 1,
        expiredAttachedCandidates: 3,
        expiredPendingCandidates: 4,
      },
      exitCode: 0,
    });
    expect(previewCandidates).toHaveBeenCalledTimes(1);
  });

  it('returns a generic dry-run failure without leaking database details', async () => {
    const previewCandidates = vi.fn(async () => {
      throw new Error('synthetic database failure detail');
    });

    await expect(runSelfieRetentionDryRun(previewCandidates)).resolves.toEqual({
      status: 'failed',
      exitCode: 1,
    });
    expect(previewCandidates).toHaveBeenCalledTimes(1);
  });

  it('drains full batches, totals the result, and exits successfully when the queue is empty', async () => {
    const purgeExpiredBatch = vi
      .fn()
      .mockResolvedValueOnce({ watermarked: 500, attachedPurged: 0, stagingPurged: 0, failures: 0 })
      .mockResolvedValueOnce({
        watermarked: 120,
        attachedPurged: 40,
        stagingPurged: 0,
        failures: 0,
      });

    await expect(runSelfieRetentionJob(purgeExpiredBatch)).resolves.toEqual({
      status: 'completed',
      attachedPurged: 40,
      stagingPurged: 0,
      watermarked: 620,
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
      .mockResolvedValueOnce({ watermarked: 1, attachedPurged: 3, stagingPurged: 2, failures: 1 });

    await expect(runSelfieRetentionJob(purgeExpiredBatch)).resolves.toEqual({
      status: 'completed',
      attachedPurged: 3,
      stagingPurged: 2,
      watermarked: 1,
      failures: 1,
      reachedBatchLimit: false,
      exitCode: 1,
    });
    expect(purgeExpiredBatch).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the job reaches its 100-batch cap', async () => {
    const purgeExpiredBatch = vi.fn(async () => ({
      watermarked: 500,
      attachedPurged: 500,
      stagingPurged: 500,
      failures: 0,
    }));

    const result = await runSelfieRetentionJob(purgeExpiredBatch);

    expect(result).toMatchObject({ status: 'completed', reachedBatchLimit: true, exitCode: 1 });
    expect(purgeExpiredBatch).toHaveBeenCalledTimes(100);
  });

  it('drains full watermark batches even when no retention deletions are required', async () => {
    const batch = vi
      .fn()
      .mockResolvedValueOnce({ watermarked: 500, attachedPurged: 0, stagingPurged: 0, failures: 0 })
      .mockResolvedValueOnce({ watermarked: 2, attachedPurged: 0, stagingPurged: 0, failures: 0 });

    await expect(runSelfieRetentionJob(batch)).resolves.toMatchObject({
      status: 'completed',
      watermarked: 502,
      failures: 0,
      exitCode: 0,
    });
    expect(batch).toHaveBeenCalledTimes(2);
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

import { describe, expect, it, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';

import {
  DOCTOR_NOTE_READ_URL_TTL_SECONDS,
  S3PrivateRequestAttachmentStorage,
} from '../../src/modules/attendance-requests/private-request-attachment-storage.js';

const CONFIG = {
  region: 'us-east-1',
  bucket: 'private-test-bucket',
  accessKey: 'test-access-key',
  secretKey: 'test-secret-key-not-real',
};

describe('S3PrivateRequestAttachmentStorage', () => {
  it('uses a separate doctor-note prefix and never sets a public ACL', async () => {
    const send = vi.fn(async (command: { input: Record<string, unknown> }) => {
      expect(command.input.Key).toBe('attendance-requests/doctor-notes/generated-random-key');
      expect(command.input).toMatchObject({
        ContentType: 'image/jpeg',
        ContentLength: 3,
        CacheControl: 'private, no-store, max-age=0',
      });
      expect(command.input.ACL).toBeUndefined();
      return {};
    });
    const storage = new S3PrivateRequestAttachmentStorage(CONFIG, { send } as unknown as S3Client);
    await storage.putDoctorNote({
      objectKey: 'attendance-requests/doctor-notes/generated-random-key',
      contentType: 'image/jpeg',
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects keys outside the private doctor-note prefix', async () => {
    const send = vi.fn();
    const storage = new S3PrivateRequestAttachmentStorage(CONFIG, { send } as unknown as S3Client);
    await expect(
      storage.createReadUrl({ objectKey: 'attendance/selfie/other', expiresInSeconds: 120 }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST_ATTACHMENT' });
    expect(send).not.toHaveBeenCalled();
  });

  it('creates short-lived attachment-only download links without using selfie retention', async () => {
    const storage = new S3PrivateRequestAttachmentStorage(CONFIG);
    const url = await storage.createReadUrl({
      objectKey: 'attendance-requests/doctor-notes/generated-random-key',
      expiresInSeconds: DOCTOR_NOTE_READ_URL_TTL_SECONDS,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(parsed.searchParams.get('response-cache-control')).toBe('private, no-store, max-age=0');
    expect(parsed.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="surat-dokter"',
    );
    await storage.close();
  });
});

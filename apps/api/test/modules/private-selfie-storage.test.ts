import { describe, expect, it, vi } from 'vitest';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

import { S3PrivateSelfieStorage } from '../../src/modules/attendance/private-selfie-storage.js';

const CONFIG = {
  endpoint: 'https://s3.example.test',
  region: 'us-east-1',
  bucket: 'private-attendance',
  accessKey: 'test-access-key',
  secretKey: 'test-secret-key-that-is-never-logged',
};
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2sAAAAASUVORK5CYII=',
  'base64',
);

function mockClient(
  storage: S3PrivateSelfieStorage,
  send: (command: unknown) => Promise<unknown>,
): void {
  (storage as unknown as { client: Pick<S3Client, 'send' | 'destroy'> }).client = {
    send: vi.fn(send) as never,
    destroy: vi.fn(),
  };
}

describe('S3PrivateSelfieStorage', () => {
  it('mints a short-lived PUT URL with exact content type and reference hash headers', async () => {
    const storage = new S3PrivateSelfieStorage(CONFIG);
    const signed = await storage.createUploadUrl({
      objectKey: 'attendance/selfie-staging/random-key',
      contentType: 'image/jpeg',
      referenceHash: 'a'.repeat(64),
      expiresInSeconds: 120,
    });
    const parsed = new URL(signed.url);

    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-type;host;x-amz-meta-referencehash',
    );
    expect(parsed.searchParams.has('x-amz-acl')).toBe(false);
    expect(signed.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'x-amz-meta-referencehash': 'a'.repeat(64),
    });
    await storage.close();
  });

  it('mints a short-lived GET URL for a single object with private no-store response caching', async () => {
    const storage = new S3PrivateSelfieStorage(CONFIG);
    const url = await storage.createReadUrl({
      objectKey: 'attendance/selfie-accepted/opaque-key',
      expiresInSeconds: 45,
    });
    const parsed = new URL(url);

    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('45');
    expect(parsed.searchParams.get('response-cache-control')).toBe('private, no-store');
    expect(parsed.pathname).toContain('/attendance/selfie-accepted/opaque-key');
    await storage.close();
  });

  it('reads metadata and validates actual image signature/dimensions without returning bytes', async () => {
    const storage = new S3PrivateSelfieStorage(CONFIG);
    const send = async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: PNG_BYTES.byteLength,
          ContentType: 'image/png',
          ETag: '"etag-png"',
          Metadata: { referencehash: 'b'.repeat(64) },
        };
      }
      if (command instanceof GetObjectCommand) {
        return {
          ETag: '"etag-png"',
          Body: { transformToByteArray: async () => PNG_BYTES },
        };
      }
      throw new Error('Unexpected storage command.');
    };
    mockClient(storage, send);

    const object = await storage.inspectObject('attendance/selfie-staging/key');

    expect(object).toEqual({
      contentType: 'image/png',
      sizeBytes: PNG_BYTES.byteLength,
      referenceHash: 'b'.repeat(64),
      imageType: 'png',
      width: 1,
      height: 1,
      entityTag: '"etag-png"',
      bytes: PNG_BYTES,
    });
  });

  it('does not download a selfie larger than 200 KiB for signature inspection', async () => {
    const storage = new S3PrivateSelfieStorage(CONFIG);
    const getObject = vi.fn();
    mockClient(storage, async (command) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: 204_801,
          ContentType: 'image/png',
          ETag: '"etag-oversized"',
          Metadata: { referencehash: 'b'.repeat(64) },
        };
      }
      if (command instanceof GetObjectCommand) getObject(command);
      throw new Error('Unexpected storage command.');
    });

    await expect(
      storage.inspectObject('attendance/selfie-staging/oversized'),
    ).resolves.toMatchObject({
      sizeBytes: 204_801,
      contentType: 'image/png',
      bytes: undefined,
    });
    expect(getObject).not.toHaveBeenCalled();
  });

  it('rejects bytes if the object ETag changes between HEAD and conditional GET', async () => {
    const storage = new S3PrivateSelfieStorage(CONFIG);
    let getInput: Record<string, unknown> | undefined;
    mockClient(storage, async (command) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: PNG_BYTES.byteLength,
          ContentType: 'image/png',
          ETag: '"etag-head"',
          Metadata: { referencehash: 'b'.repeat(64) },
        };
      }
      if (command instanceof GetObjectCommand) {
        getInput = (command as GetObjectCommand & { input: Record<string, unknown> }).input;
        return {
          ETag: '"etag-get"',
          Body: { transformToByteArray: async () => PNG_BYTES },
        };
      }
      throw new Error('Unexpected storage command.');
    });

    await expect(
      storage.inspectObject('attendance/selfie-staging/etag-changed'),
    ).resolves.toMatchObject({
      imageType: undefined,
      entityTag: '"etag-head"',
      bytes: undefined,
    });
    expect(getInput).toMatchObject({ IfMatch: '"etag-head"' });
  });

  it('returns null for missing objects and refuses to validate bytes that changed during inspection', async () => {
    const missing = new S3PrivateSelfieStorage(CONFIG);
    mockClient(missing, async () => {
      throw Object.assign(new Error('not found'), { name: 'NoSuchKey', $metadata: {} });
    });
    await expect(missing.inspectObject('attendance/selfie-staging/missing')).resolves.toBeNull();

    const changed = new S3PrivateSelfieStorage(CONFIG);
    mockClient(changed, async (command) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: PNG_BYTES.byteLength,
          ContentType: 'image/png',
          ETag: '"old"',
          Metadata: { referencehash: 'b'.repeat(64) },
        };
      }
      throw Object.assign(new Error('etag mismatch'), {
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      });
    });

    await expect(changed.inspectObject('attendance/selfie-staging/changed')).rejects.toMatchObject({
      statusCode: 422,
      code: 'ATTENDANCE_EVIDENCE_INVALID',
    });
  });

  it('stores verified bytes under a reserved private key conditionally without allowing overwrite', async () => {
    const storage = new S3PrivateSelfieStorage(CONFIG);
    let copyInput: Record<string, unknown> | undefined;
    mockClient(storage, async (command) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      copyInput = (command as { input: Record<string, unknown> }).input;
      return {};
    });

    const key = 'attendance/selfie-accepted/reserved-key';
    await storage.sealObject({
      sealedObjectKey: key,
      bytes: PNG_BYTES,
      contentType: 'image/png',
      referenceHash: 'c'.repeat(64),
    });

    expect(copyInput).toMatchObject({
      Bucket: CONFIG.bucket,
      Key: key,
      Body: PNG_BYTES,
      ContentType: 'image/png',
      CacheControl: 'private, no-store',
      Metadata: { referencehash: 'c'.repeat(64) },
      IfNoneMatch: '*',
    });
    expect(copyInput).not.toHaveProperty('ACL');
  });
});

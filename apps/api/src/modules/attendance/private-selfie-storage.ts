import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { imageSize } from 'image-size';

import { AppError } from '../../errors/app-error.js';

const MAX_SELFIE_SIZE_BYTES = 200 * 1024;

export type SignedSelfieUpload = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
}>;

export type PrivateSelfieObject = Readonly<{
  contentType: string;
  sizeBytes: number;
  referenceHash: string | undefined;
  imageType: string | undefined;
  width: number | undefined;
  height: number | undefined;
  entityTag: string | undefined;
  bytes: Uint8Array | undefined;
}>;

export interface PrivateSelfieStorage {
  createUploadUrl(
    input: Readonly<{
      objectKey: string;
      contentType: string;
      referenceHash: string;
      expiresInSeconds: number;
    }>,
  ): Promise<SignedSelfieUpload>;
  inspectObject(objectKey: string): Promise<PrivateSelfieObject | null>;
  sealObject(
    input: Readonly<{
      sealedObjectKey: string;
      bytes: Uint8Array;
      contentType: string;
      referenceHash: string;
    }>,
  ): Promise<void>;
  createReadUrl(input: Readonly<{ objectKey: string; expiresInSeconds: number }>): Promise<string>;
  deleteObject(objectKey: string): Promise<void>;
}

export type S3PrivateSelfieStorageConfig = Readonly<{
  endpoint?: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}>;

function unavailable(): AppError {
  return new AppError(
    503,
    'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE',
    'Penyimpanan bukti absensi sementara tidak tersedia. Coba lagi nanti.',
  );
}

function missingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return false;
  if ('name' in error && typeof error.name === 'string') {
    return error.name === 'NoSuchKey' || error.name === 'NotFound';
  }
  return false;
}

function sourceChanged(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'PreconditionFailed'
  );
}

function invalidEvidence(): AppError {
  return new AppError(422, 'ATTENDANCE_EVIDENCE_INVALID', 'Referensi bukti absensi tidak valid.');
}

/**
 * S3-compatible private storage adapter. It never sets a public ACL; bucket policy
 * and public-access blocking must be configured by the storage provider owner.
 */
export class S3PrivateSelfieStorage implements PrivateSelfieStorage {
  private readonly client: S3Client;

  constructor(private readonly config: S3PrivateSelfieStorageConfig) {
    const endpoint = config.endpoint === undefined ? undefined : new URL(config.endpoint);
    if (endpoint && (endpoint.username !== '' || endpoint.password !== '')) {
      throw new Error('STORAGE_ENDPOINT must not include credentials.');
    }
    if (endpoint && !['http:', 'https:'].includes(endpoint.protocol)) {
      throw new Error('STORAGE_ENDPOINT must use HTTP or HTTPS.');
    }
    this.client = new S3Client({
      region: config.region,
      ...(endpoint ? { endpoint: endpoint.toString(), forcePathStyle: true } : {}),
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    });
  }

  async createUploadUrl(input: Parameters<PrivateSelfieStorage['createUploadUrl']>[0]) {
    try {
      const command = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
        Metadata: { referencehash: input.referenceHash },
      });
      const url = await getSignedUrl(this.client, command, {
        expiresIn: input.expiresInSeconds,
        signableHeaders: new Set(['content-type', 'x-amz-meta-referencehash']),
        unhoistableHeaders: new Set(['x-amz-meta-referencehash']),
      });
      return {
        url,
        headers: {
          'Content-Type': input.contentType,
          'x-amz-meta-referencehash': input.referenceHash,
        },
      };
    } catch {
      throw unavailable();
    }
  }

  async inspectObject(objectKey: string): Promise<PrivateSelfieObject | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
      );
      const sizeBytes = head.ContentLength;
      const contentType = head.ContentType;
      if (
        typeof sizeBytes !== 'number' ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 1 ||
        sizeBytes > MAX_SELFIE_SIZE_BYTES ||
        typeof contentType !== 'string'
      ) {
        return {
          contentType: contentType ?? '',
          sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : -1,
          referenceHash: head.Metadata?.referencehash,
          imageType: undefined,
          width: undefined,
          height: undefined,
          entityTag: head.ETag,
          bytes: undefined,
        };
      }

      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: objectKey,
          ...(head.ETag ? { IfMatch: head.ETag } : {}),
        }),
      );
      const bytes = await response.Body?.transformToByteArray();
      if (
        !head.ETag ||
        response.ETag !== head.ETag ||
        !bytes ||
        bytes.byteLength !== sizeBytes ||
        bytes.byteLength > MAX_SELFIE_SIZE_BYTES
      ) {
        return {
          contentType,
          sizeBytes: bytes?.byteLength ?? -1,
          referenceHash: head.Metadata?.referencehash,
          imageType: undefined,
          width: undefined,
          height: undefined,
          entityTag: head.ETag,
          bytes: undefined,
        };
      }
      try {
        const dimensions = imageSize(bytes);
        return {
          contentType,
          sizeBytes,
          referenceHash: head.Metadata?.referencehash,
          imageType: dimensions.type,
          width: dimensions.width,
          height: dimensions.height,
          entityTag: head.ETag,
          bytes,
        };
      } catch {
        return {
          contentType,
          sizeBytes,
          referenceHash: head.Metadata?.referencehash,
          imageType: undefined,
          width: undefined,
          height: undefined,
          entityTag: head.ETag,
          bytes,
        };
      }
    } catch (error) {
      if (missingObject(error)) return null;
      if (sourceChanged(error)) throw invalidEvidence();
      throw unavailable();
    }
  }

  async sealObject(input: {
    sealedObjectKey: string;
    bytes: Uint8Array;
    contentType: string;
    referenceHash: string;
  }): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: input.sealedObjectKey,
          Body: input.bytes,
          ContentType: input.contentType,
          CacheControl: 'private, no-store',
          Metadata: { referencehash: input.referenceHash },
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      if (sourceChanged(error)) throw invalidEvidence();
      throw unavailable();
    }
  }

  async createReadUrl(
    input: Readonly<{ objectKey: string; expiresInSeconds: number }>,
  ): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: input.objectKey,
          ResponseCacheControl: 'private, no-store',
        }),
        { expiresIn: input.expiresInSeconds },
      );
    } catch {
      throw unavailable();
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
      );
    } catch {
      throw unavailable();
    }
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}

export class UnavailablePrivateSelfieStorage implements PrivateSelfieStorage {
  async createUploadUrl(): Promise<never> {
    throw unavailable();
  }

  async inspectObject(): Promise<never> {
    throw unavailable();
  }

  async sealObject(): Promise<never> {
    throw unavailable();
  }

  async createReadUrl(): Promise<never> {
    throw unavailable();
  }

  async deleteObject(): Promise<never> {
    throw unavailable();
  }
}

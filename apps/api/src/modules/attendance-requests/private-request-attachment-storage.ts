import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { AppError } from '../../errors/app-error.js';

export const MAX_DOCTOR_NOTE_BYTES = 5 * 1024 * 1024;
export const DOCTOR_NOTE_READ_URL_TTL_SECONDS = 120;
export const DOCTOR_NOTE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type DoctorNoteContentType = (typeof DOCTOR_NOTE_CONTENT_TYPES)[number];

export interface PrivateRequestAttachmentStorage {
  putDoctorNote(
    input: Readonly<{
      objectKey: string;
      contentType: DoctorNoteContentType;
      bytes: Uint8Array;
    }>,
  ): Promise<void>;
  createReadUrl(input: Readonly<{ objectKey: string; expiresInSeconds: number }>): Promise<string>;
  deleteObject(objectKey: string): Promise<void>;
  close?(): Promise<void>;
}

export type S3PrivateRequestAttachmentStorageConfig = Readonly<{
  endpoint?: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}>;

function unavailable(): AppError {
  return new AppError(
    503,
    'REQUEST_ATTACHMENT_STORAGE_UNAVAILABLE',
    'Penyimpanan lampiran pengajuan tidak tersedia.',
  );
}

/** Dedicated medical-note adapter. It deliberately has no selfie retention/claim lifecycle. */
export class S3PrivateRequestAttachmentStorage implements PrivateRequestAttachmentStorage {
  private readonly client: S3Client;

  constructor(
    private readonly config: S3PrivateRequestAttachmentStorageConfig,
    client?: S3Client,
  ) {
    const endpoint = config.endpoint === undefined ? undefined : new URL(config.endpoint);
    if (
      endpoint &&
      (!['http:', 'https:'].includes(endpoint.protocol) ||
        endpoint.username !== '' ||
        endpoint.password !== '' ||
        endpoint.hash !== '')
    ) {
      throw new Error('STORAGE_ENDPOINT must be a safe HTTP(S) endpoint.');
    }
    this.client =
      client ??
      new S3Client({
        region: config.region,
        ...(endpoint ? { endpoint: endpoint.toString(), forcePathStyle: true } : {}),
        credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      });
  }

  async putDoctorNote(input: Parameters<PrivateRequestAttachmentStorage['putDoctorNote']>[0]) {
    if (
      !input.objectKey.startsWith('attendance-requests/doctor-notes/') ||
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > MAX_DOCTOR_NOTE_BYTES
    ) {
      throw new AppError(400, 'INVALID_REQUEST_ATTACHMENT', 'Lampiran pengajuan tidak valid.');
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: input.objectKey,
          Body: Buffer.from(input.bytes),
          ContentType: input.contentType,
          ContentLength: input.bytes.byteLength,
          CacheControl: 'private, no-store, max-age=0',
        }),
      );
    } catch {
      throw unavailable();
    }
  }

  async createReadUrl(input: Parameters<PrivateRequestAttachmentStorage['createReadUrl']>[0]) {
    if (
      !input.objectKey.startsWith('attendance-requests/doctor-notes/') ||
      !Number.isInteger(input.expiresInSeconds) ||
      input.expiresInSeconds < 1 ||
      input.expiresInSeconds > 300
    ) {
      throw new AppError(400, 'INVALID_REQUEST_ATTACHMENT', 'Lampiran pengajuan tidak valid.');
    }
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: input.objectKey,
          ResponseCacheControl: 'private, no-store, max-age=0',
          ResponseContentDisposition: 'attachment; filename="surat-dokter"',
        }),
        { expiresIn: input.expiresInSeconds },
      );
    } catch {
      throw unavailable();
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    if (!objectKey.startsWith('attendance-requests/doctor-notes/')) {
      throw new AppError(400, 'INVALID_REQUEST_ATTACHMENT', 'Lampiran pengajuan tidak valid.');
    }
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

export class UnavailablePrivateRequestAttachmentStorage implements PrivateRequestAttachmentStorage {
  async putDoctorNote(): Promise<never> {
    throw unavailable();
  }

  async createReadUrl(): Promise<never> {
    throw unavailable();
  }

  async deleteObject(): Promise<never> {
    throw unavailable();
  }
}

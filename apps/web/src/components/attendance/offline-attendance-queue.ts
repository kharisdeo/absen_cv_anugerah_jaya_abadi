import type {
  AttendanceAttemptDraft,
  AttendanceReceipt,
  AttendanceType,
} from '../../api/attendance-api.js';
import {
  API_ATTENDANCE_ATTEMPT_STATES,
  API_ATTENDANCE_VALIDATION_STATUSES,
  isApiDateTime,
} from '../../api/api-contract.js';

export const OFFLINE_QUEUE_SCHEMA_VERSION = 1;
export const OFFLINE_QUEUE_DATABASE = 'absen-aj-offline-attendance';
export const MAX_OFFLINE_PHOTO_BYTES = 200 * 1024;

type AesKeyRecord = Readonly<{
  schemaVersion: 1;
  keyRef: string;
  key: CryptoKey;
  ownerIv: ArrayBuffer;
  ownerCiphertext: ArrayBuffer;
}>;

type EncryptedAttendanceRecord = Readonly<{
  schemaVersion: 1;
  id: string;
  keyRef: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}>;

type SyncLease = Readonly<{ entryId: string; token: string; expiresAt: number }>;

export type OfflineAttendanceCapture = Readonly<{
  type: AttendanceType;
  clientRecordedAt: string;
  photo: Blob;
  location: Readonly<{ latitude: number; longitude: number; accuracyMeters: number }>;
}>;

export type PendingOfflineAttendancePayload = Readonly<{
  schemaVersion: 1;
  kind: 'pending';
  idempotencyKey: string;
  type: AttendanceType;
  clientRecordedAt: string;
  networkStatus: 'OFFLINE';
  validationMethod: 'OFFLINE';
  location: Readonly<{ latitude: number; longitude: number; accuracyMeters: number }>;
  liveness: Readonly<{ faceDetected: false; passed: false }>;
  photoType: string;
  photoSizeBytes: number;
  photoBase64: string;
  draft: AttendanceAttemptDraft | null;
}>;

export type AcknowledgedOfflineAttendancePayload = Readonly<{
  schemaVersion: 1;
  kind: 'receipt';
  receipt: AttendanceReceipt;
}>;

export type OfflineAttendancePayload =
  PendingOfflineAttendancePayload | AcknowledgedOfflineAttendancePayload;

export type DecryptedOfflineAttendanceEntry = Readonly<{
  id: string;
  keyRef: string;
  payload: OfflineAttendancePayload;
  photo: Blob | null;
}>;

/** No employee identifier, capture details, API body, or image bytes are stored outside ciphertext. */
export interface OfflineQueueStorage {
  readKeys(): Promise<AesKeyRecord[]>;
  writeKey(record: AesKeyRecord): Promise<void>;
  readEntries(): Promise<EncryptedAttendanceRecord[]>;
  writeEntry(record: EncryptedAttendanceRecord): Promise<void>;
  acquireLease(entryId: string, token: string, now: number, ttlMs: number): Promise<boolean>;
  releaseLease(entryId: string, token: string): Promise<void>;
  close?(): void;
}

export class OfflineQueueError extends Error {
  constructor(
    readonly code:
      | 'UNAVAILABLE'
      | 'ENCRYPTION_UNAVAILABLE'
      | 'QUOTA'
      | 'CORRUPT'
      | 'INVALID_CAPTURE'
      | 'OWNER_REQUIRED'
      | 'ACK_INVALID',
    message = 'Antrean offline belum dapat diproses.',
  ) {
    super(message);
    this.name = 'OfflineQueueError';
  }
}

type CryptoPort = Pick<Crypto, 'subtle' | 'getRandomValues' | 'randomUUID'>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const LEASE_TTL_MS = 5 * 60 * 1000;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: unknown): value is string {
  return isApiDateTime(value);
}

function assertCrypto(cryptoPort: CryptoPort): void {
  if (!cryptoPort?.subtle || typeof cryptoPort.getRandomValues !== 'function') {
    throw new OfflineQueueError('ENCRYPTION_UNAVAILABLE');
  }
}

function wrapStorageError(error: unknown): OfflineQueueError {
  if (error instanceof OfflineQueueError) return error;
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
  if (name === 'QuotaExceededError') return new OfflineQueueError('QUOTA');
  if (name === 'DataCloneError' || name === 'NotSupportedError') {
    return new OfflineQueueError('ENCRYPTION_UNAVAILABLE');
  }
  return new OfflineQueueError('UNAVAILABLE');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8_192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new OfflineQueueError('CORRUPT');
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function keyIsValid(value: unknown): value is CryptoKey {
  if (!isRecord(value) || value.type !== 'secret' || value.extractable !== false) return false;
  if (!isRecord(value.algorithm) || value.algorithm.name !== 'AES-GCM') return false;
  return (
    Array.isArray(value.usages) &&
    value.usages.includes('encrypt') &&
    value.usages.includes('decrypt')
  );
}

function validatePayload(value: unknown): asserts value is OfflineAttendancePayload {
  if (
    isRecord(value) &&
    value.schemaVersion === OFFLINE_QUEUE_SCHEMA_VERSION &&
    value.kind === 'receipt'
  ) {
    if (
      !isRecord(value.receipt) ||
      (value.receipt.type !== 'CHECK_IN' && value.receipt.type !== 'CHECK_OUT') ||
      !isReceiptFor(value.receipt, value.receipt.type) ||
      value.receipt.validationStatus === 'VALID'
    ) {
      throw new OfflineQueueError('CORRUPT');
    }
    return;
  }

  if (
    !isRecord(value) ||
    value.schemaVersion !== OFFLINE_QUEUE_SCHEMA_VERSION ||
    value.kind !== 'pending' ||
    !isUuid(value.idempotencyKey) ||
    (value.type !== 'CHECK_IN' && value.type !== 'CHECK_OUT') ||
    !isIsoInstant(value.clientRecordedAt) ||
    value.networkStatus !== 'OFFLINE' ||
    value.validationMethod !== 'OFFLINE' ||
    !isRecord(value.location) ||
    typeof value.location.latitude !== 'number' ||
    !Number.isFinite(value.location.latitude) ||
    value.location.latitude < -90 ||
    value.location.latitude > 90 ||
    typeof value.location.longitude !== 'number' ||
    !Number.isFinite(value.location.longitude) ||
    value.location.longitude < -180 ||
    value.location.longitude > 180 ||
    typeof value.location.accuracyMeters !== 'number' ||
    !Number.isFinite(value.location.accuracyMeters) ||
    value.location.accuracyMeters <= 0 ||
    !isRecord(value.liveness) ||
    value.liveness.faceDetected !== false ||
    value.liveness.passed !== false ||
    typeof value.photoType !== 'string' ||
    !ALLOWED_IMAGE_TYPES.has(value.photoType) ||
    typeof value.photoSizeBytes !== 'number' ||
    !Number.isInteger(value.photoSizeBytes) ||
    value.photoSizeBytes < 1 ||
    value.photoSizeBytes > MAX_OFFLINE_PHOTO_BYTES ||
    typeof value.photoBase64 !== 'string'
  ) {
    throw new OfflineQueueError('CORRUPT');
  }

  const photoBytes = base64ToBytes(value.photoBase64);
  if (photoBytes.byteLength !== value.photoSizeBytes) throw new OfflineQueueError('CORRUPT');

  if (value.draft !== null) {
    if (
      !isRecord(value.draft) ||
      !isRecord(value.draft.body) ||
      typeof value.draft.serializedBody !== 'string'
    ) {
      throw new OfflineQueueError('CORRUPT');
    }
    let body: unknown;
    try {
      body = JSON.parse(value.draft.serializedBody);
    } catch {
      throw new OfflineQueueError('CORRUPT');
    }
    if (
      JSON.stringify(body) !== value.draft.serializedBody ||
      JSON.stringify(body) !== JSON.stringify(value.draft.body) ||
      !isRecord(body) ||
      body.idempotencyKey !== value.idempotencyKey ||
      body.type !== value.type ||
      body.clientRecordedAt !== value.clientRecordedAt ||
      body.networkStatus !== 'OFFLINE' ||
      body.validationMethod !== 'OFFLINE' ||
      body.proofCode !== null ||
      !isRecord(body.liveness) ||
      body.liveness.faceDetected !== false ||
      body.liveness.passed !== false ||
      !isRecord(body.selfie) ||
      !isUuid(body.selfie.blob)
    ) {
      throw new OfflineQueueError('CORRUPT');
    }
  }
}

function validateCapture(employeeId: string, capture: OfflineAttendanceCapture): void {
  if (!isUuid(employeeId)) throw new OfflineQueueError('OWNER_REQUIRED');
  if (
    (capture.type !== 'CHECK_IN' && capture.type !== 'CHECK_OUT') ||
    !isIsoInstant(capture.clientRecordedAt) ||
    !(capture.photo instanceof Blob) ||
    capture.photo.size < 1 ||
    capture.photo.size > MAX_OFFLINE_PHOTO_BYTES ||
    !ALLOWED_IMAGE_TYPES.has(capture.photo.type) ||
    !Number.isFinite(capture.location.latitude) ||
    capture.location.latitude < -90 ||
    capture.location.latitude > 90 ||
    !Number.isFinite(capture.location.longitude) ||
    capture.location.longitude < -180 ||
    capture.location.longitude > 180 ||
    !Number.isFinite(capture.location.accuracyMeters) ||
    capture.location.accuracyMeters <= 0
  ) {
    throw new OfflineQueueError('INVALID_CAPTURE');
  }
}

function additionalData(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

function randomIv(cryptoPort: CryptoPort): Uint8Array {
  return cryptoPort.getRandomValues(new Uint8Array(12));
}

function toArrayBuffer(value: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value.slice(0);
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function encryptText(
  key: CryptoKey,
  value: string,
  cryptoPort: CryptoPort,
  aad: string,
): Promise<Readonly<{ iv: ArrayBuffer; ciphertext: ArrayBuffer }>> {
  const iv = randomIv(cryptoPort);
  const ciphertext = await cryptoPort.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(additionalData(aad)),
      tagLength: 128,
    },
    key,
    toArrayBuffer(new TextEncoder().encode(value)),
  );
  return { iv: toArrayBuffer(iv), ciphertext };
}

async function decryptText(
  key: CryptoKey,
  iv: ArrayBuffer,
  ciphertext: ArrayBuffer,
  cryptoPort: CryptoPort,
  aad: string,
): Promise<string> {
  try {
    const plaintext = await cryptoPort.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: toArrayBuffer(additionalData(aad)),
        tagLength: 128,
      },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new OfflineQueueError('CORRUPT');
  }
}

function keyAad(keyRef: string): string {
  return `offline-attendance-key:v${OFFLINE_QUEUE_SCHEMA_VERSION}:${keyRef}`;
}

function entryAad(id: string, keyRef: string): string {
  return `offline-attendance-entry:v${OFFLINE_QUEUE_SCHEMA_VERSION}:${id}:${keyRef}`;
}

function validateKeyRecord(value: unknown): asserts value is AesKeyRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== OFFLINE_QUEUE_SCHEMA_VERSION ||
    !isUuid(value.keyRef) ||
    !keyIsValid(value.key) ||
    !(value.ownerIv instanceof ArrayBuffer) ||
    !(value.ownerCiphertext instanceof ArrayBuffer)
  ) {
    throw new OfflineQueueError('CORRUPT');
  }
}

function validateEncryptedRecord(value: unknown): asserts value is EncryptedAttendanceRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== OFFLINE_QUEUE_SCHEMA_VERSION ||
    !isUuid(value.id) ||
    !isUuid(value.keyRef) ||
    !(value.iv instanceof ArrayBuffer) ||
    value.iv.byteLength !== 12 ||
    !(value.ciphertext instanceof ArrayBuffer) ||
    value.ciphertext.byteLength < 16
  ) {
    throw new OfflineQueueError('CORRUPT');
  }
}

function isReceiptFor(value: unknown, expectedType: AttendanceType): value is AttendanceReceipt {
  const requiredKeys = ['attemptId', 'state', 'type', 'receivedAt', 'replayed'];
  const allowedKeys = [...requiredKeys, 'attendanceId', 'validationStatus'];
  return (
    isRecord(value) &&
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowedKeys.includes(key)) &&
    isUuid(value.attemptId) &&
    typeof value.state === 'string' &&
    (API_ATTENDANCE_ATTEMPT_STATES as readonly string[]).includes(value.state) &&
    (value.type === 'CHECK_IN' || value.type === 'CHECK_OUT') &&
    value.type === expectedType &&
    isIsoInstant(value.receivedAt) &&
    typeof value.replayed === 'boolean' &&
    (!Object.hasOwn(value, 'attendanceId') || isUuid(value.attendanceId)) &&
    (!Object.hasOwn(value, 'validationStatus') ||
      (typeof value.validationStatus === 'string' &&
        (API_ATTENDANCE_VALIDATION_STATUSES as readonly string[]).includes(value.validationStatus)))
  );
}

export class OfflineAttendanceQueue {
  constructor(
    private readonly storage: OfflineQueueStorage = new IndexedDbQueueStorage(),
    private readonly cryptoPort: CryptoPort = globalThis.crypto,
  ) {}

  private async keysForOwner(employeeId: string, create: boolean): Promise<AesKeyRecord[]> {
    if (!isUuid(employeeId)) throw new OfflineQueueError('OWNER_REQUIRED');
    assertCrypto(this.cryptoPort);

    const keys = await this.storage.readKeys();
    const matches: AesKeyRecord[] = [];
    for (const record of keys) {
      validateKeyRecord(record);
      const owner = await decryptText(
        record.key,
        record.ownerIv,
        record.ownerCiphertext,
        this.cryptoPort,
        keyAad(record.keyRef),
      );
      if (!isUuid(owner)) throw new OfflineQueueError('CORRUPT');
      if (owner === employeeId) matches.push(record);
    }

    if (!matches.length && create) {
      const keyRef = this.cryptoPort.randomUUID();
      const key = await this.cryptoPort.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const owner = await encryptText(key, employeeId, this.cryptoPort, keyAad(keyRef));
      const record: AesKeyRecord = {
        schemaVersion: OFFLINE_QUEUE_SCHEMA_VERSION,
        keyRef,
        key,
        ownerIv: owner.iv,
        ownerCiphertext: owner.ciphertext,
      };
      await this.storage.writeKey(record);
      matches.push(record);
    }
    return matches;
  }

  async enqueue(employeeId: string, capture: OfflineAttendanceCapture): Promise<string> {
    try {
      validateCapture(employeeId, capture);
      const keys = await this.keysForOwner(employeeId, true);
      const keyRecord = keys[0];
      if (!keyRecord) throw new OfflineQueueError('CORRUPT');

      const photoBytes = new Uint8Array(await capture.photo.arrayBuffer());
      const payload: OfflineAttendancePayload = {
        schemaVersion: OFFLINE_QUEUE_SCHEMA_VERSION,
        kind: 'pending',
        idempotencyKey: this.cryptoPort.randomUUID(),
        type: capture.type,
        clientRecordedAt: capture.clientRecordedAt,
        networkStatus: 'OFFLINE',
        validationMethod: 'OFFLINE',
        location: {
          latitude: Number(capture.location.latitude.toFixed(6)),
          longitude: Number(capture.location.longitude.toFixed(6)),
          accuracyMeters: Number(capture.location.accuracyMeters.toFixed(2)),
        },
        liveness: { faceDetected: false, passed: false },
        photoType: capture.photo.type,
        photoSizeBytes: capture.photo.size,
        photoBase64: bytesToBase64(photoBytes),
        draft: null,
      };
      validatePayload(payload);

      const id = this.cryptoPort.randomUUID();
      const encrypted = await encryptText(
        keyRecord.key,
        JSON.stringify(payload),
        this.cryptoPort,
        entryAad(id, keyRecord.keyRef),
      );
      await this.storage.writeEntry({
        schemaVersion: OFFLINE_QUEUE_SCHEMA_VERSION,
        id,
        keyRef: keyRecord.keyRef,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
      });
      return id;
    } catch (error) {
      throw wrapStorageError(error);
    }
  }

  async list(
    employeeId: string,
    includePhotos = false,
  ): Promise<DecryptedOfflineAttendanceEntry[]> {
    try {
      const ownerKeys = await this.keysForOwner(employeeId, false);
      if (!ownerKeys.length) return [];
      const keysByRef = new Map(ownerKeys.map((record) => [record.keyRef, record]));
      const records = await this.storage.readEntries();
      const result: DecryptedOfflineAttendanceEntry[] = [];

      for (const record of records) {
        const keyRecord = keysByRef.get(record.keyRef);
        if (!keyRecord) continue;
        validateEncryptedRecord(record);
        const plaintext = await decryptText(
          keyRecord.key,
          record.iv,
          record.ciphertext,
          this.cryptoPort,
          entryAad(record.id, record.keyRef),
        );
        let payload: unknown;
        try {
          payload = JSON.parse(plaintext);
        } catch {
          throw new OfflineQueueError('CORRUPT');
        }
        validatePayload(payload);
        result.push({
          id: record.id,
          keyRef: record.keyRef,
          payload,
          photo:
            includePhotos && payload.kind === 'pending'
              ? new Blob([toArrayBuffer(base64ToBytes(payload.photoBase64))], {
                  type: payload.photoType,
                })
              : null,
        });
      }
      return result.sort((left, right) => {
        const leftTime =
          left.payload.kind === 'pending'
            ? left.payload.clientRecordedAt
            : left.payload.receipt.receivedAt;
        const rightTime =
          right.payload.kind === 'pending'
            ? right.payload.clientRecordedAt
            : right.payload.receipt.receivedAt;
        return leftTime.localeCompare(rightTime);
      });
    } catch (error) {
      throw wrapStorageError(error);
    }
  }

  async get(employeeId: string, id: string): Promise<DecryptedOfflineAttendanceEntry | null> {
    try {
      if (!isUuid(id)) throw new OfflineQueueError('CORRUPT');
      const ownerKeys = await this.keysForOwner(employeeId, false);
      if (!ownerKeys.length) return null;
      const record = (await this.storage.readEntries()).find((candidate) => candidate.id === id);
      if (!record) return null;
      validateEncryptedRecord(record);
      const keyRecord = ownerKeys.find((candidate) => candidate.keyRef === record.keyRef);
      if (!keyRecord) return null;
      const plaintext = await decryptText(
        keyRecord.key,
        record.iv,
        record.ciphertext,
        this.cryptoPort,
        entryAad(record.id, record.keyRef),
      );
      let value: unknown;
      try {
        value = JSON.parse(plaintext);
      } catch {
        throw new OfflineQueueError('CORRUPT');
      }
      validatePayload(value);
      return {
        id: record.id,
        keyRef: record.keyRef,
        payload: value,
        photo:
          value.kind === 'pending'
            ? new Blob([toArrayBuffer(base64ToBytes(value.photoBase64))], {
                type: value.photoType,
              })
            : null,
      };
    } catch (error) {
      throw wrapStorageError(error);
    }
  }

  async saveDraft(employeeId: string, id: string, draft: AttendanceAttemptDraft): Promise<void> {
    try {
      const entries = await this.list(employeeId);
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry || entry.payload.kind !== 'pending') {
        throw new OfflineQueueError('OWNER_REQUIRED');
      }
      const ownerKeys = await this.keysForOwner(employeeId, false);
      const encryptedRecords = await this.storage.readEntries();
      const persisted = encryptedRecords.find((record) => record.id === id);
      const persistedKey = ownerKeys.find((candidate) => candidate.keyRef === entry.keyRef);
      if (
        !persisted ||
        persisted.keyRef !== entry.keyRef ||
        !persistedKey ||
        !this.draftMatches(entry.payload, draft)
      ) {
        throw new OfflineQueueError('CORRUPT');
      }

      const payload: PendingOfflineAttendancePayload = { ...entry.payload, draft };
      validatePayload(payload);
      const encrypted = await encryptText(
        persistedKey.key,
        JSON.stringify(payload),
        this.cryptoPort,
        entryAad(id, persistedKey.keyRef),
      );
      await this.storage.writeEntry({
        schemaVersion: OFFLINE_QUEUE_SCHEMA_VERSION,
        id,
        keyRef: persistedKey.keyRef,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
      });
    } catch (error) {
      throw wrapStorageError(error);
    }
  }

  private draftMatches(payload: OfflineAttendancePayload, draft: AttendanceAttemptDraft): boolean {
    if (payload.kind !== 'pending') return false;
    return (
      draft.body.idempotencyKey === payload.idempotencyKey &&
      draft.body.type === payload.type &&
      draft.body.clientRecordedAt === payload.clientRecordedAt &&
      draft.body.networkStatus === 'OFFLINE' &&
      draft.body.validationMethod === 'OFFLINE' &&
      JSON.stringify(draft.body.location) === JSON.stringify(payload.location) &&
      draft.body.liveness.faceDetected === false &&
      draft.body.liveness.passed === false &&
      draft.body.proofCode === null
    );
  }

  async acknowledge(employeeId: string, id: string, receipt: AttendanceReceipt): Promise<void> {
    try {
      const entries = await this.list(employeeId);
      const entry = entries.find((candidate) => candidate.id === id);
      if (
        !entry ||
        entry.payload.kind !== 'pending' ||
        !isReceiptFor(receipt, entry.payload.type) ||
        receipt.validationStatus === 'VALID'
      ) {
        throw new OfflineQueueError('ACK_INVALID');
      }
      const keyRecord = (await this.keysForOwner(employeeId, false)).find(
        (candidate) => candidate.keyRef === entry.keyRef,
      );
      if (!keyRecord) throw new OfflineQueueError('OWNER_REQUIRED');

      // Retain only the authoritative server receipt; discard photo, GPS, client time, and body.
      const tombstone: AcknowledgedOfflineAttendancePayload = {
        schemaVersion: OFFLINE_QUEUE_SCHEMA_VERSION,
        kind: 'receipt',
        receipt,
      };
      const encrypted = await encryptText(
        keyRecord.key,
        JSON.stringify(tombstone),
        this.cryptoPort,
        entryAad(id, keyRecord.keyRef),
      );
      await this.storage.writeEntry({
        schemaVersion: OFFLINE_QUEUE_SCHEMA_VERSION,
        id,
        keyRef: keyRecord.keyRef,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
      });
    } catch (error) {
      throw wrapStorageError(error);
    }
  }

  async acquireSyncLease(id: string): Promise<string | null> {
    try {
      if (!isUuid(id)) throw new OfflineQueueError('CORRUPT');
      const token = this.cryptoPort.randomUUID();
      const acquired = await this.storage.acquireLease(id, token, Date.now(), LEASE_TTL_MS);
      return acquired ? token : null;
    } catch (error) {
      throw wrapStorageError(error);
    }
  }

  async releaseSyncLease(id: string, token: string): Promise<void> {
    try {
      await this.storage.releaseLease(id, token);
    } catch (error) {
      throw wrapStorageError(error);
    }
  }

  close(): void {
    this.storage.close?.();
  }
}

/** IndexedDB stores only opaque routing fields, ciphertext, IVs, and a non-extractable CryptoKey. */
export class IndexedDbQueueStorage implements OfflineQueueStorage {
  private database: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {
    if (!factory) throw new OfflineQueueError('UNAVAILABLE');
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(OFFLINE_QUEUE_DATABASE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('keys'))
          db.createObjectStore('keys', { keyPath: 'keyRef' });
        if (!db.objectStoreNames.contains('entries')) {
          db.createObjectStore('entries', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('leases')) {
          db.createObjectStore('leases', { keyPath: 'entryId' });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new OfflineQueueError('UNAVAILABLE'));
      request.onblocked = () => reject(new OfflineQueueError('UNAVAILABLE'));
    }).catch((error: unknown) => {
      this.database = null;
      throw error;
    });
    return this.database;
  }

  private async readAll<T>(storeName: string): Promise<T[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error ?? new OfflineQueueError('UNAVAILABLE'));
      transaction.onabort = () => reject(transaction.error ?? new OfflineQueueError('UNAVAILABLE'));
    });
  }

  private async put(storeName: string, value: unknown): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new OfflineQueueError('UNAVAILABLE'));
      transaction.onabort = () => reject(transaction.error ?? new OfflineQueueError('UNAVAILABLE'));
    });
  }

  readKeys(): Promise<AesKeyRecord[]> {
    return this.readAll('keys');
  }

  writeKey(record: AesKeyRecord): Promise<void> {
    return this.put('keys', record);
  }

  readEntries(): Promise<EncryptedAttendanceRecord[]> {
    return this.readAll('entries');
  }

  writeEntry(record: EncryptedAttendanceRecord): Promise<void> {
    return this.put('entries', record);
  }

  async acquireLease(entryId: string, token: string, now: number, ttlMs: number): Promise<boolean> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('leases', 'readwrite');
      const store = transaction.objectStore('leases');
      const request = store.get(entryId);
      let acquired = false;
      request.onsuccess = () => {
        const current = request.result as SyncLease | undefined;
        if (!current || current.expiresAt <= now) {
          store.put({ entryId, token, expiresAt: now + ttlMs } satisfies SyncLease);
          acquired = true;
        }
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve(acquired);
      transaction.onerror = () => reject(transaction.error ?? new OfflineQueueError('UNAVAILABLE'));
      transaction.onabort = () => reject(transaction.error ?? new OfflineQueueError('UNAVAILABLE'));
    });
  }

  async releaseLease(entryId: string, token: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('leases', 'readwrite');
      const store = transaction.objectStore('leases');
      const request = store.get(entryId);
      request.onsuccess = () => {
        const current = request.result as SyncLease | undefined;
        if (current?.token === token) store.delete(entryId);
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new OfflineQueueError('UNAVAILABLE'));
      transaction.onabort = () => reject(transaction.error ?? new OfflineQueueError('UNAVAILABLE'));
    });
  }

  close(): void {
    void this.database?.then((db) => db.close());
    this.database = null;
  }
}

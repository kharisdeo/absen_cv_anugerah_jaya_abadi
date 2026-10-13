import { randomUUID } from 'node:crypto';

import { RequestStatus, RequestType, UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../../errors/app-error.js';
import type { AuthPrincipal } from '../auth/contracts.js';
import { assertRequestStatusTransition } from '../state-machine/index.js';
import {
  DOCTOR_NOTE_CONTENT_TYPES,
  DOCTOR_NOTE_READ_URL_TTL_SECONDS,
  MAX_DOCTOR_NOTE_BYTES,
  type DoctorNoteContentType,
  type PrivateRequestAttachmentStorage,
} from './private-request-attachment-storage.js';

export const EMPLOYEE_REQUEST_TYPES = [
  RequestType.LEAVE,
  RequestType.SICK,
  RequestType.ANNUAL_LEAVE,
  RequestType.OVERTIME,
] as const;
export type EmployeeRequestType = (typeof EMPLOYEE_REQUEST_TYPES)[number];
export type RequestDecision = typeof RequestStatus.APPROVED | typeof RequestStatus.REJECTED;

export type DoctorNoteInput = Readonly<{
  contentType: DoctorNoteContentType;
  dataBase64: string;
}>;

export type AttendanceRequestCreateInput = Readonly<{
  requestType: EmployeeRequestType;
  startDate: string;
  endDate: string;
  reason: string;
  requestedOvertimeMinutes?: number;
  doctorNote?: DoctorNoteInput;
}>;

export type AttendanceRequestRecord = Readonly<{
  id: string;
  employeeId: string;
  employeeFullName: string;
  requestType: EmployeeRequestType;
  startDate: Date;
  endDate: Date;
  reason: string;
  attachmentObjectKey: string | null;
  requestedOvertimeMinutes: number | null;
  status: RequestStatus;
  approverUserAccountId: string | null;
  approverRole: UserRole | null;
  decisionAt: Date | null;
  decisionNote: string | null;
  requestedAt: Date;
}>;

export type AttendanceRequestDto = Readonly<{
  id: string;
  employee: Readonly<{ id: string; fullName: string }>;
  requestType: EmployeeRequestType;
  startDate: string;
  endDate: string;
  reason: string;
  status: RequestStatus;
  requestedAt: string;
  decisionAt: string | null;
  decisionNote: string | null;
  hasAttachment: boolean;
  requestedOvertimeMinutes: number | null;
  approvedOvertimeMinutes: number;
}>;

export type AttendanceRequestFilter = Readonly<{
  requestType?: EmployeeRequestType;
  status?: RequestStatus;
  page?: number;
  pageSize?: number;
}>;

export type AttendanceRequestPage = Readonly<{
  items: readonly AttendanceRequestDto[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

export type AttendanceRequestActor = Readonly<{
  userAccountId: string;
  role: UserRole;
  employeeId: string | null;
}>;

export interface AttendanceRequestRepository {
  create(
    input: Readonly<{
      id: string;
      actor: AttendanceRequestActor;
      requestType: EmployeeRequestType;
      startDate: Date;
      endDate: Date;
      reason: string;
      attachmentObjectKey: string | null;
      requestedOvertimeMinutes: number | null;
      requestId: string;
    }>,
  ): Promise<AttendanceRequestRecord>;
  list(
    input: Readonly<{
      actor: AttendanceRequestActor;
      requestType?: EmployeeRequestType;
      status?: RequestStatus;
      skip: number;
      take: number;
    }>,
  ): Promise<Readonly<{ items: readonly AttendanceRequestRecord[]; hasNextPage: boolean }>>;
  findAccessible(
    input: Readonly<{
      actor: AttendanceRequestActor;
      requestId: string;
    }>,
  ): Promise<AttendanceRequestRecord | null>;
  decide(
    input: Readonly<{
      actor: AttendanceRequestActor;
      requestId: string;
      decision: RequestDecision;
      decisionNote: string;
      decidedAt: Date;
      auditRequestId: string;
    }>,
  ): Promise<AttendanceRequestRecord>;
}

function invalidInput(message = 'Data pengajuan tidak valid.'): AppError {
  return new AppError(400, 'INVALID_ATTENDANCE_REQUEST', message);
}

function notFound(): AppError {
  return new AppError(404, 'ATTENDANCE_REQUEST_NOT_FOUND', 'Pengajuan tidak ditemukan.');
}

function forbidden(): AppError {
  return new AppError(403, 'FORBIDDEN', 'Anda tidak memiliki akses ke pengajuan ini.');
}

function asActor(principal: AuthPrincipal): AttendanceRequestActor {
  return {
    userAccountId: principal.userAccountId,
    role: principal.role,
    employeeId: principal.employeeId,
  };
}

function parseDateOnly(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw invalidInput(`${field} harus berformat YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw invalidInput(`${field} bukan tanggal kalender yang valid.`);
  }
  return date;
}

function normalizedReason(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 1_000 ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || (code >= 11 && code <= 31) || code === 127;
    })
  ) {
    throw invalidInput('Alasan wajib diisi dan maksimal 1.000 karakter.');
  }
  return normalized;
}

function decodeDoctorNote(note: DoctorNoteInput): Uint8Array {
  if (!(DOCTOR_NOTE_CONTENT_TYPES as readonly string[]).includes(note.contentType)) {
    throw invalidInput('Surat dokter harus berupa JPEG, PNG, atau WebP.');
  }
  if (
    note.dataBase64.length === 0 ||
    note.dataBase64.length > Math.ceil((MAX_DOCTOR_NOTE_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(note.dataBase64)
  ) {
    throw invalidInput('Isi surat dokter tidak valid atau terlalu besar.');
  }
  const bytes = Buffer.from(note.dataBase64, 'base64');
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_DOCTOR_NOTE_BYTES) {
    throw invalidInput('Ukuran surat dokter maksimal 5 MiB.');
  }
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  const isWebp =
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  const signatureMatches =
    (note.contentType === 'image/jpeg' && isJpeg) ||
    (note.contentType === 'image/png' && isPng) ||
    (note.contentType === 'image/webp' && isWebp);
  if (!signatureMatches || bytes.toString('base64') !== note.dataBase64) {
    throw invalidInput('Format surat dokter tidak sesuai dengan isi file.');
  }
  return bytes;
}

function normalizeDecisionNote(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 500 ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || (code >= 11 && code <= 31) || code === 127;
    })
  ) {
    throw invalidInput('Catatan keputusan wajib diisi dan maksimal 500 karakter.');
  }
  return normalized;
}

function toDto(row: AttendanceRequestRecord): AttendanceRequestDto {
  return {
    id: row.id,
    employee: { id: row.employeeId, fullName: row.employeeFullName },
    requestType: row.requestType,
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
    reason: row.reason,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    decisionAt: row.decisionAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    hasAttachment: row.attachmentObjectKey !== null,
    requestedOvertimeMinutes: row.requestedOvertimeMinutes,
    approvedOvertimeMinutes:
      row.requestType === RequestType.OVERTIME &&
      row.status === RequestStatus.APPROVED &&
      row.approverRole === UserRole.ADMIN
        ? (row.requestedOvertimeMinutes ?? 0)
        : 0,
  };
}

function normalizePage(filter: AttendanceRequestFilter) {
  const page = filter.page ?? 1;
  const pageSize = filter.pageSize ?? 25;
  if (!Number.isInteger(page) || page < 1 || page > 10_000)
    throw invalidInput('Halaman tidak valid.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw invalidInput('Ukuran halaman harus 1 sampai 50.');
  }
  return { page, pageSize };
}

export class AttendanceRequestService {
  constructor(
    private readonly repository: AttendanceRequestRepository,
    private readonly attachments: PrivateRequestAttachmentStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    principal: AuthPrincipal,
    input: AttendanceRequestCreateInput,
    context: Readonly<{ requestId: string }>,
  ): Promise<AttendanceRequestDto> {
    if (principal.role !== UserRole.EMPLOYEE || !principal.employeeId) throw forbidden();
    if (!(EMPLOYEE_REQUEST_TYPES as readonly RequestType[]).includes(input.requestType)) {
      throw invalidInput('Jenis pengajuan tidak didukung oleh alur BE-021.');
    }
    const startDate = parseDateOnly(input.startDate, 'startDate');
    const endDate = parseDateOnly(input.endDate, 'endDate');
    if (endDate < startDate) throw invalidInput('endDate tidak boleh sebelum startDate.');
    const reason = normalizedReason(input.reason);
    const isOvertime = input.requestType === RequestType.OVERTIME;
    if (isOvertime) {
      if (
        !Number.isInteger(input.requestedOvertimeMinutes) ||
        (input.requestedOvertimeMinutes ?? 0) < 1 ||
        (input.requestedOvertimeMinutes ?? 0) > 2_147_483_647
      ) {
        throw invalidInput('Durasi lembur harus berupa bilangan bulat positif.');
      }
    } else if (input.requestedOvertimeMinutes !== undefined) {
      throw invalidInput('Durasi lembur hanya berlaku untuk pengajuan lembur.');
    }

    if (input.requestType === RequestType.SICK && !input.doctorNote) {
      throw invalidInput('Lampiran surat dokter wajib untuk pengajuan sakit.');
    }
    if (input.requestType !== RequestType.SICK && input.doctorNote) {
      throw invalidInput('Lampiran surat dokter hanya berlaku untuk pengajuan sakit.');
    }

    const bytes = input.doctorNote ? decodeDoctorNote(input.doctorNote) : null;
    const id = randomUUID();
    const objectKey = bytes ? `attendance-requests/doctor-notes/${randomUUID()}` : null;
    if (bytes && objectKey && input.doctorNote) {
      await this.attachments.putDoctorNote({
        objectKey,
        contentType: input.doctorNote.contentType,
        bytes,
      });
    }

    try {
      const row = await this.repository.create({
        id,
        actor: asActor(principal),
        requestType: input.requestType,
        startDate,
        endDate,
        reason,
        attachmentObjectKey: objectKey,
        requestedOvertimeMinutes: input.requestedOvertimeMinutes ?? null,
        requestId: context.requestId,
      });
      return toDto(row);
    } catch (error) {
      if (objectKey) await this.attachments.deleteObject(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async list(
    principal: AuthPrincipal,
    filter: AttendanceRequestFilter = {},
  ): Promise<AttendanceRequestPage> {
    const { page, pageSize } = normalizePage(filter);
    const result = await this.repository.list({
      actor: asActor(principal),
      ...(filter.requestType === undefined ? {} : { requestType: filter.requestType }),
      ...(filter.status === undefined ? {} : { status: filter.status }),
      skip: (page - 1) * pageSize,
      take: pageSize + 1,
    });
    return {
      items: result.items.slice(0, pageSize).map(toDto),
      page,
      pageSize,
      hasNextPage: result.hasNextPage || result.items.length > pageSize,
    };
  }

  async detail(principal: AuthPrincipal, requestId: string): Promise<AttendanceRequestDto> {
    const row = await this.repository.findAccessible({ actor: asActor(principal), requestId });
    if (!row) throw notFound();
    return toDto(row);
  }

  async createAttachmentReadUrl(
    principal: AuthPrincipal,
    requestId: string,
  ): Promise<Readonly<{ url: string; expiresAt: string }>> {
    const row = await this.repository.findAccessible({ actor: asActor(principal), requestId });
    if (!row?.attachmentObjectKey) throw notFound();
    const url = await this.attachments.createReadUrl({
      objectKey: row.attachmentObjectKey,
      expiresInSeconds: DOCTOR_NOTE_READ_URL_TTL_SECONDS,
    });
    return {
      url,
      expiresAt: new Date(
        this.now().getTime() + DOCTOR_NOTE_READ_URL_TTL_SECONDS * 1_000,
      ).toISOString(),
    };
  }

  async decide(
    principal: AuthPrincipal,
    requestId: string,
    input: Readonly<{ decision: RequestDecision; decisionNote: string }>,
    context: Readonly<{ requestId: string }>,
  ): Promise<AttendanceRequestDto> {
    if (principal.role !== UserRole.ADMIN && principal.role !== UserRole.SUPERVISOR) {
      throw forbidden();
    }
    if (input.decision === RequestStatus.APPROVED || input.decision === RequestStatus.REJECTED) {
      assertRequestStatusTransition(RequestStatus.PENDING, input.decision);
    } else {
      throw invalidInput('Keputusan pengajuan tidak valid.');
    }
    const decisionNote = normalizeDecisionNote(input.decisionNote);
    return toDto(
      await this.repository.decide({
        actor: asActor(principal),
        requestId,
        decision: input.decision,
        decisionNote,
        decidedAt: this.now(),
        auditRequestId: context.requestId,
      }),
    );
  }
}

import type {
  AttendanceRequestCreateInput,
  DoctorNoteContentType,
  DoctorNoteInput,
  EmployeeRequestType,
} from '../api/attendance-requests-api.js';

export const MAX_DOCTOR_NOTE_BYTES = 5 * 1024 * 1024;
export const DOCTOR_NOTE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const EMPLOYEE_REQUEST_TYPE_OPTIONS: readonly Readonly<{
  value: EmployeeRequestType;
  label: string;
}>[] = [
  { value: 'LEAVE', label: 'Izin' },
  { value: 'SICK', label: 'Sakit' },
  { value: 'ANNUAL_LEAVE', label: 'Cuti tahunan' },
  { value: 'OVERTIME', label: 'Lembur' },
];

export type RequestFormType = EmployeeRequestType | 'CORRECTION';

export type EmployeeRequestDraft = Readonly<{
  requestType: RequestFormType;
  startDate: string;
  endDate: string;
  reason: string;
  requestedOvertimeMinutes: string;
  doctorNoteFile: File | null;
}>;

export type EmployeeRequestDraftErrors = Readonly<
  Partial<Record<keyof EmployeeRequestDraft, string>>
>;

export type RequestSubmissionGate = (action: () => Promise<void>) => Promise<boolean>;

export class EmployeeRequestFormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeRequestFormError';
  }
}

export function emptyEmployeeRequestDraft(): EmployeeRequestDraft {
  return {
    requestType: 'LEAVE',
    startDate: '',
    endDate: '',
    reason: '',
    requestedOvertimeMinutes: '',
    doctorNoteFile: null,
  };
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function fileMetadataError(file: Pick<File, 'size' | 'type'>): string | null {
  if (!DOCTOR_NOTE_CONTENT_TYPES.includes(file.type as DoctorNoteContentType)) {
    return 'Surat dokter harus berupa JPEG, PNG, atau WebP.';
  }
  if (file.size < 1) return 'File surat dokter tidak boleh kosong.';
  if (file.size > MAX_DOCTOR_NOTE_BYTES) return 'Ukuran surat dokter maksimal 5 MiB.';
  return null;
}

export function validateEmployeeRequestDraft(
  draft: EmployeeRequestDraft,
): EmployeeRequestDraftErrors {
  const errors: Partial<Record<keyof EmployeeRequestDraft, string>> = {};
  if (
    !(EMPLOYEE_REQUEST_TYPE_OPTIONS as readonly { value: string }[]).some(
      ({ value }) => value === draft.requestType,
    )
  ) {
    errors.requestType = 'Jenis pengajuan ini belum tersedia.';
  }
  if (!isCalendarDate(draft.startDate)) errors.startDate = 'Masukkan tanggal kalender yang valid.';
  if (!isCalendarDate(draft.endDate)) errors.endDate = 'Masukkan tanggal kalender yang valid.';
  if (
    isCalendarDate(draft.startDate) &&
    isCalendarDate(draft.endDate) &&
    draft.endDate < draft.startDate
  ) {
    errors.endDate = 'Tanggal akhir tidak boleh sebelum tanggal mulai.';
  }

  const reason = draft.reason.trim();
  if (!reason) errors.reason = 'Alasan wajib diisi.';
  else if ([...reason].length > 1_000) errors.reason = 'Alasan maksimal 1.000 karakter.';
  else if (
    [...reason].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || (code >= 11 && code <= 31) || code === 127;
    })
  ) {
    errors.reason = 'Alasan mengandung karakter yang tidak didukung.';
  }

  if (draft.requestType === 'OVERTIME') {
    if (!/^\d+$/.test(draft.requestedOvertimeMinutes)) {
      errors.requestedOvertimeMinutes = 'Durasi lembur harus berupa bilangan bulat positif.';
    } else {
      const minutes = Number(draft.requestedOvertimeMinutes);
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 2_147_483_647) {
        errors.requestedOvertimeMinutes = 'Durasi lembur harus berupa bilangan bulat positif.';
      }
    }
  }

  if (draft.requestType === 'SICK') {
    if (!draft.doctorNoteFile) errors.doctorNoteFile = 'Surat dokter wajib dilampirkan.';
    else {
      const error = fileMetadataError(draft.doctorNoteFile);
      if (error) errors.doctorNoteFile = error;
    }
  } else if (draft.doctorNoteFile) {
    errors.doctorNoteFile = 'Lampiran surat dokter hanya berlaku untuk pengajuan sakit.';
  }

  return errors;
}

function matchesImageSignature(contentType: DoctorNoteContentType, bytes: Uint8Array): boolean {
  if (contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === 'image/png') {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  return (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof globalThis.btoa !== 'function') {
    throw new EmployeeRequestFormError('Browser ini belum mendukung pengiriman lampiran.');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}

async function doctorNoteInput(file: File): Promise<DoctorNoteInput> {
  const metadataError = fileMetadataError(file);
  if (metadataError) throw new EmployeeRequestFormError(metadataError);
  const contentType = file.type as DoctorNoteContentType;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (
    bytes.length !== file.size ||
    bytes.length > MAX_DOCTOR_NOTE_BYTES ||
    !matchesImageSignature(contentType, bytes)
  ) {
    throw new EmployeeRequestFormError('Isi file tidak sesuai dengan format surat dokter.');
  }
  return { contentType, dataBase64: bytesToBase64(bytes) };
}

export async function toAttendanceRequestCreateInput(
  draft: EmployeeRequestDraft,
): Promise<AttendanceRequestCreateInput> {
  const errors = validateEmployeeRequestDraft(draft);
  if (Object.keys(errors).length > 0) {
    throw new EmployeeRequestFormError('Periksa kembali data pengajuan yang wajib diisi.');
  }

  const base = {
    startDate: draft.startDate,
    endDate: draft.endDate,
    reason: draft.reason.trim(),
  };
  if (draft.requestType === 'SICK') {
    return {
      ...base,
      requestType: 'SICK',
      doctorNote: await doctorNoteInput(draft.doctorNoteFile!),
    };
  }
  if (draft.requestType === 'OVERTIME') {
    return {
      ...base,
      requestType: 'OVERTIME',
      requestedOvertimeMinutes: Number(draft.requestedOvertimeMinutes),
    };
  }
  if (draft.requestType === 'LEAVE' || draft.requestType === 'ANNUAL_LEAVE') {
    return { ...base, requestType: draft.requestType };
  }
  throw new EmployeeRequestFormError('Jenis pengajuan ini belum tersedia.');
}

export function createRequestSubmissionGate(): RequestSubmissionGate {
  let submitting = false;
  return async (action) => {
    if (submitting) return false;
    submitting = true;
    try {
      await action();
      return true;
    } finally {
      submitting = false;
    }
  };
}

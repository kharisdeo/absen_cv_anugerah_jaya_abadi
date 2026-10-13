import { readFile } from 'node:fs/promises';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SAFE_API_ERROR_MESSAGES, toUserErrorMessage } from '../src/api/error-message.js';
import {
  ATTENDANCE_VALIDATION_STATUSES,
  DAILY_ATTENDANCE_STATUSES,
  REQUEST_STATUSES,
  canTransitionAttendanceValidation,
  canTransitionRequest,
  getAttendanceValidationPresentation,
  getDailyAttendancePresentation,
} from '../src/domain/attendance-state.js';
import { Button } from '../src/components/ui/Button.js';
import { DataTable } from '../src/components/ui/DataTable.js';
import { DesignSystemExamples } from '../src/components/ui/DesignSystemExamples.js';
import { Modal } from '../src/components/ui/Modal.js';
import { StatusBadge } from '../src/components/ui/StatusBadge.js';
import { TextField } from '../src/components/ui/TextField.js';

describe('attendance status model and examples', () => {
  it('defines a separate Indonesian presentation for every backend status', () => {
    const validationLabels = ATTENDANCE_VALIDATION_STATUSES.map(
      (status) => getAttendanceValidationPresentation(status).label,
    );
    const dailyLabels = DAILY_ATTENDANCE_STATUSES.map(
      (status) => getDailyAttendancePresentation(status).label,
    );

    expect(validationLabels).toEqual([
      'Valid',
      'Perlu verifikasi',
      'Disetujui admin',
      'Ditolak',
      'Absen tertunda',
    ]);
    expect(dailyLabels).toEqual([
      'Hadir',
      'Terlambat',
      'Pulang lebih awal',
      'Belum absen pulang',
      'Menunggu verifikasi',
      'Izin',
      'Sakit',
      'Cuti',
      'Hari libur',
      'Tidak hadir',
    ]);
    expect(validationLabels).not.toContain('Tidak hadir');
    expect(validationLabels[1]).not.toBe(validationLabels[4]);
  });

  it('allows only the backend attendance-validation transitions', () => {
    const allowed: readonly (readonly [string, string])[] = [
      ['PENDING_OFFLINE', 'VALID'],
      ['PENDING_OFFLINE', 'PENDING_VERIFICATION'],
      ['PENDING_VERIFICATION', 'APPROVED'],
      ['PENDING_VERIFICATION', 'REJECTED'],
    ];

    for (const from of ATTENDANCE_VALIDATION_STATUSES) {
      for (const to of ATTENDANCE_VALIDATION_STATUSES) {
        expect(canTransitionAttendanceValidation(from, to)).toBe(
          allowed.some(([source, destination]) => source === from && destination === to),
        );
      }
    }
  });

  it('allows only the backend request transitions', () => {
    const allowed = new Set(['PENDING:APPROVED', 'PENDING:REJECTED', 'PENDING:CANCELLED']);
    for (const from of REQUEST_STATUSES) {
      for (const to of REQUEST_STATUSES) {
        expect(canTransitionRequest(from, to)).toBe(allowed.has(`${from}:${to}`));
      }
    }
  });

  it('renders every status in a runnable design-system example', () => {
    const html = renderToStaticMarkup(<DesignSystemExamples />);
    for (const label of [
      'Valid',
      'Perlu verifikasi',
      'Absen tertunda',
      'Ditolak',
      'Tidak hadir',
      'Menunggu keputusan',
      'Disetujui',
      'Dibatalkan',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Perangkat ini belum disetujui Admin');
    expect(html).toContain('Tidak dapat terhubung ke server');
    expect(html).not.toContain('SQL connection information');
    expect(html).not.toContain('Contoh informasi internal');
  });
});

describe('safe Indonesian API error mapping', () => {
  it('has a localized allowlist entry for each currently exposed backend error code', () => {
    const exposedBackendCodes = [
      'ACCOUNT_CONFLICT',
      'ACCOUNT_EMPLOYEE_LINK_CONFLICT',
      'ACCOUNT_NOT_FOUND',
      'ACCOUNT_USERNAME_CONFLICT',
      'ACTIVE_ADMIN_FLOOR',
      'ATTENDANCE_ATTEMPT_CONFLICT',
      'ATTENDANCE_ATTEMPT_RULE_REJECTED',
      'ATTENDANCE_CHECK_IN_DUPLICATE',
      'ATTENDANCE_CHECK_IN_REQUIRED',
      'ATTENDANCE_CHECKOUT_OUT_OF_ORDER',
      'ATTENDANCE_CHECKOUT_SHIFT_MISMATCH',
      'ATTENDANCE_CHECKOUT_WINDOW_EXPIRED',
      'ATTENDANCE_DEVICE_BINDING_REQUIRED',
      'ATTENDANCE_EVIDENCE_INVALID',
      'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE',
      'ATTENDANCE_NON_WORKING_DAY',
      'ATTENDANCE_REQUEST_DATE_OVERLAP',
      'ATTENDANCE_REQUEST_DECISION_CONFLICT',
      'ATTENDANCE_REQUEST_NOT_FOUND',
      'ATTENDANCE_SHIFT_AMBIGUOUS',
      'ATTENDANCE_SHIFT_NOT_ASSIGNED',
      'ATTENDANCE_STORE_SELECTION_REQUIRED',
      'ATTENDANCE_UPLOAD_EXPIRED',
      'ATTENDANCE_UPLOAD_FAILED',
      'ATTENDANCE_VERIFICATION_CONFLICT',
      'ATTENDANCE_VERIFICATION_NOT_FOUND',
      'CONSENT_POLICY_STALE',
      'CONSENT_POLICY_UNAVAILABLE',
      'CONSENT_REQUIRED',
      'CSRF_ORIGIN_NOT_CONFIGURED',
      'CSRF_ORIGIN_REJECTED',
      'CURRENT_PASSWORD_INVALID',
      'DEVICE_BINDING_NOT_FOUND',
      'DEVICE_BINDING_PENDING',
      'DEVICE_BINDING_REVOKED',
      'DEVICE_BINDING_REQUIRED',
      'DEVICE_BINDING_STATE_CONFLICT',
      'DEVICE_ENROLLMENT_UNAVAILABLE',
      'DEVICE_INFO_REQUIRED',
      'EMPLOYEE_NOT_ASSIGNED_TO_STORE',
      'EMPLOYEE_NIK_CONFLICT',
      'EMPLOYEE_NIK_USERNAME_CONFLICT',
      'EMPLOYEE_NOT_FOUND',
      'EMPLOYEE_PROFILE_REQUIRED',
      'FORBIDDEN',
      'INTERNAL_SERVER_ERROR',
      'HOLIDAY_DATE_CONFLICT',
      'HOLIDAY_NOT_FOUND',
      'INVALID_ACCOUNT_INPUT',
      'INVALID_ATTENDANCE_ATTEMPT',
      'INVALID_ATTENDANCE_REQUEST',
      'INVALID_ATTENDANCE_VALIDATION_TRANSITION',
      'INVALID_AUDIT_INPUT',
      'INVALID_CREDENTIALS',
      'INVALID_DASHBOARD_INPUT',
      'INVALID_NOTIFICATION_INPUT',
      'INVALID_DEVICE_BINDING_INPUT',
      'INVALID_EMPLOYEE_INPUT',
      'INVALID_INPUT',
      'INVALID_SYSTEM_DISRUPTION',
      'INVALID_REQUEST',
      'INVALID_REQUEST_ATTACHMENT',
      'INVALID_REQUEST_STATUS_TRANSITION',
      'INVALID_VERIFICATION_INPUT',
      'INVALID_VERIFICATION_QUERY',
      'INVALID_VERIFICATION_REASON',
      'INVALID_SELFIE_REFERENCE',
      'INVALID_SELFIE_UPLOAD_INTENT',
      'IDEMPOTENCY_KEY_REUSED',
      'INVALID_STORE_INPUT',
      'INVALID_SCHEDULE_INPUT',
      'NOT_FOUND',
      'NETWORK_ERROR',
      'PAYLOAD_TOO_LARGE',
      'PASSWORD_CHANGE_REQUIRED',
      'PASSWORD_CHANGED_CONCURRENTLY',
      'SESSION_EXPIRED',
      'STORE_NOT_FOUND',
      'STORE_INACTIVE',
      'STORE_OR_EMPLOYEE_NOT_FOUND',
      'SYSTEM_DISRUPTION_NOT_FOUND',
      'SHIFT_ASSIGNMENT_AMBIGUOUS',
      'SHIFT_ASSIGNMENT_CONFLICT',
      'SHIFT_ASSIGNMENT_HAS_ATTENDANCE',
      'SHIFT_ASSIGNMENT_NOT_FOUND',
      'SHIFT_HAS_ACTIVE_ASSIGNMENTS',
      'SHIFT_HAS_ATTENDANCE',
      'SHIFT_INACTIVE',
      'SHIFT_NOT_FOUND',
      'RATE_LIMITED',
      'REQUEST_ATTACHMENT_STORAGE_UNAVAILABLE',
      'REQUEST_REQUIRES_ADMIN',
      'REJECTION_REASON_REQUIRED',
      'REQUEST_TIMEOUT',
      'SELFIE_NOT_FOUND',
      'UNAUTHENTICATED',
      'UNSUPPORTED_MEDIA_TYPE',
      'UUID_UNAVAILABLE',
    ];

    expect(Object.keys(SAFE_API_ERROR_MESSAGES).sort()).toEqual([...exposedBackendCodes].sort());
    for (const [code, message] of Object.entries(SAFE_API_ERROR_MESSAGES)) {
      expect(toUserErrorMessage({ code, detail: 'private server detail' })).toBe(message);
      expect(message).not.toContain('private server detail');
    }
  });

  it('does not echo unknown server details, titles, request IDs, or paths', () => {
    const message = toUserErrorMessage({
      code: 'UNRECOGNIZED_PRIVATE_CODE',
      title: 'Internal Server Error',
      detail: 'postgres://private-host/db',
      requestId: 'sensitive-request-id',
      instance: '/private/route',
    });
    expect(message).toBe('Permintaan belum dapat diproses. Silakan coba lagi.');
    expect(message).not.toContain('postgres');
    expect(message).not.toContain('sensitive-request-id');
    expect(message).not.toContain('/private/route');
  });

  it('provides localized network and unavailable fallbacks', () => {
    expect(toUserErrorMessage(new TypeError('socket details'))).toContain(
      'Periksa koneksi internet',
    );
    expect(toUserErrorMessage({ status: 503, detail: 'stack trace' })).toContain(
      'Layanan sedang tidak tersedia',
    );
    expect(toUserErrorMessage({ status: 500, detail: 'stack trace' })).not.toContain('stack trace');
  });
});

describe('accessible responsive UI primitives', () => {
  it('connects the text field label, hint, and validation message', () => {
    const html = renderToStaticMarkup(
      <TextField
        id="employee-id"
        label="NIK"
        hint="Gunakan NIK dari Admin."
        error="NIK wajib diisi."
        required
      />,
    );
    expect(html).toContain('for="employee-id"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="employee-id-hint employee-id-error"');
    expect(html).toContain('role="alert"');
  });

  it('marks loading buttons and labels modal/table semantics', () => {
    const button = renderToStaticMarkup(<Button loading>Simpan</Button>);
    expect(button).toContain('aria-busy="true"');
    expect(button).toContain('disabled=""');

    const modal = renderToStaticMarkup(
      <Modal open={false} title="Konfirmasi" onOpenChange={() => undefined}>
        Isi dialog
      </Modal>,
    );
    expect(modal).toContain('<dialog');
    expect(modal).toContain('aria-labelledby=');

    const table = renderToStaticMarkup(
      <DataTable label="Daftar karyawan" columns={[]} rows={[]} getRowKey={(_, index) => index} />,
    );
    expect(table).toContain('role="region"');
    expect(table).toContain('Daftar karyawan');
    expect(table).toContain('Belum ada data untuk ditampilkan.');
  });

  it('keeps tabular content scrollable on mobile and defines reduced-motion styles', async () => {
    const css = await readFile(new URL('../src/components/ui/ui.css', import.meta.url), 'utf8');
    expect(css).toContain('.ds-table-wrap');
    expect(css).toContain('overflow-x: auto');
    expect(css).toContain('@media (max-width: 600px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('renders the state badge text independently of tone/color', () => {
    const pending = renderToStaticMarkup(
      <StatusBadge domain="validation" status="PENDING_VERIFICATION" />,
    );
    const offline = renderToStaticMarkup(
      <StatusBadge domain="validation" status="PENDING_OFFLINE" />,
    );
    expect(pending).toContain('Perlu verifikasi');
    expect(offline).toContain('Absen tertunda');
    expect(pending).not.toEqual(offline);
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type {
  AttendanceVerificationDto,
  ReviewerRequestDto,
  ReviewerRole,
} from '../src/api/attendance-review-api.js';
import type { SignedRequestAttachment } from '../src/api/attendance-review-api.js';
import { AttendanceReviewApiError } from '../src/api/attendance-review-api.js';
import { RolePage } from '../src/app/RolePage.js';
import { ROLE_NAVIGATION, getRoleRoute } from '../src/app/role-navigation.js';
import { decideDirectRouteAccess } from '../src/auth/route-policy.js';
import type { AuthUser, SessionState, UserRole } from '../src/auth/session.js';
import {
  RequestAttachmentDownload,
  RequestReviewDetail,
  requestAttachmentDownloadReducer,
} from '../src/pages/RequestReviewPage.js';
import { renderToResolvedMarkup } from './render-to-resolved-markup.js';
import {
  VerificationDetail,
  VerificationQueue,
  selfieAfterReadFailure,
  type VerificationQueueState,
} from '../src/pages/VerificationReviewPage.js';

const employeeId = '00000000-0000-4000-8000-000000000902';
const storeId = '00000000-0000-4000-8000-000000000904';
const verification: AttendanceVerificationDto = {
  attendanceId: '00000000-0000-4000-8000-000000000901',
  employee: { id: employeeId, fullName: 'Karyawan Contoh', position: 'Kasir' },
  store: { id: storeId, name: 'Toko Utama' },
  type: 'CHECK_IN',
  workDate: '2026-10-11',
  serverTime: '2026-10-11T01:00:00.000Z',
  deviceTime: '2026-10-11T00:59:00.000Z',
  dueAt: '2026-10-12T01:00:00.000Z',
  overdue: false,
  validationStatus: 'PENDING_VERIFICATION',
  method: 'GPS',
  networkStatus: 'ONLINE',
  device: { name: 'Android' },
  location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 12, distanceMeters: 5 },
  selfie: {
    url: 'https://private.example.test/photo?signature=temporary',
    expiresAt: '2027-10-11T05:00:00.000Z',
  },
  recentAttendance: [
    {
      attendanceId: '00000000-0000-4000-8000-000000000905',
      type: 'CHECK_OUT',
      workDate: '2026-10-10',
      serverTime: '2026-10-10T10:00:00.000Z',
      deviceTime: null,
      validationStatus: 'VALID',
      reason: null,
      store: { id: storeId, name: 'Toko Utama' },
    },
  ],
};
const overtimeRequest: ReviewerRequestDto = {
  id: '00000000-0000-4000-8000-000000000903',
  employee: { id: employeeId, fullName: 'Karyawan Contoh' },
  requestType: 'OVERTIME',
  startDate: '2026-10-11',
  endDate: '2026-10-11',
  reason: 'Penyelesaian pekerjaan',
  status: 'PENDING',
  requestedAt: '2026-10-11T00:00:00.000Z',
  decisionAt: null,
  decisionNote: null,
  hasAttachment: false,
  requestedOvertimeMinutes: 90,
  approvedOvertimeMinutes: 0,
};
const sickRequest: ReviewerRequestDto = {
  ...overtimeRequest,
  id: '00000000-0000-4000-8000-000000000907',
  requestType: 'SICK',
  reason: 'Perlu istirahat sesuai anjuran dokter',
  hasAttachment: true,
  requestedOvertimeMinutes: null,
  approvedOvertimeMinutes: 0,
};
const signedRequestAttachment: SignedRequestAttachment = {
  url: 'https://private.example.test/doctor-note?signature=temporary-secret',
  expiresAt: '2026-10-11T05:02:00.000Z',
};

function user(role: UserRole): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000906',
    username: 'pengguna',
    role,
    employeeId: role === 'ADMIN' ? null : employeeId,
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

function session(role: UserRole): SessionState {
  return { status: 'authenticated', user: user(role) };
}

function detail(role: ReviewerRole, item = verification) {
  return renderToStaticMarkup(
    <VerificationDetail
      onDecision={async () => undefined}
      onRefreshSelfie={async () => undefined}
      onRetry={() => undefined}
      role={role}
      state={{ status: 'loaded', item }}
      submitting={false}
    />,
  );
}

describe('FE-013 role review routes', () => {
  const routes = [
    { path: '/supervisor/verification', role: 'SUPERVISOR' as const, page: 'verifikasi' },
    { path: '/admin/verification', role: 'ADMIN' as const, page: 'verifikasi' },
    { path: '/supervisor/requests', role: 'SUPERVISOR' as const, page: 'pengajuan tim' },
    { path: '/admin/requests', role: 'ADMIN' as const, page: 'pengajuan' },
  ];

  it('mounts real review pages at all four routes and gates each route to its server role', async () => {
    for (const route of routes) {
      expect(getRoleRoute(route.path)?.role).toBe(route.role);
      expect(ROLE_NAVIGATION[route.role].some(({ to }) => to === route.path)).toBe(true);
      expect(decideDirectRouteAccess(session(route.role), route.path)).toBe('allow');
      for (const otherRole of (['EMPLOYEE', 'SUPERVISOR', 'ADMIN'] as const).filter(
        (role) => role !== route.role,
      )) {
        expect(decideDirectRouteAccess(session(otherRole), route.path)).toBe('wrong-role');
      }

      const html = await renderToResolvedMarkup(<RolePage role={route.role} route={route.path} />);
      expect(html.toLowerCase()).toContain(route.page);
      expect(html).not.toContain('Fitur ini belum tersedia');
    }
    expect(getRoleRoute('/supervisor/requests/extra')).toBeNull();
    expect(getRoleRoute('/admin/verification/extra')).toBeNull();
  });

  it('renders verification detail data, history, coordinates, map privacy notice and accessible decision controls', () => {
    const html = detail('SUPERVISOR');
    expect(html).toContain('Karyawan Contoh');
    expect(html).toContain('Waktu server asli');
    expect(html).toContain('Metode validasi');
    expect(html).toContain('Perangkat');
    expect(html).toContain('Akurasi GPS');
    expect(html).toContain('-6.200000');
    expect(html).toContain('106.800000');
    expect(html).toContain('Peta belum tersedia');
    expect(html).toContain('tidak dikirim ke layanan pihak ketiga');
    expect(html).toContain('Riwayat absensi terkait');
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('signature=temporary');
    expect(html).toContain('aria-required="true"');
    expect(html.toLowerCase()).toContain('maxlength="500"');
    expect(html).toContain('Tolak absensi');
  });

  it('shows expired selfie state with refresh, but no retry when evidence is absent', () => {
    const expired = detail('ADMIN', {
      ...verification,
      selfie: {
        url: 'https://private.example.test/expired',
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    });
    const absent = detail('ADMIN', { ...verification, selfie: null });
    expect(expired).toContain('Tautan foto kedaluwarsa');
    expect(expired).toContain('Muat ulang foto');
    expect(absent).toContain('Foto selfie tidak tersedia');
    expect(absent).not.toContain('Muat ulang foto');
  });

  it('preserves an expired selfie and retry action after transient network or storage failures', () => {
    const expiredItem: AttendanceVerificationDto = {
      ...verification,
      selfie: {
        url: 'https://private.example.test/expired',
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    };
    const transientFailure = new AttendanceReviewApiError(
      503,
      'ATTENDANCE_EVIDENCE_VALIDATION_UNAVAILABLE',
    );
    const afterTransientFailure = selfieAfterReadFailure(expiredItem, transientFailure);
    expect(afterTransientFailure).toBe(expiredItem);
    const retryMarkup = detail('ADMIN', afterTransientFailure);
    expect(retryMarkup).toContain('Tautan foto kedaluwarsa');
    expect(retryMarkup).toContain('Muat ulang foto');

    const afterConfirmedMissing = selfieAfterReadFailure(
      expiredItem,
      new AttendanceReviewApiError(404, 'SELFIE_NOT_FOUND'),
    );
    expect(afterConfirmedMissing.selfie).toBeNull();
    expect(detail('ADMIN', afterConfirmedMissing)).not.toContain('Muat ulang foto');
    expect(
      selfieAfterReadFailure(
        expiredItem,
        new AttendanceReviewApiError(404, 'ATTENDANCE_NOT_FOUND'),
      ),
    ).toBe(expiredItem);
    expect(selfieAfterReadFailure(expiredItem, new TypeError('network failed'))).toBe(expiredItem);
  });

  it('shows loading, error, empty and paginated verification queue states', () => {
    const renderQueue = (state: VerificationQueueState) =>
      renderToStaticMarkup(
        <VerificationQueue
          onPageChange={() => undefined}
          onRetry={() => undefined}
          onSelect={() => undefined}
          selectedId={null}
          state={state}
        />,
      );
    expect(renderQueue({ status: 'loading' })).toContain('Memuat antrean verifikasi');
    expect(renderQueue({ status: 'error', error: new Error('offline') })).toContain('Coba lagi');
    expect(
      renderQueue({
        status: 'loaded',
        page: { items: [], page: 1, pageSize: 25, hasNextPage: false },
      }),
    ).toContain('Tidak ada absensi menunggu');
    const page = renderQueue({
      status: 'loaded',
      page: {
        items: [{ ...verification, selfie: null }],
        page: 2,
        pageSize: 25,
        hasNextPage: true,
      },
    });
    expect(page).toContain('Karyawan Contoh');
    expect(page).toContain('Halaman 2');
    expect(page).toContain('Berikutnya');
  });

  it('never offers Supervisor a final overtime decision but allows Admin with a required note', () => {
    const supervisor = renderToStaticMarkup(
      <RequestReviewDetail
        onDecision={async () => undefined}
        onGetAttachmentUrl={async () => signedRequestAttachment}
        request={overtimeRequest}
        role="SUPERVISOR"
        submitting={false}
      />,
    );
    const admin = renderToStaticMarkup(
      <RequestReviewDetail
        onDecision={async () => undefined}
        onGetAttachmentUrl={async () => signedRequestAttachment}
        request={overtimeRequest}
        role="ADMIN"
        submitting={false}
      />,
    );
    expect(supervisor).toContain('Teruskan kepada Admin');
    expect(supervisor).toContain('hanya dihitung setelah persetujuan Admin');
    expect(supervisor).not.toContain('Setujui pengajuan');
    expect(supervisor).not.toContain('Tolak pengajuan');
    expect(admin).toContain('Setujui pengajuan');
    expect(admin).toContain('Tolak pengajuan');
    expect(admin).toContain('Catatan wajib untuk semua keputusan');
    expect(admin).toContain('aria-required="true"');
  });

  it('offers doctor-note download preparation only for SICK requests with an attachment', () => {
    let attachmentUrlCalls = 0;
    const onGetAttachmentUrl = async () => {
      attachmentUrlCalls += 1;
      return signedRequestAttachment;
    };
    const renderRequest = (request: ReviewerRequestDto) =>
      renderToStaticMarkup(
        <RequestReviewDetail
          onDecision={async () => undefined}
          onGetAttachmentUrl={onGetAttachmentUrl}
          request={request}
          role="ADMIN"
          submitting={false}
        />,
      );

    const sickMarkup = renderRequest(sickRequest);
    const sickWithoutAttachment = renderRequest({ ...sickRequest, hasAttachment: false });
    const leaveMarkup = renderRequest({ ...overtimeRequest, requestType: 'LEAVE' });
    const supervisorMarkup = renderToStaticMarkup(
      <RequestReviewDetail
        onDecision={async () => undefined}
        onGetAttachmentUrl={onGetAttachmentUrl}
        request={sickRequest}
        role="SUPERVISOR"
        submitting={false}
      />,
    );

    expect(sickMarkup).toContain('Lampiran tercatat');
    expect(sickMarkup).toContain('Siapkan tautan unduh');
    expect(sickMarkup).toContain('Surat dokter tidak ditampilkan di halaman');
    expect(sickMarkup).not.toContain('attachment-url');
    expect(sickWithoutAttachment).toContain('Tidak ada lampiran');
    expect(sickWithoutAttachment).not.toContain('Siapkan tautan unduh');
    expect(leaveMarkup).not.toContain('Siapkan tautan unduh');
    expect(supervisorMarkup).toContain('Siapkan tautan unduh');
    expect(attachmentUrlCalls).toBe(0);
  });

  it('renders accessible loading, safe error/retry, expired, and no-referrer download states', () => {
    const renderDownload = (state: Parameters<typeof RequestAttachmentDownload>[0]['state']) =>
      renderToStaticMarkup(
        <RequestAttachmentDownload
          onExpired={() => undefined}
          onPrepare={() => undefined}
          state={state}
        />,
      );

    const loading = renderDownload({ status: 'loading' });
    const error = renderDownload({ status: 'error', message: 'Tautan belum tersedia.' });
    const expired = renderDownload({ status: 'expired' });
    const ready = renderDownload({ status: 'ready', attachment: signedRequestAttachment });

    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-live="polite"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('disabled=""');
    expect(error).toContain('role="alert"');
    expect(error).toContain('Coba lagi');
    expect(error).not.toContain('private.example.test');
    expect(expired).toContain('Tautan unduh kedaluwarsa');
    expect(expired).toContain('Siapkan tautan baru');
    expect(ready.toLowerCase()).toContain('rel="noreferrer noopener"');
    expect(ready.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(ready).toContain('target="_blank"');
    expect(ready).toContain('>Unduh surat dokter</a>');
    expect(ready).not.toContain('<img');
    expect(ready).not.toContain('signature=temporary-secret</a>');
  });

  it('drops the in-memory signed URL when its download link expires and supports manual retry', () => {
    const idle = { status: 'idle' } as const;
    const loading = requestAttachmentDownloadReducer(idle, { type: 'prepare' });
    const error = requestAttachmentDownloadReducer(loading, {
      type: 'error',
      message: 'Tautan belum tersedia.',
    });
    const retried = requestAttachmentDownloadReducer(error, { type: 'prepare' });
    const ready = requestAttachmentDownloadReducer(retried, {
      type: 'ready',
      attachment: signedRequestAttachment,
    });
    const expired = requestAttachmentDownloadReducer(ready, { type: 'expired' });

    expect(loading.status).toBe('loading');
    expect(error).toEqual({ status: 'error', message: 'Tautan belum tersedia.' });
    expect(retried.status).toBe('loading');
    expect(ready).toEqual({ status: 'ready', attachment: signedRequestAttachment });
    expect(expired).toEqual({ status: 'expired' });
    expect(expired).not.toHaveProperty('attachment');
  });
});

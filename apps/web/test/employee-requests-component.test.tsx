import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import {
  AttendanceRequestsApiError,
  type AttendanceRequestDto,
} from '../src/api/attendance-requests-api.js';
import { decideDirectRouteAccess } from '../src/auth/route-policy.js';
import type { AuthUser, SessionState, UserRole } from '../src/auth/session.js';
import { ROLE_NAVIGATION, getRoleRoute } from '../src/app/role-navigation.js';
import { RolePage } from '../src/app/RolePage.js';
import { renderToResolvedMarkup } from './render-to-resolved-markup.js';
import {
  EmployeeRequestForm,
  EmployeeRequestList,
  RequestSubmissionFeedback,
} from '../src/pages/EmployeeRequestsPage.js';

const request: AttendanceRequestDto = {
  id: '00000000-0000-4000-8000-000000000901',
  employee: {
    id: '00000000-0000-4000-8000-000000000902',
    fullName: 'Karyawan Contoh',
  },
  requestType: 'OVERTIME',
  startDate: '2026-10-12',
  endDate: '2026-10-13',
  reason: 'Menyelesaikan pekerjaan',
  status: 'PENDING',
  requestedAt: '2026-10-11T04:00:00.000Z',
  decisionAt: null,
  decisionNote: null,
  hasAttachment: false,
  requestedOvertimeMinutes: 90,
  approvedOvertimeMinutes: 0,
};

function user(role: UserRole): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000903',
    username: 'pengguna',
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000904',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

function session(role: UserRole): SessionState {
  return { status: 'authenticated', user: user(role) };
}

describe('employee requests page and components', () => {
  it('renders the employee request route inside the existing role route', async () => {
    expect(getRoleRoute('/employee/requests')?.role).toBe('EMPLOYEE');
    expect(ROLE_NAVIGATION.EMPLOYEE.some(({ to }) => to === '/employee/requests')).toBe(true);

    const html = await renderToResolvedMarkup(
      <MemoryRouter initialEntries={['/employee/requests']}>
        <RolePage role="EMPLOYEE" route="/employee/requests" />
      </MemoryRouter>,
    );

    expect(html).toContain('Daftar pengajuan saya');
    expect(html).toContain('Ajukan izin, sakit, cuti, atau lembur');
    expect(html).toContain('Memuat pengajuan Anda');
    expect(html).toContain('Koreksi absensi — Belum tersedia');
    expect(html).not.toContain('Sisa cuti');
    expect(html).not.toContain('value="CORRECTION"');
  });

  it('allows only employees to enter the direct route and keeps correction out of the select', () => {
    expect(decideDirectRouteAccess(session('EMPLOYEE'), '/employee/requests')).toBe('allow');
    expect(decideDirectRouteAccess(session('SUPERVISOR'), '/employee/requests')).toBe('wrong-role');
    expect(decideDirectRouteAccess(session('ADMIN'), '/employee/requests')).toBe('wrong-role');
    expect(getRoleRoute('/employee/requests/extra')).toBeNull();

    const form = renderToStaticMarkup(<EmployeeRequestForm onSubmit={async () => undefined} />);
    expect(form).toContain('Jenis pengajuan');
    expect(form).toContain('Tanggal mulai');
    expect(form).toContain('Tanggal selesai');
    expect(form).toContain('Alasan');
    expect(form).not.toContain('<option value="CORRECTION">');
    expect(form).toContain('Fitur koreksi menunggu implementasi BE-022');
  });

  it('uses unique, associated IDs when multiple request forms render together', () => {
    const html = renderToStaticMarkup(
      <>
        <EmployeeRequestForm onSubmit={async () => undefined} />
        <EmployeeRequestForm onSubmit={async () => undefined} />
      </>,
    );
    const reasonFields = [...html.matchAll(/<textarea\b[^>]*>/g)].map(([markup]) => {
      const describedBy = markup.match(/aria-describedby="([^"]+)"/)?.[1] ?? '';
      const id = markup.match(/\bid="([^"]+)"/)?.[1] ?? '';
      return { describedBy, id };
    });

    expect(reasonFields).toHaveLength(2);
    expect(reasonFields.every(({ id }) => id.length > 0)).toBe(true);
    expect(new Set(reasonFields.map(({ id }) => id)).size).toBe(2);
    expect(reasonFields.every(({ describedBy, id }) => describedBy === `${id}-hint`)).toBe(true);
  });

  it('renders loading, safe error and empty list states', () => {
    const loading = renderToStaticMarkup(
      <EmployeeRequestList
        onPageChange={() => undefined}
        onRetry={() => undefined}
        state={{ status: 'loading' }}
      />,
    );
    const error = renderToStaticMarkup(
      <EmployeeRequestList
        onPageChange={() => undefined}
        onRetry={() => undefined}
        state={{
          status: 'error',
          error: new AttendanceRequestsApiError(409, 'ATTENDANCE_REQUEST_DATE_OVERLAP'),
        }}
      />,
    );
    const empty = renderToStaticMarkup(
      <EmployeeRequestList
        onPageChange={() => undefined}
        onRetry={() => undefined}
        state={{ status: 'loaded', page: { items: [], page: 1, pageSize: 25, hasNextPage: false } }}
      />,
    );

    expect(loading).toContain('role="status"');
    expect(loading).toContain('Memuat pengajuan Anda');
    expect(error).toContain('bertumpang tindih');
    expect(error).toContain('Coba lagi');
    expect(empty).toContain('Belum ada pengajuan');
    expect(empty).toContain('Tidak ada saldo cuti yang disimpulkan');
  });

  it('renders decision note, attachment state, status and API-driven pagination', () => {
    const page = renderToStaticMarkup(
      <EmployeeRequestList
        onPageChange={() => undefined}
        onRetry={() => undefined}
        state={{
          status: 'loaded',
          page: { items: [request], page: 2, pageSize: 25, hasNextPage: true },
        }}
      />,
    );
    const sickPage = renderToStaticMarkup(
      <EmployeeRequestList
        onPageChange={() => undefined}
        onRetry={() => undefined}
        state={{
          status: 'loaded',
          page: {
            items: [
              {
                ...request,
                requestType: 'SICK',
                status: 'REJECTED',
                hasAttachment: true,
                decisionNote: 'Lampiran perlu diperbarui.',
                requestedOvertimeMinutes: null,
              },
            ],
            page: 1,
            pageSize: 25,
            hasNextPage: false,
          },
        }}
      />,
    );

    expect(page).toContain('Menunggu keputusan');
    expect(page).toContain('Rentang tanggal');
    expect(page).toContain('12 Okt 2026');
    expect(page).toContain('13 Okt 2026');
    expect(page).toContain('Menyelesaikan pekerjaan');
    expect(page).toContain('90 menit');
    expect(page).toContain('Keputusan final lembur diberikan oleh Admin.');
    expect(page).toContain('Halaman 2 · 25 per halaman');
    expect(page).not.toContain('disabled=""');
    expect(sickPage).toContain('Ditolak');
    expect(sickPage).toContain('Surat dokter');
    expect(sickPage).toContain('Terlampir');
    expect(sickPage).toContain('Lampiran perlu diperbarui.');
  });

  it('renders submission success and error feedback accessibly without raw server details', () => {
    const success = renderToStaticMarkup(
      <RequestSubmissionFeedback
        feedback={{ tone: 'success', message: 'Pengajuan berhasil dikirim.' }}
      />,
    );
    const error = renderToStaticMarkup(
      <RequestSubmissionFeedback feedback={{ tone: 'danger', message: 'Periksa kembali data.' }} />,
    );

    expect(success).toContain('role="status"');
    expect(success).toContain('Pengajuan berhasil dikirim.');
    expect(error).toContain('role="alert"');
    expect(error).toContain('Periksa kembali data.');
    expect(error).not.toContain('raw server detail');
  });
});

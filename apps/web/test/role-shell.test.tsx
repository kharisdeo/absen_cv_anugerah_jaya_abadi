import { readFile } from 'node:fs/promises';

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { AuthUser, UserRole } from '../src/auth/session.js';
import { ROLE_BASE_PATHS, ROLE_NAVIGATION } from '../src/app/role-navigation.js';
import { AppShell } from '../src/components/AppShell.js';
import { ErrorState } from '../src/components/ui/AsyncState.js';
import { RoleHome } from '../src/pages/RoleHome.js';

vi.mock('../src/auth/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/session.js')>();
  return {
    ...actual,
    useSession: () => ({
      session: {
        status: 'authenticated',
        user: {
          id: '00000000-0000-4000-8000-000000000001',
          username: 'pengguna',
          role: 'EMPLOYEE',
          employeeId: '00000000-0000-4000-8000-000000000002',
          deviceBindingStatus: 'APPROVED',
          mustChangePassword: false,
          consentRequired: false,
        },
      },
      refreshSession: async () => ({
        status: 'authenticated',
        user: {
          id: '00000000-0000-4000-8000-000000000001',
          username: 'pengguna',
          role: 'EMPLOYEE',
          employeeId: '00000000-0000-4000-8000-000000000002',
          deviceBindingStatus: 'APPROVED',
          mustChangePassword: false,
          consentRequired: false,
        },
      }),
    }),
  };
});

function user(role: UserRole): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    username: 'pengguna',
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000002',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

function renderShell(role: UserRole): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[ROLE_BASE_PATHS[role]]}>
      <AppShell user={user(role)} />
    </MemoryRouter>,
  );
}

function renderRoleHome(role: UserRole, pathname = ROLE_BASE_PATHS[role]): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[pathname]}>
      <RoleHome role={role} />
    </MemoryRouter>,
  );
}

describe('role-specific dashboard shell', () => {
  it('shows each role only its own navigation and keeps every item reachable on mobile', () => {
    for (const role of ['EMPLOYEE', 'SUPERVISOR', 'ADMIN'] as const) {
      const html = renderShell(role);
      const expectedPaths = ROLE_NAVIGATION[role].map(({ to }) => to);

      for (const path of expectedPaths) expect(html).toContain(`href="${path}"`);
      for (const otherRole of ['EMPLOYEE', 'SUPERVISOR', 'ADMIN'] as const) {
        if (otherRole === role) continue;
        for (const { to } of ROLE_NAVIGATION[otherRole]) {
          expect(html).not.toContain(`href="${to}"`);
        }
      }
      expect(html).toContain('Navigasi bawah; geser untuk melihat semua menu');
    }
  });

  it('shows employee-only check-in/out actions while loading server-provided dashboard status', () => {
    const html = renderRoleHome('EMPLOYEE');

    expect(html).toContain('Status hari ini');
    expect(html).toContain('Memuat jadwal hari ini');
    expect(html).not.toContain('Data status belum tersedia');
    expect(html).toContain('Absen masuk');
    expect(html).toContain('Absen pulang');
    expect(html).toContain('Status absensi ditentukan oleh receipt server.');
    expect(html).not.toContain('Mengambil lokasi perangkat untuk pemeriksaan absensi');
    expect(html).not.toContain('<dialog');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('Foto sementara');
    expect(html).toContain('Riwayat absensi');
    expect(html).toContain('Jadwal kerja');
    expect(html).toContain('Sisa cuti dan informasi cuti');
    expect(html).toContain('Pengajuan saya');
    expect(html).not.toContain('08');
    expect(html).not.toContain('Belum ada data absensi');
  });

  it('keeps location capture unmounted on employee feature navigation', () => {
    const html = renderRoleHome('EMPLOYEE', '/employee/history');

    expect(html).not.toContain('<dialog');
    expect(html).not.toContain('Mengambil lokasi perangkat untuk pemeriksaan absensi');
    expect(html).toContain('Riwayat absensi');
  });

  it('mounts the capture dialog only behind an explicit attendance action', async () => {
    const source = await readFile(new URL('../src/pages/RoleHome.tsx', import.meta.url), 'utf8');

    expect(source).toMatch(
      /function startAttendance\(type: AttendanceType\)\s*\{\s*setLastReceipt\(null\);\s*setAttendanceType\(type\);\s*\}/,
    );
    expect(source).toMatch(
      /\{attendanceType && \(\s*<CameraCaptureDialog[\s\S]*?attendanceType=\{attendanceType\}/,
    );
    expect(source).toContain("onClick={() => startAttendance('CHECK_IN')}");
    expect(source).toContain("onClick={() => startAttendance('CHECK_OUT')}");
    expect(source).not.toMatch(/\b(?:getCurrentPosition|watchPosition)\s*\(/);
  });

  it('keeps supervisor scope server-derived while loading its summary', () => {
    const html = renderRoleHome('SUPERVISOR');

    expect(html).toContain('Cakupan toko mengikuti penugasan yang diperiksa server.');
    expect(html).toContain('Tidak ada pemilih atau filter toko dari browser');
    expect(html).toContain('Memuat ringkasan tim');
    expect(html).not.toContain('Data pending belum tersedia dari layanan server.');
    expect(html).not.toContain('storeId');
    expect(html).not.toContain('href="/supervisor?');
    expect(html).not.toContain('Kamera depan');
    expect(html).not.toContain('Absen masuk');
    expect(html).not.toContain('Absen pulang');
  });

  it('shows empty admin operational summaries and master-data destinations without fake counts', () => {
    const html = renderRoleHome('ADMIN');

    for (const text of [
      'Ringkasan toko',
      'Menunggu verifikasi atau keputusan',
      'Belum absen',
      'MASTER DATA',
      'Karyawan',
      'Lokasi toko',
      'Akun pengguna',
      'Jadwal &amp; shift',
      'OPERASIONAL',
      'Pengajuan untuk ditinjau',
      'Verifikasi absensi',
      'Rekap dan ekspor',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('Jumlah pending belum tersedia dari layanan dashboard.');
    expect(html).toContain('tidak ada status yang disimpulkan di browser.');
    expect(html).not.toContain('0 karyawan');
    expect(html).not.toContain('href="/admin?');
    expect(html).not.toContain('Kamera depan');
    expect(html).not.toContain('Absen masuk');
    expect(html).not.toContain('Absen pulang');
  });

  it('renders a forbidden API response as a safe error, never as dashboard data', () => {
    const html = renderToStaticMarkup(
      <ErrorState
        error={{
          status: 403,
          code: 'FORBIDDEN',
          detail: 'private store assignment details',
        }}
      />,
    );

    expect(html).toContain('Anda tidak memiliki akses untuk melakukan tindakan ini.');
    expect(html).not.toContain('private store assignment details');
  });

  it('keeps dashboard and multi-item mobile navigation responsive', async () => {
    const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.dashboard-metric-grid');
    expect(css).toContain('overflow-x: auto');
    expect(css).toContain('.mobile-nav__link');
    expect(css).toContain('@media (max-width: 700px)');
  });
});

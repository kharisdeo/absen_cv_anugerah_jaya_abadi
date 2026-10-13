import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const useSessionMock = vi.hoisted(() => vi.fn());

vi.mock('../src/auth/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/session.js')>();
  return { ...actual, useSession: useSessionMock };
});
vi.mock('../src/components/PwaControls.js', () => ({ PwaControls: () => null }));

import { RequireRole } from '../src/app/App.js';
import { RolePage } from '../src/app/RolePage.js';
import { ROLE_NAVIGATION } from '../src/app/role-navigation.js';
import type { AuthUser, UserRole } from '../src/auth/session.js';
import { renderToResolvedMarkup } from './render-to-resolved-markup.js';

const routeMarkers: Readonly<Record<string, string>> = {
  '/employee': 'Status hari ini',
  '/employee/history': 'Riwayat absensi',
  '/employee/schedule': 'Jadwal hari ini',
  '/employee/leave': 'Cuti dan pengajuan',
  '/employee/requests': 'Daftar pengajuan saya',
  '/employee/notifications': 'Notifikasi',
  '/supervisor': 'Cakupan toko mengikuti penugasan yang diperiksa server.',
  '/supervisor/verification': 'Menunggu verifikasi',
  '/supervisor/requests': 'Pengajuan menunggu',
  '/supervisor/notifications': 'Notifikasi',
  '/supervisor/reports': 'Laporan kehadiran',
  '/admin': 'Ringkasan kehadiran',
  '/admin/employees': 'Data karyawan',
  '/admin/stores': 'Lokasi toko',
  '/admin/accounts': 'Akun pengguna',
  '/admin/schedules': 'Jadwal &amp; shift',
  '/admin/requests': 'Pengajuan menunggu',
  '/admin/verification': 'Menunggu verifikasi',
  '/admin/reports': 'Laporan kehadiran',
  '/admin/notifications': 'Notifikasi',
  '/admin/system-disruptions': 'Gangguan sistem',
  '/admin/audit-logs': 'Audit log',
};

const roles: readonly UserRole[] = ['EMPLOYEE', 'SUPERVISOR', 'ADMIN'];

function authUser(role: UserRole): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    username: 'pengguna',
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000102',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

function setAuthenticatedRole(role: UserRole) {
  useSessionMock.mockReturnValue({
    session: { status: 'authenticated', user: authUser(role) },
  });
}

function guardedRoute(role: UserRole, path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<RequireRole />}>
          <Route path="*" element={<RolePage role={role} route={path} />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('route-level page code splitting', () => {
  it('shows an accessible generic fallback while an authorized route module loads', () => {
    setAuthenticatedRole('ADMIN');
    const markup = renderToStaticMarkup(guardedRoute('ADMIN', '/admin/stores'));

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Memuat halaman');
    expect(markup).not.toContain('Lokasi toko');
    expect(markup).not.toContain('Memuat data toko');
  });

  // This deliberately renders every authorized route sequentially through SSR and lazy loading.
  it('keeps every registered route mapped and renders its page after the allowed lazy load', async () => {
    const registeredPaths = Object.values(ROLE_NAVIGATION)
      .flatMap((items) => items.map(({ to }) => to))
      .sort();
    expect(registeredPaths).toEqual(Object.keys(routeMarkers).sort());

    for (const role of roles) {
      for (const { to } of ROLE_NAVIGATION[role]) {
        setAuthenticatedRole(role);
        const markup = await renderToResolvedMarkup(guardedRoute(role, to));

        expect(markup, `${role} ${to}`).toContain(routeMarkers[to]);
        expect(markup, `${role} ${to}`).not.toContain('Memuat halaman');
      }
    }
  }, 15_000);

  it('denies cross-role direct URLs before rendering the lazy fallback or protected page', () => {
    for (const [routeRole, items] of Object.entries(ROLE_NAVIGATION) as [
      UserRole,
      (typeof ROLE_NAVIGATION)[UserRole],
    ][]) {
      for (const { to } of items) {
        for (const actualRole of roles.filter((role) => role !== routeRole)) {
          setAuthenticatedRole(actualRole);
          const markup = renderToStaticMarkup(guardedRoute(routeRole, to));

          expect(markup, `${actualRole} -> ${to}`).not.toContain('Memuat halaman');
          expect(markup, `${actualRole} -> ${to}`).not.toContain(routeMarkers[to]);
        }
      }
    }
  });
});

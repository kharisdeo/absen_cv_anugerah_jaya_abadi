import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { RolePage } from '../src/app/RolePage.js';
import { ROLE_NAVIGATION, getRoleRoute } from '../src/app/role-navigation.js';
import { decideDirectRouteAccess } from '../src/auth/route-policy.js';
import type { AuthUser, SessionState, UserRole } from '../src/auth/session.js';
import { AdminSystemDisruptionsPage } from '../src/pages/AdminSystemDisruptionsPage.js';
import { NotificationsPage } from '../src/pages/NotificationsPage.js';

function session(role: UserRole): SessionState {
  const user: AuthUser = {
    id: '00000000-0000-4000-8000-000000000201',
    username: 'pengguna',
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000202',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
  return { status: 'authenticated', user };
}

describe('FE-017 routes and role authorization', () => {
  it('registers exact notification routes for each role and denies cross-role direct URLs', () => {
    const routes = [
      ['/employee/notifications', 'EMPLOYEE'],
      ['/supervisor/notifications', 'SUPERVISOR'],
      ['/admin/notifications', 'ADMIN'],
    ] as const;

    for (const [path, role] of routes) {
      expect(getRoleRoute(path)?.role).toBe(role);
      expect(ROLE_NAVIGATION[role].some((item) => item.to === path)).toBe(true);
      expect(decideDirectRouteAccess(session(role), path)).toBe('allow');
      for (const otherRole of (['EMPLOYEE', 'SUPERVISOR', 'ADMIN'] as const).filter(
        (candidate) => candidate !== role,
      )) {
        expect(decideDirectRouteAccess(session(otherRole), path)).toBe('wrong-role');
      }
      const markup = renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
          <RolePage role={role} route={path} />
        </MemoryRouter>,
      );
      expect(markup).toContain('Memuat halaman');
    }

    const pageMarkup = renderToStaticMarkup(<NotificationsPage />);
    expect(pageMarkup).toContain('Notifikasi');
    expect(pageMarkup).toContain('Memuat notifikasi');
  });

  it('registers only the Admin system-disruption route and renders the scope/WIB/safety UI', () => {
    const path = '/admin/system-disruptions';
    expect(getRoleRoute(path)?.role).toBe('ADMIN');
    expect(ROLE_NAVIGATION.ADMIN.some((item) => item.to === path)).toBe(true);
    expect(decideDirectRouteAccess(session('ADMIN'), path)).toBe('allow');
    expect(decideDirectRouteAccess(session('EMPLOYEE'), path)).toBe('wrong-role');
    expect(decideDirectRouteAccess(session('SUPERVISOR'), path)).toBe('wrong-role');

    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <RolePage role="ADMIN" route={path} />
      </MemoryRouter>,
    );
    expect(markup).toContain('Memuat halaman');

    const pageMarkup = renderToStaticMarkup(<AdminSystemDisruptionsPage />);
    expect(pageMarkup).toContain('Gangguan sistem');
    expect(pageMarkup).toContain('Global · seluruh toko');
    expect(pageMarkup).toContain('Asia/Jakarta (UTC+07:00)');
    expect(pageMarkup).toContain('koreksi massal belum tersedia');
    expect(pageMarkup).toContain('Memuat riwayat gangguan');
  });
});

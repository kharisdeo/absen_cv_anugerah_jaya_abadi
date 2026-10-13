import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { decideDirectRouteAccess } from '../src/auth/route-policy.js';
import type { AuthUser, SessionState, UserRole } from '../src/auth/session.js';
import { ROLE_NAVIGATION, getRoleRoute } from '../src/app/role-navigation.js';
import { RolePage } from '../src/app/RolePage.js';
import { renderToResolvedMarkup } from './render-to-resolved-markup.js';

function user(role: UserRole): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000701',
    username: 'pengguna',
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000702',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

describe('admin account route', () => {
  it('renders the real account and device administration page at its configured route', async () => {
    expect(getRoleRoute('/admin/accounts')?.role).toBe('ADMIN');
    expect(ROLE_NAVIGATION.ADMIN.some(({ to }) => to === '/admin/accounts')).toBe(true);

    const html = await renderToResolvedMarkup(
      <MemoryRouter initialEntries={['/admin/accounts']}>
        <RolePage role="ADMIN" route="/admin/accounts" />
      </MemoryRouter>,
    );
    expect(html).toContain('Akun pengguna');
    expect(html).toContain('Akun login');
    expect(html).toContain('Persetujuan perangkat');
    expect(html).toContain('Memuat akun dari server');
    expect(html).not.toContain('Fitur ini belum tersedia');
  });

  it('keeps direct route access Admin-only and does not render the admin page for other roles', async () => {
    const admin: SessionState = { status: 'authenticated', user: user('ADMIN') };
    const supervisor: SessionState = { status: 'authenticated', user: user('SUPERVISOR') };
    const employee: SessionState = { status: 'authenticated', user: user('EMPLOYEE') };

    expect(decideDirectRouteAccess(admin, '/admin/accounts')).toBe('allow');
    expect(decideDirectRouteAccess(supervisor, '/admin/accounts')).toBe('wrong-role');
    expect(decideDirectRouteAccess(employee, '/admin/accounts')).toBe('wrong-role');

    const nonAdminPage = await renderToResolvedMarkup(
      <MemoryRouter initialEntries={['/admin/accounts']}>
        <RolePage role="SUPERVISOR" route="/admin/accounts" />
      </MemoryRouter>,
    );
    expect(nonAdminPage).not.toContain('Akun login');
  });
});

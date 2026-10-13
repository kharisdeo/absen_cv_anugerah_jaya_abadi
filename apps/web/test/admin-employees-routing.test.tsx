import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { decideDirectRouteAccess } from '../src/auth/route-policy.js';
import type { AuthUser, SessionState, UserRole } from '../src/auth/session.js';
import { ROLE_NAVIGATION, getRoleRoute } from '../src/app/role-navigation.js';
import { RolePage } from '../src/app/RolePage.js';
import { renderToResolvedMarkup } from './render-to-resolved-markup.js';

function user(role: UserRole): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000401',
    username: 'pengguna',
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000402',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

describe('admin employee route', () => {
  it('renders the real admin employee page on its configured route', async () => {
    expect(getRoleRoute('/admin/employees')?.role).toBe('ADMIN');
    expect(ROLE_NAVIGATION.ADMIN.some(({ to }) => to === '/admin/employees')).toBe(true);

    const html = await renderToResolvedMarkup(
      <MemoryRouter initialEntries={['/admin/employees']}>
        <RolePage role="ADMIN" route="/admin/employees" />
      </MemoryRouter>,
    );
    expect(html).toContain('Data karyawan');
    expect(html).toContain('Memuat data karyawan');
    expect(html).not.toContain('Fitur ini belum tersedia');
  });

  it('keeps the route protected by the authenticated server role', () => {
    const admin: SessionState = { status: 'authenticated', user: user('ADMIN') };
    const supervisor: SessionState = { status: 'authenticated', user: user('SUPERVISOR') };
    expect(decideDirectRouteAccess(admin, '/admin/employees')).toBe('allow');
    expect(decideDirectRouteAccess(supervisor, '/admin/employees')).toBe('wrong-role');
  });
});

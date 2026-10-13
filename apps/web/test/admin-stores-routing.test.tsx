import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { decideDirectRouteAccess } from '../src/auth/route-policy.js';
import type { AuthUser, SessionState, UserRole } from '../src/auth/session.js';
import { ROLE_NAVIGATION, getRoleRoute } from '../src/app/role-navigation.js';
import { RolePage } from '../src/app/RolePage.js';
import { renderToResolvedMarkup } from './render-to-resolved-markup.js';

function user(role: UserRole): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000201',
    username: 'pengguna',
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000202',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

describe('admin store route', () => {
  it('replaces only the admin store placeholder with the real loading page', async () => {
    const item = getRoleRoute('/admin/stores');
    expect(item?.role).toBe('ADMIN');
    expect(ROLE_NAVIGATION.ADMIN.some(({ to }) => to === '/admin/stores')).toBe(true);

    const html = await renderToResolvedMarkup(
      <MemoryRouter initialEntries={['/admin/stores']}>
        <RolePage role="ADMIN" route="/admin/stores" />
      </MemoryRouter>,
    );

    expect(html).toContain('Lokasi toko');
    expect(html).toContain('Memuat data toko');
    expect(html).not.toContain('Fitur ini belum tersedia');
    expect(html).not.toContain('00000000-0000-4000');
  });

  it('retains server-derived role protection for the store-management URL', () => {
    const adminSession: SessionState = { status: 'authenticated', user: user('ADMIN') };
    const employeeSession: SessionState = { status: 'authenticated', user: user('EMPLOYEE') };

    expect(decideDirectRouteAccess(adminSession, '/admin/stores')).toBe('allow');
    expect(decideDirectRouteAccess(employeeSession, '/admin/stores')).toBe('wrong-role');
  });
});

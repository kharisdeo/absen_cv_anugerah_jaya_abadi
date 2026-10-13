import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { decideDirectRouteAccess } from '../src/auth/route-policy.js';
import type { AuthUser, SessionState, UserRole } from '../src/auth/session.js';
import { ROLE_NAVIGATION, getRoleRoute } from '../src/app/role-navigation.js';
import { RolePage } from '../src/app/RolePage.js';
import { renderToResolvedMarkup } from './render-to-resolved-markup.js';

function user(role: UserRole): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000501',
    username: 'pengguna',
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000502',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
}

describe('admin schedule route', () => {
  it('uses the existing Admin menu and renders the shift catalog on /admin/schedules', async () => {
    expect(getRoleRoute('/admin/schedules')?.role).toBe('ADMIN');
    expect(ROLE_NAVIGATION.ADMIN.some(({ to }) => to === '/admin/schedules')).toBe(true);

    const html = await renderToResolvedMarkup(
      <MemoryRouter initialEntries={['/admin/schedules']}>
        <RolePage role="ADMIN" route="/admin/schedules" />
      </MemoryRouter>,
    );

    expect(html).toContain('Jadwal &amp; shift');
    expect(html).toContain('Memuat data shift');
    expect(html).toContain('Penugasan shift per karyawan');
    expect(html).toContain('Hari libur nasional &amp; toko');
    expect(html).not.toContain('Fitur ini belum tersedia');
    expect(html).not.toContain('00000000-0000-4000');
  });

  it('allows only Admin on direct entry and does not register a duplicate route', () => {
    const adminSession: SessionState = { status: 'authenticated', user: user('ADMIN') };
    const employeeSession: SessionState = { status: 'authenticated', user: user('EMPLOYEE') };
    const supervisorSession: SessionState = {
      status: 'authenticated',
      user: user('SUPERVISOR'),
    };

    expect(decideDirectRouteAccess(adminSession, '/admin/schedules')).toBe('allow');
    expect(decideDirectRouteAccess(employeeSession, '/admin/schedules')).toBe('wrong-role');
    expect(decideDirectRouteAccess(supervisorSession, '/admin/schedules')).toBe('wrong-role');
    expect(getRoleRoute('/admin/shifts')).toBeNull();
    expect(decideDirectRouteAccess(adminSession, '/admin/shifts')).toBe('not-found');
  });
});

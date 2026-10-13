import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { RolePage } from '../src/app/RolePage.js';
import { ROLE_NAVIGATION, getRoleRoute } from '../src/app/role-navigation.js';
import { decideDirectRouteAccess } from '../src/auth/route-policy.js';
import type { AuthUser, SessionState, UserRole } from '../src/auth/session.js';
import { AdminAuditLogsPage } from '../src/pages/AdminAuditLogsPage.js';
import { renderToResolvedMarkup } from './render-to-resolved-markup.js';

function session(role: UserRole): SessionState {
  const user: AuthUser = {
    id: '00000000-0000-4000-8000-000000000721',
    username: 'pengguna',
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000722',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  };
  return { status: 'authenticated', user };
}

describe('Admin audit-log route and page', () => {
  it('registers only the exact Admin route and denies Employee/Supervisor direct access', () => {
    const path = '/admin/audit-logs';
    expect(getRoleRoute(path)?.role).toBe('ADMIN');
    expect(
      ROLE_NAVIGATION.ADMIN.some(({ to, label }) => to === path && label === 'Audit log'),
    ).toBe(true);
    expect(
      Object.entries(ROLE_NAVIGATION)
        .filter(([role]) => role !== 'ADMIN')
        .flatMap(([, items]) => items)
        .some(({ to }) => to === path),
    ).toBe(false);
    expect(decideDirectRouteAccess(session('ADMIN'), path)).toBe('allow');
    expect(decideDirectRouteAccess(session('EMPLOYEE'), path)).toBe('wrong-role');
    expect(decideDirectRouteAccess(session('SUPERVISOR'), path)).toBe('wrong-role');
  });

  it('renders the accessible loading state, inclusive WIB filter guidance, and read-only page', async () => {
    const pageMarkup = renderToStaticMarkup(<AdminAuditLogsPage />);
    expect(pageMarkup).toContain('role="status"');
    expect(pageMarkup).toContain('Memuat audit log');
    expect(pageMarkup).toContain('type="date"');
    expect(pageMarkup).toContain('Rentang tanggal inklusif');
    expect(pageMarkup).toContain('Actor user account ID (UUID)');
    expect(pageMarkup).toContain('Data di halaman ini hanya-baca.');

    const resolvedMarkup = await renderToResolvedMarkup(
      <MemoryRouter initialEntries={['/admin/audit-logs']}>
        <RolePage role="ADMIN" route="/admin/audit-logs" />
      </MemoryRouter>,
    );
    expect(resolvedMarkup).toContain('Audit log');
    expect(resolvedMarkup).toContain('Memuat audit log');
    expect(resolvedMarkup).not.toContain('Memuat halaman');
  });
});

import { describe, expect, it } from 'vitest';

import {
  decideDirectRouteAccess,
  decideRouteAccess,
  getOnboardingStep,
  homePathForRole,
} from '../src/auth/route-policy.js';
import {
  USER_ROLES,
  type AuthUser,
  type SessionState,
  type UserRole,
} from '../src/auth/session.js';
import { ROLE_BASE_PATHS, ROLE_NAVIGATION, getRoleRoute } from '../src/app/role-navigation.js';

function user(role: UserRole, overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    username: 'pengguna',
    role,
    employeeId: role === 'ADMIN' ? null : '00000000-0000-4000-8000-000000000002',
    deviceBindingStatus: role === 'ADMIN' ? null : 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
    ...overrides,
  };
}

describe('role route policy', () => {
  it('keeps loading, anonymous, and unreachable API states outside protected routes', () => {
    expect(decideRouteAccess({ status: 'loading' }, 'ADMIN')).toBe('loading');
    expect(decideRouteAccess({ status: 'unauthenticated' }, 'ADMIN')).toBe('login');
    expect(decideRouteAccess({ status: 'unavailable' }, 'ADMIN')).toBe('unavailable');
  });

  it('allows only the matching server-derived role', () => {
    expect(decideRouteAccess({ status: 'authenticated', user: user('EMPLOYEE') }, 'EMPLOYEE')).toBe(
      'allow',
    );
    expect(decideRouteAccess({ status: 'authenticated', user: user('EMPLOYEE') }, 'ADMIN')).toBe(
      'wrong-role',
    );
    expect(decideRouteAccess({ status: 'authenticated', user: user('ADMIN') }, 'ADMIN')).toBe(
      'allow',
    );
  });

  it('gates onboarding and unapproved employee devices before protected data', () => {
    expect(
      decideRouteAccess(
        { status: 'authenticated', user: user('ADMIN', { mustChangePassword: true }) },
        'ADMIN',
      ),
    ).toBe('onboarding');
    expect(
      decideRouteAccess(
        { status: 'authenticated', user: user('SUPERVISOR', { consentRequired: true }) },
        'SUPERVISOR',
      ),
    ).toBe('onboarding');
    expect(
      decideRouteAccess(
        { status: 'authenticated', user: user('EMPLOYEE', { deviceBindingStatus: 'PENDING' }) },
        'EMPLOYEE',
      ),
    ).toBe('device-pending');
    expect(
      decideRouteAccess(
        { status: 'authenticated', user: user('EMPLOYEE', { deviceBindingStatus: null }) },
        'EMPLOYEE',
      ),
    ).toBe('device-pending');
  });

  it('maps each role to one canonical landing route', () => {
    expect(homePathForRole('EMPLOYEE')).toBe('/employee');
    expect(homePathForRole('SUPERVISOR')).toBe('/supervisor');
    expect(homePathForRole('ADMIN')).toBe('/admin');
  });

  it('guards every configured direct route using the server-derived role', () => {
    for (const role of USER_ROLES) {
      for (const item of ROLE_NAVIGATION[role]) {
        expect(
          item.to.startsWith(`${ROLE_BASE_PATHS[role]}/`) || item.to === ROLE_BASE_PATHS[role],
        ).toBe(true);
        expect(item.to).not.toContain('?');
        expect(getRoleRoute(item.to)?.role).toBe(role);
        expect(getRoleRoute(`${item.to}/`)?.role).toBe(role);

        for (const actualRole of USER_ROLES) {
          const directSession: SessionState = {
            status: 'authenticated',
            user: user(actualRole),
          };
          expect(decideDirectRouteAccess(directSession, item.to)).toBe(
            actualRole === role ? 'allow' : 'wrong-role',
          );
        }
      }
    }

    expect(decideDirectRouteAccess({ status: 'unauthenticated' }, '/admin/unknown')).toBe(
      'not-found',
    );
  });

  it('enforces consent, password change, then device approval in server gate order', () => {
    expect(
      getOnboardingStep(user('EMPLOYEE', { consentRequired: true, mustChangePassword: true })),
    ).toBe('consent');
    expect(getOnboardingStep(user('EMPLOYEE', { mustChangePassword: true }))).toBe('password');
    expect(getOnboardingStep(user('EMPLOYEE', { deviceBindingStatus: 'PENDING' }))).toBe(
      'device-pending',
    );
    expect(getOnboardingStep(user('ADMIN', { deviceBindingStatus: null }))).toBe('complete');
  });
});

const sessionStates: readonly SessionState[] = [
  { status: 'loading' },
  { status: 'unauthenticated' },
  { status: 'unavailable' },
];

it('declares all non-authenticated session states explicitly', () => {
  expect(sessionStates.map(({ status }) => status)).toEqual([
    'loading',
    'unauthenticated',
    'unavailable',
  ]);
});

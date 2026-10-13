import type { AuthUser, SessionState, UserRole } from './session.js';
import { getRoleRoute } from '../app/role-navigation.js';

export type RouteDecision =
  'loading' | 'login' | 'unavailable' | 'onboarding' | 'device-pending' | 'wrong-role' | 'allow';
export type DirectRouteDecision = RouteDecision | 'not-found';
export type OnboardingStep = 'consent' | 'password' | 'device-pending' | 'complete';

function authenticatedUser(session: SessionState): AuthUser | null {
  return session.status === 'authenticated' ? session.user : null;
}

export function decideRouteAccess(session: SessionState, requiredRole: UserRole): RouteDecision {
  if (session.status === 'loading') return 'loading';
  if (session.status === 'unauthenticated') return 'login';
  if (session.status === 'unavailable') return 'unavailable';

  const user = authenticatedUser(session);
  if (!user) return 'unavailable';
  const step = getOnboardingStep(user);
  if (step === 'consent' || step === 'password') return 'onboarding';
  if (step === 'device-pending') return 'device-pending';
  return user.role === requiredRole ? 'allow' : 'wrong-role';
}

/** Apply the guard for the exact canonical route reached by direct navigation. */
export function decideDirectRouteAccess(
  session: SessionState,
  pathname: string,
): DirectRouteDecision {
  const route = getRoleRoute(pathname);
  return route ? decideRouteAccess(session, route.role) : 'not-found';
}

/** Mirrors the server's access gate order: consent, then password, then device approval. */
export function getOnboardingStep(user: AuthUser): OnboardingStep {
  if (user.consentRequired) return 'consent';
  if (user.mustChangePassword) return 'password';
  if (user.role !== 'ADMIN' && user.deviceBindingStatus !== 'APPROVED') return 'device-pending';
  return 'complete';
}

export function homePathForRole(role: UserRole): string {
  switch (role) {
    case 'ADMIN':
      return '/admin';
    case 'SUPERVISOR':
      return '/supervisor';
    case 'EMPLOYEE':
      return '/employee';
  }
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { API_BASE_URL } from '../config.js';
import { apiFetch, readApiJson } from '../api/api-client.js';
import { AuthApiError } from './auth-api.js';

export const USER_ROLES = ['ADMIN', 'SUPERVISOR', 'EMPLOYEE'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export type DeviceBindingStatus = 'PENDING' | 'APPROVED' | 'REVOKED' | null;

export type AuthUser = Readonly<{
  id: string;
  username: string;
  role: UserRole;
  employeeId: string | null;
  deviceBindingStatus: DeviceBindingStatus;
  mustChangePassword: boolean;
  consentRequired: boolean;
}>;

export type SessionState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'unauthenticated' }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'authenticated'; user: AuthUser }>;

type SessionContextValue = Readonly<{
  session: SessionState;
  refreshSession: () => Promise<SessionState>;
}>;
const SessionContext = createContext<SessionContextValue | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAuthUser(value: unknown): value is AuthUser {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.username === 'string' &&
    USER_ROLES.includes(value.role as UserRole) &&
    (typeof value.employeeId === 'string' || value.employeeId === null) &&
    (value.deviceBindingStatus === null ||
      value.deviceBindingStatus === 'PENDING' ||
      value.deviceBindingStatus === 'APPROVED' ||
      value.deviceBindingStatus === 'REVOKED') &&
    typeof value.mustChangePassword === 'boolean' &&
    typeof value.consentRequired === 'boolean'
  );
}

function parseAuthUser(payload: unknown): AuthUser | null {
  if (!isRecord(payload) || !isAuthUser(payload.user)) return null;
  return payload.user;
}

export async function fetchSessionState(signal?: AbortSignal): Promise<SessionState | null> {
  try {
    const response = await apiFetch(`${API_BASE_URL}/auth/me`, {
      credentials: 'include',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
      headers: { Accept: 'application/json' },
    });
    if (response.status === 401) return { status: 'unauthenticated' };
    const payload = await readApiJson(
      response,
      200,
      ({ status, code, requestId }) => new AuthApiError(status, code, requestId),
    );
    const user = parseAuthUser(payload);
    return user ? { status: 'authenticated', user } : { status: 'unavailable' };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    return { status: 'unavailable' };
  }
}

export function SessionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const requestVersion = useRef(0);

  const refreshSession = useCallback(async (): Promise<SessionState> => {
    const version = ++requestVersion.current;
    const next = await fetchSessionState();
    if (!next) return { status: 'unavailable' };
    if (version === requestVersion.current) setSession(next);
    return next;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++requestVersion.current;
    void fetchSessionState(controller.signal).then((next) => {
      if (next && version === requestVersion.current) setSession(next);
    });
    return () => {
      controller.abort();
      if (requestVersion.current === version) requestVersion.current += 1;
    };
  }, []);

  const value = useMemo(() => ({ session, refreshSession }), [refreshSession, session]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession harus digunakan di dalam SessionProvider.');
  return value;
}

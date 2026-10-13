import { randomBytes } from 'node:crypto';

import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { UserRole } from '../generated/prisma/enums.js';
import { AppError } from '../errors/app-error.js';
import type { AuthenticatedSession } from '../modules/auth/contracts.js';
import { AuthService } from '../modules/auth/service.js';
import { API_PREFIX } from '../shared/api-prefix.js';

const COOKIE_NAME = 'absen_session';
const SESSION_COOKIE_PATH = '/';
const loginBody = z
  .object({
    identifier: z.string(),
    password: z.string(),
    deviceToken: z.string().optional(),
    deviceName: z.string().optional(),
  })
  .strict();
const changePasswordBody = z
  .object({ currentPassword: z.string(), newPassword: z.string() })
  .strict();
const resetPasswordBody = z.object({ temporaryPassword: z.string() }).strict();
const accountParams = z.object({ accountId: z.string().uuid() }).strict();

declare module 'fastify' {
  interface FastifyRequest {
    authSession: AuthenticatedSession | null;
  }
}

export type AuthRoutesOptions = Readonly<{
  service: AuthService;
  cookieSecret?: string;
  secureCookies: boolean;
  /** Exact frontend origin, required to reject cross-site credentialed writes. */
  allowedOrigin: string;
  loginRateLimit?: Readonly<{ max: number; timeWindow: string }>;
  sensitiveRateLimit?: Readonly<{ max: number; timeWindow: string }>;
}>;

function getCookieSecret(options: AuthRoutesOptions): string {
  if (options.secureCookies && !options.cookieSecret) {
    throw new Error('SESSION_SECRET wajib dikonfigurasi saat Secure cookie aktif.');
  }
  const secret = options.cookieSecret ?? randomBytes(32).toString('base64url');
  if (Buffer.byteLength(secret, 'utf8') < 20) {
    throw new Error('Cookie signing secret must be at least 20 bytes.');
  }
  return secret;
}

function cookieMaxAge(role: UserRole): number {
  return role === UserRole.ADMIN ? 30 * 60 : 7 * 24 * 60 * 60;
}

function readCookieToken(request: FastifyRequest): string | undefined {
  const cookieValue = request.cookies[COOKIE_NAME];
  if (!cookieValue) return undefined;
  const unsigned = request.unsignCookie(cookieValue);
  return unsigned.valid ? unsigned.value : undefined;
}

function setSessionCookie(
  reply: FastifyReply,
  token: string,
  role: UserRole,
  options: AuthRoutesOptions,
): void {
  reply.setCookie(COOKIE_NAME, token, {
    path: SESSION_COOKIE_PATH,
    httpOnly: true,
    secure: options.secureCookies,
    sameSite: 'strict',
    signed: true,
    maxAge: cookieMaxAge(role),
  });
}

function clearSessionCookie(reply: FastifyReply, options: AuthRoutesOptions): void {
  reply.clearCookie(COOKIE_NAME, {
    path: SESSION_COOKIE_PATH,
    httpOnly: true,
    secure: options.secureCookies,
    sameSite: 'strict',
  });
}

export function assertAllowedOrigin(request: FastifyRequest, options: AuthRoutesOptions): void {
  let expectedOrigin: string;
  try {
    const parsed = new URL(options.allowedOrigin);
    if (parsed.origin !== options.allowedOrigin) throw new Error('not an origin');
    expectedOrigin = parsed.origin;
  } catch {
    throw new AppError(403, 'CSRF_ORIGIN_NOT_CONFIGURED', 'Origin aplikasi belum dikonfigurasi.');
  }
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin !== expectedOrigin) {
    throw new AppError(403, 'CSRF_ORIGIN_REJECTED', 'Origin permintaan tidak diizinkan.');
  }
}

export function requestContext(request: FastifyRequest) {
  return { clientIp: request.ip, requestId: request.id };
}

export function setNoStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AuthRoutesOptions,
  refreshCookie = true,
): Promise<AuthenticatedSession> {
  setNoStore(reply);
  if (request.authSession) {
    const token = readCookieToken(request);
    if (refreshCookie && token) {
      setSessionCookie(reply, token, request.authSession.principal.role, options);
    }
    return request.authSession;
  }
  const token = readCookieToken(request);
  const authenticated = await options.service.authenticate(token);
  request.authSession = authenticated;
  if (refreshCookie) setSessionCookie(reply, token!, authenticated.principal.role, options);
  return authenticated;
}

export async function registerAuthPlugins(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): Promise<void> {
  await app.register(cookie, { secret: getCookieSecret(options) });
  await app.register(rateLimit, { global: false });
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): Promise<void> {
  const base = `${API_PREFIX}/auth`;
  const loginRateLimit = options.loginRateLimit ?? { max: 10, timeWindow: '15 minutes' };
  const sensitiveRateLimit = options.sensitiveRateLimit ?? {
    max: 5,
    timeWindow: '15 minutes',
  };

  app.post(
    `${base}/login`,
    {
      config: { rateLimit: loginRateLimit },
      preHandler: async (request, reply) => {
        setNoStore(reply);
        assertAllowedOrigin(request, options);
      },
    },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body);
      if (!parsed.success) throw new AppError(400, 'INVALID_INPUT', 'Payload login tidak valid.');
      const result = await options.service.login(parsed.data, requestContext(request));
      setSessionCookie(reply, result.cookieToken, result.user.role, options);
      setNoStore(reply);
      return { user: result.user, consentRequired: result.user.consentRequired };
    },
  );

  app.get(`${base}/me`, async (request, reply) => {
    const authenticated = await requireSession(request, reply, options);
    return { user: authenticated.user, consentRequired: authenticated.user.consentRequired };
  });

  app.post(
    `${base}/logout`,
    {
      config: { rateLimit: sensitiveRateLimit },
      preHandler: async (request, reply) => {
        assertAllowedOrigin(request, options);
        await requireSession(request, reply, options, false);
      },
    },
    async (request, reply) => {
      const principal = request.authSession?.principal;
      if (!principal)
        throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
      try {
        await options.service.logout(principal, requestContext(request));
      } finally {
        clearSessionCookie(reply, options);
      }
      setNoStore(reply);
      return reply.code(204).send();
    },
  );

  app.post(
    `${base}/change-password`,
    {
      config: { rateLimit: sensitiveRateLimit },
      preHandler: async (request, reply) => {
        assertAllowedOrigin(request, options);
        // The replacement token is issued by the handler after revoking the old session.
        await requireSession(request, reply, options, false);
      },
    },
    async (request, reply) => {
      const parsed = changePasswordBody.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(400, 'INVALID_INPUT', 'Payload ganti password tidak valid.');
      }
      const principal = request.authSession?.principal;
      if (!principal)
        throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
      const result = await options.service.changePassword(
        principal,
        parsed.data,
        requestContext(request),
      );
      setSessionCookie(reply, result.cookieToken, result.user.role, options);
      setNoStore(reply);
      return { user: result.user, consentRequired: result.user.consentRequired };
    },
  );

  app.post<{ Params: { accountId: string } }>(
    `${base}/admin/accounts/:accountId/reset-password`,
    {
      config: { rateLimit: sensitiveRateLimit },
      preHandler: async (request, reply) => {
        assertAllowedOrigin(request, options);
        await requireSession(request, reply, options);
      },
    },
    async (request, reply) => {
      const params = accountParams.safeParse(request.params);
      const parsed = resetPasswordBody.safeParse(request.body);
      if (!params.success || !parsed.success) {
        throw new AppError(400, 'INVALID_INPUT', 'Payload reset password tidak valid.');
      }
      const principal = request.authSession?.principal;
      if (!principal)
        throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau telah berakhir.');
      const result = await options.service.resetPassword(
        principal,
        params.data.accountId,
        parsed.data.temporaryPassword,
        requestContext(request),
      );
      setNoStore(reply);
      return result;
    },
  );
}

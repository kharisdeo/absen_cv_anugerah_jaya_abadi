import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { readSignedSessionCookie, SESSION_COOKIE_NAME } from './postgres-smoke-cookie.js';

const COOKIE_SECRET = 'postgres-smoke-cookie-test-secret';
const SESSION_TOKEN = 'postgres-smoke-session-token';

function requireCookieCheck(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function issueSessionCookie() {
  const app = Fastify();
  await app.register(cookie, { secret: COOKIE_SECRET });
  app.get('/cookie', async (_request, reply) =>
    reply
      .setCookie(SESSION_COOKIE_NAME, SESSION_TOKEN, {
        signed: true,
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
      })
      .send({ status: 'ok' }),
  );
  const response = await app.inject({ method: 'GET', url: '/cookie' });
  return { app, setCookie: response.headers['set-cookie'] };
}

describe('PostgreSQL smoke session-cookie verifier', () => {
  it('uses the installed Fastify cookie signer and returns its verified unsigned value', async () => {
    const { app, setCookie } = await issueSessionCookie();
    try {
      const verified = readSignedSessionCookie(setCookie, app, requireCookieCheck);
      expect(verified.token).toBe(SESSION_TOKEN);
      expect(verified.cookie).toMatch(/^absen_session=/);
    } finally {
      await app.close();
    }
  });

  it('rejects a session cookie whose signed value was tampered with', async () => {
    const { app, setCookie } = await issueSessionCookie();
    try {
      const originalHeader = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
      const pair = originalHeader.split(';', 1)[0]!;
      const signedValue = app.parseCookie(pair)[SESSION_COOKIE_NAME]!;
      const tamperedValue = `${signedValue[0] === 'A' ? 'B' : 'A'}${signedValue.slice(1)}`;
      const tamperedHeader = originalHeader.replace(
        pair,
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(tamperedValue)}`,
      );

      expect(() => readSignedSessionCookie(tamperedHeader, app, requireCookieCheck)).toThrow(
        'Session cookie signature must be valid.',
      );
    } finally {
      await app.close();
    }
  });

  it('continues to require the expected cookie name and security attributes', async () => {
    const { app, setCookie } = await issueSessionCookie();
    try {
      const header = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
      expect(() =>
        readSignedSessionCookie(
          header.replace('absen_session=', 'other='),
          app,
          requireCookieCheck,
        ),
      ).toThrow('Login must set exactly one expected session cookie.');
      expect(() =>
        readSignedSessionCookie(header.replace('; HttpOnly', ''), app, requireCookieCheck),
      ).toThrow('Session cookie must be HttpOnly.');
      expect(() =>
        readSignedSessionCookie(
          header.replace('SameSite=Strict', 'SameSite=Lax'),
          app,
          requireCookieCheck,
        ),
      ).toThrow('Session cookie must use SameSite=Strict.');
      expect(() =>
        readSignedSessionCookie(header.replace('Path=/', 'Path=/auth'), app, requireCookieCheck),
      ).toThrow('Session cookie must use Path=/.');
    } finally {
      await app.close();
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerApiHttpSecurity } from '../src/plugins/http-security.js';

const APP_ORIGIN = 'https://attendance.example.test';

describe('API CORS boundary', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function buildCorsApp(allowedOrigin: string | undefined): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    registerApiHttpSecurity(instance, allowedOrigin);
    instance.get('/resource', async () => ({ ok: true }));
    return instance;
  }

  it('allows only the exact configured origin with credentials and Vary: Origin', async () => {
    app = await buildCorsApp(APP_ORIGIN);

    const response = await app.inject({
      method: 'GET',
      url: '/resource',
      headers: { origin: APP_ORIGIN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
    expect(response.headers.vary?.toLowerCase().split(/,\s*/)).toContain('origin');
  });

  it('does not grant CORS access to a foreign origin or when APP_ORIGIN is absent', async () => {
    app = await buildCorsApp(APP_ORIGIN);

    const foreign = await app.inject({
      method: 'GET',
      url: '/resource',
      headers: { origin: 'https://attacker.example.test' },
    });
    expect(foreign.statusCode).toBe(200);
    expect(
      Object.keys(foreign.headers).filter((name) => name.startsWith('access-control-allow-')),
    ).toHaveLength(0);

    const noOrigin = await app.inject({ method: 'GET', url: '/resource' });
    expect(noOrigin.statusCode).toBe(200);
    expect(
      Object.keys(noOrigin.headers).filter((name) => name.startsWith('access-control-allow-')),
    ).toHaveLength(0);

    await app.close();
    app = await buildCorsApp(undefined);
    const unconfigured = await app.inject({
      method: 'GET',
      url: '/resource',
      headers: { origin: APP_ORIGIN },
    });
    expect(unconfigured.statusCode).toBe(200);
    expect(
      Object.keys(unconfigured.headers).filter((name) => name.startsWith('access-control-allow-')),
    ).toHaveLength(0);
  });

  it('answers a valid credentialed preflight for supported API method and header', async () => {
    app = await buildCorsApp(APP_ORIGIN);

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/resource',
      headers: {
        origin: APP_ORIGIN,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']).toBe('GET, POST, PATCH, PUT, DELETE');
    expect(response.headers['access-control-allow-headers']).toBe('Content-Type');
    expect(response.headers.vary?.toLowerCase().split(/,\s*/)).toEqual(
      expect.arrayContaining([
        'origin',
        'access-control-request-method',
        'access-control-request-headers',
      ]),
    );
  });

  it.each([
    {
      label: 'foreign origin',
      origin: 'https://attacker.example.test',
      method: 'POST',
      headers: 'content-type',
    },
    { label: 'unsupported method', origin: APP_ORIGIN, method: 'TRACE', headers: 'content-type' },
    { label: 'unsupported header', origin: APP_ORIGIN, method: 'POST', headers: 'x-custom-token' },
  ])('rejects preflight with $label without Access-Control-Allow-* headers', async (input) => {
    app = await buildCorsApp(APP_ORIGIN);

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/resource',
      headers: {
        origin: input.origin,
        'access-control-request-method': input.method,
        'access-control-request-headers': input.headers,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(
      Object.keys(response.headers).filter((name) => name.startsWith('access-control-allow-')),
    ).toHaveLength(0);
  });
});

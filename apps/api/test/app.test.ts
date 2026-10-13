import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp, loggerRedactions } from '../src/app.js';
import { env } from '../src/config/env.js';

const initialAppVersion = env.APP_VERSION;

describe('API foundation', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    env.APP_VERSION = initialAppVersion;
  });

  it('serves the versioned health endpoint with its configured identifier and without a database dependency', async () => {
    env.APP_VERSION = 'v1.2.3-rc.1+build.7';
    app = await buildApp({ logger: false });

    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['x-app-version']).toBe('v1.2.3-rc.1+build.7');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers.vary).toContain('Origin');
  });

  it('omits the version header when APP_VERSION is unset and preserves the generic health body', async () => {
    env.APP_VERSION = undefined;
    app = await buildApp({ logger: false });

    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-app-version']).toBeUndefined();
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns a no-store readiness response when the database probe succeeds', async () => {
    const readiness = vi.fn(async () => undefined);
    app = await buildApp({ logger: false, readiness });

    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(readiness).toHaveBeenCalledOnce();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers.vary).toContain('Origin');
  });

  it('fails readiness closed with a generic no-store response when no database probe exists', async () => {
    app = await buildApp({ logger: false });

    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('hides readiness query errors and leaves liveness independent', async () => {
    const sensitiveError = 'postgresql://probe_user:probe-password@db.internal.example/attendance';
    const readiness = vi.fn(async () => {
      throw new Error(sensitiveError);
    });
    app = await buildApp({ logger: false, readiness });

    const ready = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'unavailable' });
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(ready.body).not.toContain(sensitiveError);
    expect(ready.body).not.toContain('probe-password');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    expect(readiness).toHaveBeenCalledOnce();
  });

  it('returns the standard problem response for unknown routes', async () => {
    app = await buildApp({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/does-not-exist?token=private',
    });
    const body: unknown = response.json();

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(body).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
      instance: '/api/v1/does-not-exist',
    });
    expect(JSON.stringify(body)).not.toContain('private');
  });

  it('applies baseline security headers to error responses', async () => {
    app = await buildApp({ logger: false });
    app.get('/api/v1/test-error', async () => {
      throw new Error('expected test failure');
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/test-error' });

    expect(response.statusCode).toBe(500);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('redacts sensitive sentinels through Pino using the application redaction paths', async () => {
    const loggerOutput: string[] = [];
    app = await buildApp({
      logger: {
        level: 'info',
        redact: { paths: [...loggerRedactions], censor: '[REDACTED]' },
        stream: { write: (line) => loggerOutput.push(line) },
      },
    });
    app.log.info(
      {
        auth: { password: 'redaction-password-sentinel' },
        session: { token: 'redaction-token-sentinel' },
        req: { headers: { cookie: 'redaction-cookie-sentinel' } },
        attendance: {
          location: { latitude: -6.2, longitude: 106.8 },
          selfie: { referenceId: 'redaction-selfie-sentinel' },
          uploadUrl: 'https://storage.example.test/redaction-upload-sentinel',
        },
      },
      'redaction regression probe',
    );
    const output = loggerOutput.join('');

    expect(output).toContain('redaction regression probe');
    expect(output).toContain('[REDACTED]');
    for (const sentinel of [
      'redaction-password-sentinel',
      'redaction-token-sentinel',
      'redaction-cookie-sentinel',
      'redaction-selfie-sentinel',
      'redaction-upload-sentinel',
      '106.8',
    ]) {
      expect(output).not.toContain(sentinel);
    }
  });

  it('redacts sensitive sentinels with the default buildApp Pino logger', async () => {
    const originalLogLevel = env.LOG_LEVEL;
    const loggerOutput: string[] = [];
    const stdoutWriteSpy = vi.spyOn(process.stdout, 'write');

    try {
      env.LOG_LEVEL = 'info';
      stdoutWriteSpy.mockImplementation((chunk) => {
        loggerOutput.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });

      app = await buildApp();
      app.log.info(
        {
          auth: { password: 'default-redaction-password-sentinel' },
          session: { token: 'default-redaction-token-sentinel' },
          req: {
            headers: { cookie: 'default-redaction-cookie-sentinel' },
            remoteAddress: '198.51.100.42',
          },
          attendance: {
            location: { latitude: -6.200123, longitude: 106.800987 },
            selfie: {
              photoBase64: 'default-redaction-raw-photo-sentinel',
              url: 'https://storage.example.test/default-redaction-selfie-sentinel',
            },
            uploadUrl: 'https://storage.example.test/default-redaction-upload-sentinel',
          },
          principal: {
            employeeId: 'default-redaction-employee-id-sentinel',
            userAccountId: 'default-redaction-account-id-sentinel',
            username: 'default-redaction-username-sentinel',
            fullName: 'default-redaction-full-name-sentinel',
            nik: 'default-redaction-nik-sentinel',
            email: 'default-redaction-email-sentinel',
            phone: 'default-redaction-phone-sentinel',
            clientIp: '198.51.100.42',
          },
        },
        'default app logger redaction regression probe',
      );
      const output = loggerOutput.join('');
      const sentinels = [
        'default-redaction-password-sentinel',
        'default-redaction-token-sentinel',
        'default-redaction-cookie-sentinel',
        '-6.200123',
        '106.800987',
        'default-redaction-raw-photo-sentinel',
        'default-redaction-selfie-sentinel',
        'default-redaction-upload-sentinel',
        'default-redaction-employee-id-sentinel',
        'default-redaction-account-id-sentinel',
        'default-redaction-username-sentinel',
        'default-redaction-full-name-sentinel',
        'default-redaction-nik-sentinel',
        'default-redaction-email-sentinel',
        'default-redaction-phone-sentinel',
        '198.51.100.42',
      ];
      expect(output).toContain('default app logger redaction regression probe');
      expect(output).toContain('[REDACTED]');
      for (const sentinel of sentinels) expect(output).not.toContain(sentinel);
    } finally {
      try {
        await app?.close();
      } finally {
        app = undefined;
        try {
          stdoutWriteSpy.mockRestore();
        } finally {
          env.LOG_LEVEL = originalLogLevel;
        }
      }
    }
  });
});

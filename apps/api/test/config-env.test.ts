import { afterEach, describe, expect, it, vi } from 'vitest';

// Keep config tests isolated from any developer-owned repository .env file.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      String(path).toLowerCase().endsWith('.env') ? false : actual.existsSync(path),
  };
});

const secureProductionEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://attendance:test@127.0.0.1:5432/attendance',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  APP_ORIGIN: 'https://attendance.example.test',
  APP_VERSION: undefined,
  LOG_LEVEL: '',
  TIMEZONE: '',
  CONSENT_POLICY_VERSION: '',
  CONSENT_POLICY_TEXT: '',
  STORAGE_ENDPOINT: '',
  STORAGE_BUCKET: '',
  STORAGE_ACCESS_KEY: '',
  STORAGE_SECRET_KEY: '',
  STORAGE_REGION: '',
  NOTIFICATION_PROVIDER: '',
  NOTIFICATION_CREDENTIALS: '',
  FEATURE_FLAGS: '',
};

async function loadEnvironment(overrides: Readonly<Record<string, string | undefined>> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...secureProductionEnvironment, ...overrides })) {
    vi.stubEnv(key, value);
  }
  return import('../src/config/env.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('runtime environment security validation', () => {
  it.each(['staging', 'production'] as const)('accepts secure settings in %s', async (NODE_ENV) => {
    const { env } = await loadEnvironment({ NODE_ENV });

    expect(env.NODE_ENV).toBe(NODE_ENV);
    expect(env.DATABASE_URL).toMatch(/^postgresql:/);
    expect(env.SESSION_SECRET).toHaveLength(32);
    expect(new Set(env.SESSION_SECRET).size).toBeGreaterThanOrEqual(16);
    expect(env.APP_ORIGIN).toBe('https://attendance.example.test');
  });

  it('treats blank optional values as unset in development', async () => {
    const { env } = await loadEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: '',
      SESSION_SECRET: '',
      APP_ORIGIN: '',
      TIMEZONE: '',
      FEATURE_FLAGS: '',
      STORAGE_ENDPOINT: '',
      STORAGE_BUCKET: '',
      STORAGE_ACCESS_KEY: '',
      STORAGE_SECRET_KEY: '',
    });

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.APP_ORIGIN).toBe('http://localhost:5173');
    expect(env.TIMEZONE).toBe('Asia/Jakarta');
    expect(env.FEATURE_FLAGS).toEqual({});
    expect(env.STORAGE_BUCKET).toBeUndefined();
  });

  it('defaults an empty TIMEZONE to Asia/Jakarta', async () => {
    const { env } = await loadEnvironment({ TIMEZONE: '' });

    expect(env.TIMEZONE).toBe('Asia/Jakarta');
  });

  it('accepts explicit Asia/Jakarta TIMEZONE', async () => {
    const { env } = await loadEnvironment({ TIMEZONE: 'Asia/Jakarta' });

    expect(env.TIMEZONE).toBe('Asia/Jakarta');
  });

  it('rejects a valid non-default IANA TIMEZONE with a safe diagnostic', async () => {
    const nonDefaultTimezone = 'America/New_York';
    let failure: unknown;

    try {
      await loadEnvironment({ TIMEZONE: nonDefaultTimezone });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const diagnostic = (failure as Error).message;
    expect(diagnostic).toContain('TIMEZONE: must be Asia/Jakarta per PRD NFR-07');
    expect(diagnostic).not.toContain(nonDefaultTimezone);
  });

  it('accepts an HTTPS application origin in production', async () => {
    const { env } = await loadEnvironment();

    expect(env.APP_ORIGIN).toBe('https://attendance.example.test');
  });

  it('leaves APP_VERSION unset when no build identifier is configured', async () => {
    const { env } = await loadEnvironment();

    expect(env.APP_VERSION).toBeUndefined();
  });

  it('accepts a safe semver-style APP_VERSION', async () => {
    const { env } = await loadEnvironment({ APP_VERSION: 'v1.2.3-rc.1+build.7' });

    expect(env.APP_VERSION).toBe('v1.2.3-rc.1+build.7');
  });

  it.each([
    ['empty', ''],
    ['control characters', 'release\r\nX-App-Version: injected'],
    ['overlong', 'a'.repeat(129)],
    ['spaces', 'release candidate'],
  ])('rejects an APP_VERSION with %s', async (_case, APP_VERSION) => {
    await expect(loadEnvironment({ APP_VERSION })).rejects.toThrow(
      /APP_VERSION: must be a 1-128 character ASCII identifier/,
    );
  });

  it.each(['staging', 'production'] as const)('requires DATABASE_URL in %s', async (NODE_ENV) => {
    await expect(loadEnvironment({ NODE_ENV, DATABASE_URL: '' })).rejects.toThrow(
      /DATABASE_URL: is required in staging and production/,
    );
  });

  for (const NODE_ENV of ['staging', 'production'] as const) {
    it.each([
      ['missing', ''],
      ['too short', '0123456789abcdef0123456789abcde'],
      ['low diversity', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ] as const)(`rejects a %s SESSION_SECRET in ${NODE_ENV}`, async (_case, SESSION_SECRET) => {
      await expect(loadEnvironment({ NODE_ENV, SESSION_SECRET })).rejects.toThrow(
        /SESSION_SECRET: (?:is required in staging and production|must contain at least 32 characters and at least 16 distinct characters in staging\/production)/,
      );
    });

    it.each([
      ['version without policy text', { CONSENT_POLICY_VERSION: '2026-10' }],
      ['policy text without version', { CONSENT_POLICY_TEXT: 'Attendance consent policy' }],
    ] as const)(
      `rejects consent policy configuration with %s in ${NODE_ENV}`,
      async (_case, overrides) => {
        await expect(loadEnvironment({ NODE_ENV, ...overrides })).rejects.toThrow(
          /CONSENT_POLICY_VERSION: CONSENT_POLICY_VERSION and CONSENT_POLICY_TEXT must be configured together/,
        );
      },
    );
  }

  it.each([
    ['plain HTTP', 'http://attendance.example.test', /APP_ORIGIN: must use https:\/\//],
    ['a path', 'https://attendance.example.test/app', /APP_ORIGIN: must be an origin/],
    ['credentials', 'https://user:secret@attendance.example.test', /APP_ORIGIN: must be an origin/],
    ['a query', 'https://attendance.example.test?next=/', /APP_ORIGIN: must be an origin/],
  ])('rejects a production APP_ORIGIN containing %s', async (_case, APP_ORIGIN, expectedError) => {
    await expect(loadEnvironment({ APP_ORIGIN })).rejects.toThrow(expectedError);
  });

  it.each([
    ['a non-HTTP scheme', 'file:///etc/passwd'],
    ['URL credentials', 'https://user:secret@s3.example.test'],
    ['a fragment', 'https://s3.example.test/#bucket'],
  ])('rejects storage endpoint configuration containing %s', async (_case, STORAGE_ENDPOINT) => {
    await expect(loadEnvironment({ STORAGE_ENDPOINT })).rejects.toThrow(/STORAGE_ENDPOINT/);
  });

  it('does not echo sentinel secrets or policy values in validation diagnostics', async () => {
    const sentinels = {
      databasePassword: 'SENTINEL_DATABASE_PASSWORD',
      sessionSecret: 'SENTINEL_SESSION_SECRET',
      originPassword: 'SENTINEL_ORIGIN_PASSWORD',
      storageAccessKey: 'SENTINEL_STORAGE_ACCESS_KEY',
      storageSecretKey: 'SENTINEL_STORAGE_SECRET_KEY',
      consentPolicyText: 'SENTINEL_CONSENT_POLICY_TEXT',
    } as const;
    let failure: unknown;

    try {
      await loadEnvironment({
        DATABASE_URL: `mysql://user:${sentinels.databasePassword}@db.example.test/attendance`,
        SESSION_SECRET: sentinels.sessionSecret,
        APP_ORIGIN: `https://user:${sentinels.originPassword}@attendance.example.test`,
        STORAGE_BUCKET: 'attendance-private',
        STORAGE_ACCESS_KEY: sentinels.storageAccessKey,
        STORAGE_SECRET_KEY: sentinels.storageSecretKey,
        CONSENT_POLICY_TEXT: sentinels.consentPolicyText,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const diagnostic = (failure as Error).message;
    expect(diagnostic).toContain('Invalid environment configuration:');
    for (const sentinel of Object.values(sentinels)) {
      expect(diagnostic).not.toContain(sentinel);
    }
  });
});

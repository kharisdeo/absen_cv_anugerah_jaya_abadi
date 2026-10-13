import { describe, expect, it } from 'vitest';
import { resolveDemoSeedConfiguration, safeDemoSeedFailureMessage } from '../prisma/seed-policy.js';

const databasePasswordForTest = Buffer.alloc(32, 0xa7).toString('hex');

function databaseUrlForTest(update: (url: URL) => void = () => {}): string {
  const url = new URL(
    `postgresql://absen_local:${databasePasswordForTest}@127.0.0.1:5433/absen_local_demo?schema=public`,
  );
  update(url);
  return url.toString();
}

const validEnvironment = {
  NODE_ENV: 'development',
  SEED_DEMO_DATA: 'true',
  DATABASE_URL: databaseUrlForTest(),
  DEMO_ADMIN_1_PASSWORD: String.fromCharCode(65).repeat(24),
  DEMO_ADMIN_2_PASSWORD: String.fromCharCode(68).repeat(24),
  DEMO_SUPERVISOR_PASSWORD: String.fromCharCode(66).repeat(24),
  DEMO_EMPLOYEE_PASSWORD: String.fromCharCode(67).repeat(24),
};

const invalidDatabaseUrls = [
  databaseUrlForTest((url) => {
    url.hostname = 'database.example';
  }),
  databaseUrlForTest((url) => {
    url.port = '5432';
  }),
  databaseUrlForTest((url) => {
    url.pathname = '/another_database';
  }),
  databaseUrlForTest((url) => {
    url.username = 'another_user';
  }),
  databaseUrlForTest((url) => {
    url.searchParams.set('host', 'database.example');
  }),
  databaseUrlForTest((url) => {
    url.searchParams.set('sslmode', 'require');
  }),
];

describe('demo seed configuration safety', () => {
  it('accepts explicit local development configuration', () => {
    expect(resolveDemoSeedConfiguration(validEnvironment)).toMatchObject({
      databaseUrl: validEnvironment.DATABASE_URL,
      adminOnePassword: validEnvironment.DEMO_ADMIN_1_PASSWORD,
      adminTwoPassword: validEnvironment.DEMO_ADMIN_2_PASSWORD,
    });
  });

  it('rejects production and staging even with seed opt-in', () => {
    expect(() =>
      resolveDemoSeedConfiguration({ ...validEnvironment, NODE_ENV: 'production' }),
    ).toThrow(/development atau NODE_ENV=test/);
    expect(() =>
      resolveDemoSeedConfiguration({ ...validEnvironment, NODE_ENV: 'staging' }),
    ).toThrow(/development atau NODE_ENV=test/);
  });

  it('requires exact explicit opt-in', () => {
    expect(() =>
      resolveDemoSeedConfiguration({ ...validEnvironment, SEED_DEMO_DATA: '1' }),
    ).toThrow(/SEED_DEMO_DATA=true/);
  });

  it.each(invalidDatabaseUrls)(
    'rejects a database URL outside the Compose target',
    (databaseUrl) => {
      expect(() =>
        resolveDemoSeedConfiguration({ ...validEnvironment, DATABASE_URL: databaseUrl }),
      ).toThrow(/hanya menerima/);
    },
  );

  it('requires four distinct, strong local-only demo passwords', () => {
    expect(() =>
      resolveDemoSeedConfiguration({ ...validEnvironment, DEMO_EMPLOYEE_PASSWORD: 'short' }),
    ).toThrow(/16–1.024/);
    expect(() =>
      resolveDemoSeedConfiguration({
        ...validEnvironment,
        DEMO_ADMIN_2_PASSWORD: validEnvironment.DEMO_ADMIN_1_PASSWORD,
      }),
    ).toThrow(/password berbeda/);
    expect(() =>
      resolveDemoSeedConfiguration({
        ...validEnvironment,
        DEMO_EMPLOYEE_PASSWORD: validEnvironment.DEMO_ADMIN_1_PASSWORD,
      }),
    ).toThrow(/password berbeda/);
  });

  it('shows only safe local diagnostics for database failures', () => {
    const message = safeDemoSeedFailureMessage({
      code: 'P1001',
      message: 'postgresql://secret-user:do-not-print@remote.example:5432/prod',
      stack: 'stack containing credentials',
    });
    expect(message).toMatch(/PostgreSQL lokal tidak terjangkau/);
    expect(message).not.toMatch(/secret-user|do-not-print|remote\.example|stack containing/);
  });
});

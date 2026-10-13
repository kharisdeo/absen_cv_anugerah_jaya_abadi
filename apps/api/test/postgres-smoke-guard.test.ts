import { describe, expect, it } from 'vitest';
import { assertEphemeralDatabaseUrl } from './postgres-smoke-guard.js';

const exactEphemeralDatabaseUrl =
  'postgresql://absen_ci:ci-only-password@localhost:5432/absen_ci?schema=public';

const rejectedDatabaseUrls = [
  ['missing', ''],
  ['malformed', 'not a PostgreSQL URL'],
  ['malformed authority', 'postgresql://credential-user:credential-password@['],
  ['different hostname', exactEphemeralDatabaseUrl.replace('localhost', 'db.example.test')],
  ['loopback IP address', exactEphemeralDatabaseUrl.replace('localhost', '127.0.0.1')],
  ['different username', exactEphemeralDatabaseUrl.replace('absen_ci:', 'credential-user:')],
  [
    'different password',
    exactEphemeralDatabaseUrl.replace('ci-only-password', 'credential-password'),
  ],
  ['different port', exactEphemeralDatabaseUrl.replace(':5432/', ':5433/')],
  ['different database', exactEphemeralDatabaseUrl.replace('/absen_ci?', '/other_database?')],
  ['different schema', exactEphemeralDatabaseUrl.replace('schema=public', 'schema=private')],
  ['extra query parameter', `${exactEphemeralDatabaseUrl}&sslmode=require`],
  ['duplicate query parameter', `${exactEphemeralDatabaseUrl}&schema=public`],
  ['fragment', `${exactEphemeralDatabaseUrl}#fragment`],
  ['encoded username', exactEphemeralDatabaseUrl.replace('absen_ci:', '%61bsen_ci:')],
  ['encoded password', exactEphemeralDatabaseUrl.replace('ci-only-password', 'ci-only%2Dpassword')],
  ['encoded schema', exactEphemeralDatabaseUrl.replace('schema=public', 'schema=%70ublic')],
  ['trailing whitespace', `${exactEphemeralDatabaseUrl} `],
] as const;

describe('PostgreSQL smoke database URL guard', () => {
  it('accepts only the exact ephemeral CI database URL', () => {
    expect(() => assertEphemeralDatabaseUrl(exactEphemeralDatabaseUrl)).not.toThrow();
  });

  it.each(rejectedDatabaseUrls)('rejects %s without echoing URL credentials', (_case, url) => {
    let failure: unknown;
    try {
      assertEphemeralDatabaseUrl(url);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const diagnostic = (failure as Error).message;
    if (url.length > 0) expect(diagnostic).not.toContain(url);
    expect(diagnostic).not.toContain('credential-user');
    expect(diagnostic).not.toContain('credential-password');
    expect(diagnostic).not.toContain('absen_ci');
    expect(diagnostic).not.toContain('ci-only-password');
  });
});

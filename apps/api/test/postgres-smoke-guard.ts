const EXPECTED_DATABASE_URL =
  'postgresql://absen_ci:ci-only-password@localhost:5432/absen_ci?schema=public';
export const EXPECTED_DATABASE_NAME = 'absen_ci';
export const EXPECTED_DATABASE_USER = 'absen_ci';

export class SmokeCheckError extends Error {}

function requireCheck(condition: boolean, message: string): asserts condition {
  if (!condition) throw new SmokeCheckError(message);
}

export function assertEphemeralDatabaseUrl(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new SmokeCheckError(
      'DATABASE_URL must target the exact ephemeral CI PostgreSQL database.',
    );
  }

  const queryEntries = [...parsed.searchParams.entries()];
  requireCheck(
    databaseUrl === EXPECTED_DATABASE_URL &&
      parsed.protocol === 'postgresql:' &&
      parsed.username === EXPECTED_DATABASE_USER &&
      parsed.password === 'ci-only-password' &&
      parsed.hostname === 'localhost' &&
      parsed.port === '5432' &&
      parsed.pathname === `/${EXPECTED_DATABASE_NAME}` &&
      parsed.hash === '' &&
      queryEntries.length === 1 &&
      queryEntries[0]?.[0] === 'schema' &&
      queryEntries[0]?.[1] === 'public',
    'DATABASE_URL must target the exact ephemeral CI PostgreSQL database.',
  );
}

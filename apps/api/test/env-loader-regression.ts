import { equal, notEqual, ok } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type RuntimeSummary = {
  nodeEnv: string;
  appVersion: string | null;
  databaseProtocol: string | null;
  sessionSecretLength: number;
  sessionSecretUniqueCharacters: number;
  appOriginProtocol: string | null;
  databaseConfigured: boolean;
  sessionSecretConfigured: boolean;
  featureFlagCount: number;
  storageConfigured: boolean;
  timezone: string;
};

type Target = {
  name: 'source' | 'dist' | 'prisma-config';
  path: string;
  needsTypeScriptLoader: boolean;
};

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(apiRoot, '../..');
const expectedRootEnvPath = resolve(workspaceRoot, '.env');
const targets: Target[] = [
  {
    name: 'source',
    path: join(apiRoot, 'src', 'config', 'env.ts'),
    needsTypeScriptLoader: true,
  },
  {
    name: 'dist',
    path: join(apiRoot, 'dist', 'config', 'env.js'),
    needsTypeScriptLoader: false,
  },
];

const syntheticSessionSecret = 'SYNTHETIC_ONLY_0123456789abcdefghijklmnopqrstuvwxyz';
const syntheticDatabaseUrl =
  'postgresql://fixture_user:fixture_password@127.0.0.1:5432/fixture_database?schema=public';
const syntheticOrigin = 'https://attendance.example.test';
const summaryMarker = 'AUDIT_ENV_SUMMARY=';
const prismaSummaryMarker = 'AUDIT_PRISMA_SUMMARY=';
const childProgram = `
  const { env } = await import(process.env.AUDIT_ENV_TARGET);
  const summary = {
    nodeEnv: env.NODE_ENV,
    appVersion: env.APP_VERSION ?? null,
    databaseProtocol: env.DATABASE_URL ? new URL(env.DATABASE_URL).protocol : null,
    sessionSecretLength: env.SESSION_SECRET?.length ?? 0,
    sessionSecretUniqueCharacters: env.SESSION_SECRET ? new Set(env.SESSION_SECRET).size : 0,
    appOriginProtocol: env.APP_ORIGIN ? new URL(env.APP_ORIGIN).protocol : null,
    databaseConfigured: env.DATABASE_URL !== undefined,
    sessionSecretConfigured: env.SESSION_SECRET !== undefined,
    featureFlagCount: Object.keys(env.FEATURE_FLAGS).length,
    storageConfigured: env.STORAGE_BUCKET !== undefined,
    timezone: env.TIMEZONE,
  };
  process.stdout.write(${JSON.stringify(summaryMarker)} + JSON.stringify(summary) + '\\n');
`;
const prismaConfigProgram = `
  const { default: config } = await import(process.env.AUDIT_ENV_TARGET);
  const configuredUrl = config.datasource?.url;
  const summary = {
    fixtureLoaded: process.env.AUDIT_SYNTHETIC_PRISMA_FIXTURE === 'loaded',
    shellDatabaseSelected: configuredUrl === process.env.AUDIT_EXPECTED_SHELL_DATABASE_URL,
    databaseProtocol: typeof configuredUrl === 'string' ? new URL(configuredUrl).protocol : null,
  };
  process.stdout.write(${JSON.stringify(prismaSummaryMarker)} + JSON.stringify(summary) + '\\n');
`;

const preloadSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const workspaceRoot = path.resolve(process.env.AUDIT_WORKSPACE_ROOT);
const expectedRootEnvPath = path.resolve(process.env.AUDIT_EXPECTED_ROOT_ENV);
const syntheticFixturePath = path.resolve(process.env.AUDIT_SYNTHETIC_ENV_FIXTURE);
const nativeExistsSync = fs.existsSync.bind(fs);
const nativeLoadEnvFile = process.loadEnvFile.bind(process);

function isInsideWorkspace(candidatePath) {
  const fromWorkspace = path.relative(workspaceRoot, candidatePath);
  return fromWorkspace === '' || (
    fromWorkspace !== '..' &&
    !fromWorkspace.startsWith('..' + path.sep) &&
    !path.isAbsolute(fromWorkspace)
  );
}

function isWorkspaceEnvFile(candidate) {
  if (typeof candidate !== 'string' && !Buffer.isBuffer(candidate)) return false;
  const candidatePath = path.resolve(String(candidate));
  return path.basename(candidatePath) === '.env' && isInsideWorkspace(candidatePath);
}

fs.existsSync = function (candidate, ...args) {
  if (isWorkspaceEnvFile(candidate)) {
    return path.resolve(String(candidate)) === expectedRootEnvPath;
  }
  return nativeExistsSync(candidate, ...args);
};

process.loadEnvFile = function (candidate, ...args) {
  if (candidate === undefined) {
    throw new Error('Implicit .env loading is forbidden in this isolated regression test');
  }
  if (isWorkspaceEnvFile(candidate)) {
    if (path.resolve(String(candidate)) !== expectedRootEnvPath) {
      throw new Error('Unexpected repository .env path in isolated regression test');
    }
    return nativeLoadEnvFile(syntheticFixturePath, ...args);
  }
  return nativeLoadEnvFile(candidate, ...args);
};

syncBuiltinESMExports();
`;

function encodeEnvFile(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

function childEnvironment(
  fixturePath: string,
  target: Target,
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT'] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }

  Object.assign(environment, overrides, {
    AUDIT_WORKSPACE_ROOT: workspaceRoot,
    AUDIT_EXPECTED_ROOT_ENV: expectedRootEnvPath,
    AUDIT_SYNTHETIC_ENV_FIXTURE: fixturePath,
    AUDIT_ENV_TARGET: pathToFileURL(target.path).href,
  });
  return environment;
}

function runTarget(
  target: Target,
  preloadPath: string,
  fixturePath: string,
  values: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>> = {},
  program = childProgram,
) {
  writeFileSync(fixturePath, encodeEnvFile(values), { encoding: 'utf8', mode: 0o600 });
  const args = [
    '--require',
    preloadPath,
    ...(target.needsTypeScriptLoader ? ['--import', 'tsx'] : []),
    '--input-type=module',
    '--eval',
    program,
  ];
  return spawnSync(process.execPath, args, {
    cwd: apiRoot,
    env: childEnvironment(fixturePath, target, overrides),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}

function verifyPrismaConfig(preloadPath: string, fixturePath: string): void {
  const target: Target = {
    name: 'prisma-config',
    path: join(apiRoot, 'prisma.config.ts'),
    needsTypeScriptLoader: true,
  };
  const shellDatabaseUrl =
    'postgresql://shell_user:shell_password@127.0.0.1:5432/shell_database?schema=public';
  const result = runTarget(
    target,
    preloadPath,
    fixturePath,
    {
      DATABASE_URL: syntheticDatabaseUrl,
      AUDIT_SYNTHETIC_PRISMA_FIXTURE: 'loaded',
    },
    {
      DATABASE_URL: shellDatabaseUrl,
      AUDIT_EXPECTED_SHELL_DATABASE_URL: shellDatabaseUrl,
    },
    prismaConfigProgram,
  );

  if (result.error) throw new Error('Prisma config fixture: child process failed to launch');
  equal(result.status, 0, 'Prisma config should import without connecting to a database');
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith(prismaSummaryMarker));
  ok(line, 'Prisma config should return a safe isolated summary');
  const summary = JSON.parse(line.slice(prismaSummaryMarker.length)) as {
    fixtureLoaded: boolean;
    shellDatabaseSelected: boolean;
    databaseProtocol: string | null;
  };
  equal(summary.fixtureLoaded, true, 'Prisma config should load the synthetic root-env fixture');
  equal(summary.shellDatabaseSelected, true, 'shell DATABASE_URL should override the fixture');
  equal(summary.databaseProtocol, 'postgresql:');
}

function readSummary(
  target: Target,
  scenario: string,
  result: ReturnType<typeof runTarget>,
): RuntimeSummary {
  if (result.error) throw new Error(`${target.name} ${scenario}: child process failed to launch`);
  equal(
    result.status,
    0,
    `${target.name} ${scenario}: startup should accept the synthetic fixture`,
  );
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith(summaryMarker));
  ok(line, `${target.name} ${scenario}: child process should return a safe summary`);
  return JSON.parse(line.slice(summaryMarker.length)) as RuntimeSummary;
}

function runRegression(): void {
  for (const target of targets) {
    if (!existsSync(target.path)) {
      throw new Error(
        `${target.name} config output is missing; compile apps/api before the env regression test`,
      );
    }
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'absen-env-regression-'));
  const fixturePath = join(temporaryDirectory, 'synthetic.env');
  const preloadPath = join(temporaryDirectory, 'isolate-env.cjs');

  try {
    writeFileSync(preloadPath, preloadSource, { encoding: 'utf8', mode: 0o600 });

    for (const target of targets) {
      for (const NODE_ENV of ['staging', 'production'] as const) {
        const summary = readSummary(
          target,
          NODE_ENV,
          runTarget(
            target,
            preloadPath,
            fixturePath,
            {
              NODE_ENV,
              DATABASE_URL: syntheticDatabaseUrl,
              SESSION_SECRET: syntheticSessionSecret,
              APP_ORIGIN: syntheticOrigin,
              APP_VERSION: 'fixture-version',
            },
            { APP_VERSION: 'shell-version' },
          ),
        );

        equal(summary.nodeEnv, NODE_ENV, `${target.name} should load NODE_ENV from the fixture`);
        equal(
          summary.appVersion,
          'shell-version',
          'shell values should take precedence over the fixture',
        );
        equal(summary.databaseProtocol, 'postgresql:');
        ok(
          summary.sessionSecretLength >= 32,
          'synthetic secure-runtime secret should meet length policy',
        );
        ok(
          summary.sessionSecretUniqueCharacters >= 16,
          'synthetic secure-runtime secret should meet character-diversity policy',
        );
        equal(summary.appOriginProtocol, 'https:');
      }

      const emptyOptionalSummary = readSummary(
        target,
        'empty optional values',
        runTarget(target, preloadPath, fixturePath, {
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
        }),
      );
      equal(emptyOptionalSummary.databaseConfigured, false);
      equal(emptyOptionalSummary.sessionSecretConfigured, false);
      equal(emptyOptionalSummary.appOriginProtocol, 'http:');
      equal(emptyOptionalSummary.featureFlagCount, 0);
      equal(emptyOptionalSummary.storageConfigured, false);
      equal(emptyOptionalSummary.timezone, 'Asia/Jakarta');

      for (const NODE_ENV of ['staging', 'production'] as const) {
        const result = runTarget(target, preloadPath, fixturePath, {
          NODE_ENV,
          DATABASE_URL: '',
          SESSION_SECRET: 'SYNTHETIC_WEAK_SESSION_SENTINEL',
          APP_ORIGIN: 'http://attendance.example.test',
        });
        notEqual(result.status, 0, `${target.name} ${NODE_ENV} must reject insecure settings`);
        const diagnostics = `${result.stdout}\n${result.stderr}`;
        ok(
          diagnostics.includes('DATABASE_URL:'),
          'startup diagnostic should identify missing DATABASE_URL',
        );
        ok(
          diagnostics.includes('SESSION_SECRET:'),
          'startup diagnostic should identify weak SESSION_SECRET',
        );
        ok(
          diagnostics.includes('APP_ORIGIN:'),
          'startup diagnostic should identify non-HTTPS APP_ORIGIN',
        );
        ok(
          !diagnostics.includes('SYNTHETIC_WEAK_SESSION_SENTINEL'),
          'startup diagnostics must not echo the synthetic secret value',
        );
      }
    }

    verifyPrismaConfig(preloadPath, fixturePath);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  process.stdout.write(
    'AUD-04 env regression passed: API source/dist; Prisma config; shell precedence; empty optionals; staging/production validation.\n',
  );
}

runRegression();

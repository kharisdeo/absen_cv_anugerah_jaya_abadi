import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load the repository-level .env for local development. Values already provided
// by the process environment take precedence, which keeps CI and deployments in
// control of their configuration.
const localEnvPath = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(localEnvPath)) {
  process.loadEnvFile(localEnvPath);
}

const emptyAsUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(emptyAsUndefined, z.string().trim().optional());

const optionalConsentText = z.preprocess(emptyAsUndefined, z.string().max(50_000).optional());

const optionalUrl = z.preprocess(emptyAsUndefined, z.string().trim().url().optional());
const optionalStorageEndpoint = optionalUrl.refine((value) => {
  if (value === undefined) return true;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}, 'must be an HTTP(S) S3-compatible endpoint without credentials or fragment');

const applicationOrigin = optionalUrl.refine((value) => {
  if (value === undefined) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === value &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}, 'must be an origin without a path, query, or credentials');

const optionalProvider = z.preprocess(
  emptyAsUndefined,
  z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'must be a provider identifier')
    .optional(),
);

const appVersionSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/,
    'must be a 1-128 character ASCII identifier using letters, digits, ., _, +, or -',
  )
  .optional();

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .default('Asia/Jakarta')
  .refine((timezone) => timezone === 'Asia/Jakarta', 'must be Asia/Jakarta per PRD NFR-07');

const databaseUrlSchema = optionalUrl.refine((databaseUrl) => {
  if (databaseUrl === undefined) return true;

  try {
    const protocol = new URL(databaseUrl).protocol;
    return protocol === 'postgres:' || protocol === 'postgresql:';
  } catch {
    return false;
  }
}, 'must use the postgres:// or postgresql:// protocol');

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    HOST: z.string().trim().min(1).optional(),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
    APP_VERSION: appVersionSchema,
    LOG_LEVEL: z.preprocess(
      emptyAsUndefined,
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
    ),
    TIMEZONE: z.preprocess(emptyAsUndefined, timezoneSchema),
    DATABASE_URL: databaseUrlSchema,
    APP_ORIGIN: applicationOrigin,
    SESSION_SECRET: optionalString,
    CONSENT_POLICY_VERSION: optionalString,
    CONSENT_POLICY_TEXT: optionalConsentText,
    STORAGE_ENDPOINT: optionalStorageEndpoint,
    STORAGE_BUCKET: optionalString,
    STORAGE_ACCESS_KEY: optionalString,
    STORAGE_SECRET_KEY: optionalString,
    STORAGE_REGION: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .trim()
        .regex(/^[a-z0-9-]{1,64}$/i)
        .optional(),
    ),
    NOTIFICATION_PROVIDER: optionalProvider,
    NOTIFICATION_CREDENTIALS: optionalString,
    SELFIE_RETENTION_MONTHS: z.coerce.number().int().min(1).default(12),
    SELFIE_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(300).default(120),
    FEATURE_FLAGS: z.preprocess((value) => {
      if (typeof value !== 'string') return value;
      const encodedFlags = value.trim();
      if (encodedFlags === '') return {};

      try {
        return JSON.parse(encodedFlags) as unknown;
      } catch {
        return value;
      }
    }, z.record(z.string(), z.boolean()).default({})),
  })
  .superRefine((configuration, context) => {
    if (
      (configuration.CONSENT_POLICY_VERSION === undefined) !==
      (configuration.CONSENT_POLICY_TEXT === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['CONSENT_POLICY_VERSION'],
        message: 'CONSENT_POLICY_VERSION and CONSENT_POLICY_TEXT must be configured together',
      });
    }

    const secureRuntime =
      configuration.NODE_ENV === 'staging' || configuration.NODE_ENV === 'production';
    if (secureRuntime) {
      if (configuration.DATABASE_URL === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'is required in staging and production',
        });
      }
      const secret = configuration.SESSION_SECRET;
      if (secret === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['SESSION_SECRET'],
          message: 'is required in staging and production',
        });
      } else if (secret.length < 32 || new Set(secret).size < 16) {
        context.addIssue({
          code: 'custom',
          path: ['SESSION_SECRET'],
          message:
            'must contain at least 32 characters and at least 16 distinct characters in staging/production',
        });
      }
      if (!configuration.APP_ORIGIN) {
        context.addIssue({
          code: 'custom',
          path: ['APP_ORIGIN'],
          message: 'is required in staging and production for CSRF origin validation',
        });
      } else if (new URL(configuration.APP_ORIGIN).protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          path: ['APP_ORIGIN'],
          message: 'must use https:// in staging and production',
        });
      }
    }

    const storageConfigured =
      configuration.STORAGE_ENDPOINT !== undefined ||
      configuration.STORAGE_BUCKET !== undefined ||
      configuration.STORAGE_ACCESS_KEY !== undefined ||
      configuration.STORAGE_SECRET_KEY !== undefined;
    if (storageConfigured) {
      for (const key of ['STORAGE_BUCKET', 'STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY'] as const) {
        if (configuration[key] === undefined) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required when storage configuration is supplied',
          });
        }
      }
    }

    if (
      configuration.NOTIFICATION_CREDENTIALS !== undefined &&
      configuration.NOTIFICATION_PROVIDER === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['NOTIFICATION_PROVIDER'],
        message: 'is required when notification credentials are supplied',
      });
    }
  });

const result = environmentSchema.safeParse(process.env);

if (!result.success) {
  const validationErrors = result.error.issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join('.') : 'environment';
    return `${key}: ${issue.message}`;
  });

  // Do not include input values in this error: configuration may contain secrets.
  throw new Error(`Invalid environment configuration:\n- ${validationErrors.join('\n- ')}`);
}

export const env = {
  ...result.data,
  STORAGE_REGION: result.data.STORAGE_REGION ?? 'us-east-1',
  // Keep local development/test listeners on loopback. Preserve the conventional
  // all-interface default for deployed runtimes, while honoring explicit HOST overrides.
  HOST:
    result.data.HOST ??
    (result.data.NODE_ENV === 'development' || result.data.NODE_ENV === 'test'
      ? '127.0.0.1'
      : '0.0.0.0'),
  APP_ORIGIN:
    result.data.APP_ORIGIN ??
    (result.data.NODE_ENV === 'development' ? 'http://localhost:5173' : undefined),
  LOG_LEVEL: result.data.LOG_LEVEL ?? (result.data.NODE_ENV === 'test' ? 'silent' : 'info'),
};

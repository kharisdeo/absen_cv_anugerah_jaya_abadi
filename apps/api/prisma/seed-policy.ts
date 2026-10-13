export type DemoSeedConfiguration = Readonly<{
  databaseUrl: string;
  adminOnePassword: string;
  adminTwoPassword: string;
  supervisorPassword: string;
  employeePassword: string;
}>;

export class DemoSeedConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoSeedConfigurationError';
  }
}

export class DemoSeedDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoSeedDataError';
  }
}

/** Return only a reviewed message or Prisma code; never expose a raw driver exception. */
export function safeDemoSeedFailureMessage(error: unknown): string {
  if (error instanceof DemoSeedConfigurationError || error instanceof DemoSeedDataError) {
    return error.message;
  }

  const code =
    error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  switch (code) {
    case 'P1000':
      return 'Database menolak autentikasi. Cocokkan POSTGRES_PASSWORD dan DATABASE_URL lokal.';
    case 'P1001':
      return 'PostgreSQL lokal tidak terjangkau. Jalankan pnpm db:start dan tunggu healthcheck.';
    case 'P1003':
      return 'Database demo tidak ditemukan. Pastikan Compose memakai database absen_local_demo.';
    case 'P2021':
      return 'Tabel belum tersedia. Jalankan pnpm db:migrate:dev sebelum seed.';
    case 'P2022':
      return 'Kolom database belum sesuai migration. Periksa pnpm db:migrate:status.';
    case 'P2002':
      return 'Konflik unique terdeteksi. Seed tidak menghapus atau mengambil alih record lain.';
    case 'P2003':
      return 'Relasi fixture tidak valid. Periksa bahwa migration lokal sudah diterapkan.';
    default:
      return 'Demo seed gagal. Periksa database/migration lokal; detail internal disembunyikan.';
  }
}

const expectedDatabaseUser = 'absen_local';
const expectedDatabaseHost = '127.0.0.1';
const expectedDatabasePort = '5433';
const expectedDatabaseName = '/absen_local_demo';

/** Fail closed before opening a connection unless this is the explicit local demo DB. */
export function resolveDemoSeedConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): DemoSeedConfiguration {
  if (environment.NODE_ENV !== 'development' && environment.NODE_ENV !== 'test') {
    throw new DemoSeedConfigurationError(
      'Demo seed hanya diizinkan pada NODE_ENV=development atau NODE_ENV=test.',
    );
  }
  if (environment.SEED_DEMO_DATA !== 'true') {
    throw new DemoSeedConfigurationError(
      'Demo seed tidak aktif. Tetapkan SEED_DEMO_DATA=true secara eksplisit di .env lokal.',
    );
  }

  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new DemoSeedConfigurationError('DATABASE_URL wajib menunjuk ke database demo lokal.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new DemoSeedConfigurationError('DATABASE_URL demo lokal tidak valid.');
  }

  const allowedQuery = [...parsedUrl.searchParams.entries()];
  const validQuery =
    allowedQuery.length === 0 ||
    (allowedQuery.length === 1 &&
      allowedQuery[0]?.[0] === 'schema' &&
      allowedQuery[0][1] === 'public');
  if (
    (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') ||
    parsedUrl.username !== expectedDatabaseUser ||
    parsedUrl.password.length === 0 ||
    parsedUrl.hostname !== expectedDatabaseHost ||
    parsedUrl.port !== expectedDatabasePort ||
    parsedUrl.pathname !== expectedDatabaseName ||
    parsedUrl.hash !== '' ||
    !validQuery
  ) {
    throw new DemoSeedConfigurationError(
      'Seeder hanya menerima postgresql://absen_local@127.0.0.1:5433/absen_local_demo dengan schema public opsional.',
    );
  }

  const passwords = {
    adminOnePassword: environment.DEMO_ADMIN_1_PASSWORD,
    adminTwoPassword: environment.DEMO_ADMIN_2_PASSWORD,
    supervisorPassword: environment.DEMO_SUPERVISOR_PASSWORD,
    employeePassword: environment.DEMO_EMPLOYEE_PASSWORD,
  };
  for (const password of Object.values(passwords)) {
    if (
      typeof password !== 'string' ||
      password.length < 16 ||
      password.length > 1024 ||
      Buffer.byteLength(password, 'utf8') > 4096
    ) {
      throw new DemoSeedConfigurationError(
        'Semua password demo wajib diisi dengan panjang 16–1.024 karakter.',
      );
    }
  }
  if (new Set(Object.values(passwords)).size !== Object.keys(passwords).length) {
    throw new DemoSeedConfigurationError('Gunakan password berbeda untuk setiap akun demo.');
  }

  return {
    databaseUrl,
    adminOnePassword: passwords.adminOnePassword as string,
    adminTwoPassword: passwords.adminTwoPassword as string,
    supervisorPassword: passwords.supervisorPassword as string,
    employeePassword: passwords.employeePassword as string,
  };
}

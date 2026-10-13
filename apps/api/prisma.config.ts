import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

// Match the API runtime: local repository values are loaded, but shell/CI wins.
const localEnvPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(localEnvPath)) {
  process.loadEnvFile(localEnvPath);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // Generation and validation do not need a live database. Migration commands
  // will fail clearly when no usable URL is supplied by the environment.
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});

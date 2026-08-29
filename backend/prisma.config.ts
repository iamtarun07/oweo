import 'dotenv/config';
import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer reads `url` from schema.prisma, and no longer auto-loads
// .env when this file exists — hence the dotenv import above.
// This URL is used by the CLI (migrate / db pull) only. The runtime client
// gets its connection from the driver adapter in src/infrastructure/database/prisma.ts.
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});

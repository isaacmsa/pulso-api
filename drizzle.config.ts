import { defineConfig } from 'drizzle-kit';

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // sin .env: DATABASE_URL puede venir del entorno
  }
}

// La tabla de migraciones queda en su esquema de siempre (`drizzle`), fuera de `app`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});

import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Corre una vez antes de los tests de integración: aplica las migraciones a la base de test.
export default async function setup() {
  if (!process.env.TEST_DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('Levanta PostgreSQL con pnpm db:up y copia .env.example a .env');
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
  } finally {
    await sql.end();
  }
}

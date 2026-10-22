import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Aplica las migraciones de `drizzle/` con el mismo migrador que los tests de integración.
// `drizzle-kit migrate` tapa el error con su animación; aquí el error sale completo en el log
// del deploy, sin la contraseña.
if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL (en local, copia .env.example a .env).');
  process.exit(1);
}

const target = new URL(url);
const where = `${decodeURIComponent(target.username)}@${target.hostname}:${target.port || '5432'}${target.pathname}`;
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
  console.log(`Migraciones aplicadas en ${where}`);
} catch (error) {
  // Drizzle envuelve el error de PostgreSQL en `cause`: ahí están el código y el mensaje útil.
  const pgError = (error as { cause?: unknown }).cause ?? error;
  const { message, code, detail, hint } = pgError as {
    message?: string;
    code?: string;
    detail?: string;
    hint?: string;
  };
  console.error(`No se pudieron aplicar las migraciones en ${where}`);
  console.error(`  ${code ?? 'sin código'}: ${message ?? String(error)}`);
  if (detail) console.error(`  detalle: ${detail}`);
  if (hint) console.error(`  pista: ${hint}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}

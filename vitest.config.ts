import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          fileParallelism: false,
          globalSetup: ['test/integration/setup.ts'],
          // los tests leen TEST_DATABASE_URL; setup.ts la carga de .env solo en su proceso
          env: loadDotenv(),
        },
      },
    ],
  },
});

/** Valores de `.env` (si existe) para los workers de los tests; lo que ya esté en el entorno gana. */
function loadDotenv(): Record<string, string> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // sin .env: setup.ts falla con el mensaje de ayuda si falta TEST_DATABASE_URL
  }
  const names = ['DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_ADMIN_DATABASE_URL'];
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Falla si `openapi.json` no coincide con lo que generan las rutas actuales (AGENTS.md, regla 6).

const committed = join(import.meta.dirname, '../openapi.json');
const dir = mkdtempSync(join(tmpdir(), 'pulso-openapi-'));
try {
  const fresh = join(dir, 'openapi.json');
  execFileSync(
    process.execPath,
    ['--import', 'tsx', join(import.meta.dirname, 'export-openapi.ts'), fresh],
    { stdio: 'ignore' },
  );
  if (readFileSync(fresh, 'utf8') !== readFileSync(committed, 'utf8')) {
    console.error(
      'openapi.json no está al día con las rutas. Corre `pnpm openapi:export` y súbelo en el mismo commit.',
    );
    process.exitCode = 1;
  } else {
    console.log('openapi.json está al día.');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// Imprime `ready=true` o `ready=false` según el entorno de `wrangler.jsonc` tenga ya el id de su
// Hyperdrive (y no el marcador `<pendiente-isaac>`). Lo usan `deploy.yml` y
// `deploy-production.yml` como puerta antes de migrar y desplegar; el resultado va a
// `$GITHUB_OUTPUT` en el workflow. Corre antes de `setup-node`, con el Node del runner: por eso usa
// `fileURLToPath(import.meta.url)` y no `import.meta.filename` (Node 20.11+).
//
// Uso: node scripts/ci/hyperdrive-ready.mjs <entorno> [ruta-del-wrangler.jsonc]
//
// No usa dependencias: `wrangler.jsonc` es JSONC, así que antes de `JSON.parse` se quitan los
// comentarios (`//` y `/* */`) y las comas finales, respetando el contenido de las cadenas (la
// `localConnectionString` lleva `postgres://`).
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PENDING = '<pendiente-isaac>';

/** Pasa de JSONC a JSON: quita comentarios y comas finales sin tocar lo que está entre comillas. */
export function jsoncToJson(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      out += ' ';
    } else {
      out += ch;
    }
  }
  return removeTrailingCommas(out);
}

function removeTrailingCommas(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== '}' && text[j] !== ']') out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * El id de Hyperdrive del entorno, o `""` si no hay entorno o no hay Hyperdrive. Un archivo que no
 * se puede leer lanza: la puerta falla con ruido en vez de omitir el deploy en silencio.
 */
export function hyperdriveId(text, env) {
  const config = JSON.parse(jsoncToJson(text));
  // sin `env` no es el wrangler.jsonc de Pulso (archivo equivocado): falla en vez de dar ready=false
  if (typeof config?.env !== 'object' || config.env === null) {
    throw new Error('El archivo no tiene la sección "env": ¿es el wrangler.jsonc de Pulso?');
  }
  const id = config.env[env]?.hyperdrive?.[0]?.id;
  return typeof id === 'string' ? id : '';
}

export function isReady(text, env) {
  const id = hyperdriveId(text, env);
  return id !== '' && id !== PENDING;
}

// `process.argv[1]` puede ser un enlace simbólico o una ruta relativa al archivo: se compara la ruta
// real, no el texto. Si la comparación fallara, el script saldría sin imprimir nada y `deploy.yml`
// leería una salida vacía. Una ruta que no se puede resolver (p. ej. `node -e`) no es el script.
function isEntryPoint() {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
const isMain = isEntryPoint();
if (isMain) {
  const [env, file = 'wrangler.jsonc'] = process.argv.slice(2);
  if (!env) {
    console.error('Uso: node scripts/ci/hyperdrive-ready.mjs <entorno> [wrangler.jsonc]');
    process.exit(2);
  }
  console.log(`ready=${isReady(readFileSync(file, 'utf8'), env)}`);
}

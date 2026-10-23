import type { Child } from 'hono/jsx';

/** Correo de contacto de las páginas públicas (A-028). */
export const CONTACT_EMAIL = 'isaac.mendozasa@gmail.com';

/** Fecha de la última revisión del texto de las páginas. Se cambia cada vez que cambia el contenido. */
export const LAST_UPDATE = '23 de octubre de 2026';

// Oscuro por defecto; claro solo si el teléfono lo pide. Todo en línea: la CSP no deja cargar nada.
const STYLES = `
:root { color-scheme: dark light; --bg: #11151c; --fg: #e8ecf2; --muted: #9aa5b5; --line: #2a3340; --accent: #f5b942; --card: #181e28; }
@media (prefers-color-scheme: light) {
  :root { --bg: #fafaf7; --fg: #1b2330; --muted: #566174; --line: #d9dde3; --accent: #9a6200; --card: #ffffff; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
main { max-width: 42rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 .25rem; }
h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; color: var(--accent); }
p, li { margin: .5rem 0; }
ul { padding-left: 1.25rem; }
a { color: var(--accent); }
.muted { color: var(--muted); font-size: .9rem; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .95rem; background: var(--card); }
th, td { text-align: left; vertical-align: top; padding: .5rem .6rem; border: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; }
nav { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--line); }
`;

export function Layout({ title, children }: { title: string; children?: Child }) {
  return (
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark light" />
        <title>{title}</title>
        <style>{STYLES}</style>
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}

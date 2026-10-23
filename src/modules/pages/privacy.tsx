import { CONTACT_EMAIL, LAST_UPDATE, Layout } from './layout';

const STORED: Array<[data: string, retention: string]> = [
  [
    'Un identificador anónimo del teléfono y un código de verificación de su clave de acceso (no la clave).',
    'Hasta que borres tus datos, o 180 días sin actividad. Si un registro nunca manda nada, se borra a los 7 días.',
  ],
  [
    'Si hay corriente o no, si hay Wi-Fi e internet, si el teléfono está en la red de tu casa (sí o no), la pantalla y la batería, cada uno con su hora.',
    '30 días en el servidor y 14 días en el teléfono.',
  ],
  ['Los reportes y confirmaciones que haces ("sí se fue la luz").', '30 días.'],
  [
    'Los cortes de luz detectados: cuándo empezó y cuándo terminó cada uno, y si confirmaste que fue un corte.',
    'Mientras exista la casa.',
  ],
  [
    'El nombre que le pongas a la casa y a las casas que sigues. Puede ser un nombre que tú escribes, así que no pongas datos que no quieras guardar.',
    'Mientras existan la casa o el seguimiento.',
  ],
  [
    'Fabricante, modelo, versión de Android y de la app, y si el ahorro de batería está activo. Sirve para saber por qué un teléfono falla.',
    'Mientras exista el dispositivo.',
  ],
  [
    'El código del teléfono para mandarle avisos (token de notificaciones).',
    'Mientras exista el dispositivo.',
  ],
  [
    'Los errores de la app y de la API, sin enviar datos personales a propósito.',
    'Según el plan gratuito de Sentry.',
  ],
];

const PROCESSORS: Array<[name: string, role: string]> = [
  ['Cloudflare', 'corre la API que recibe los datos de la app.'],
  ['Supabase', 'guarda la base de datos (PostgreSQL).'],
  ['Expo y Firebase (Google)', 'entregan las notificaciones al teléfono.'],
  ['Sentry', 'recibe los errores para poder arreglarlos.'],
  ['GitHub', 'guarda copias de respaldo de la base, cifradas, por 14 días.'],
];

export function Privacy() {
  return (
    <Layout title="Política de privacidad · Pulso">
      <h1>Política de privacidad de Pulso</h1>
      <p class="muted">Última actualización: {LAST_UPDATE}</p>

      <p>
        Pulso es una app de Android que detecta sola cuándo se va la luz en tu casa y avisa a la
        familia que la sigue. Aquí te explicamos, sin vueltas, qué datos guarda y cómo los puedes
        borrar.
      </p>

      <h2>Qué se guarda y por cuánto tiempo</h2>
      <section class="table-wrap" tabindex={0} aria-label="Datos que se guardan y su retención">
        <table>
          <thead>
            <tr>
              <th>Dato</th>
              <th>Cuánto se guarda</th>
            </tr>
          </thead>
          <tbody>
            {STORED.map(([data, retention]) => (
              <tr>
                <td>{data}</td>
                <td>{retention}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p>
        Todo esto se usa para una sola cosa: detectar los cortes de luz de tu casa, llevar su
        historial y avisar a quien la sigue.
      </p>

      <h2>Lo que no se recoge</h2>
      <p>
        Pulso no recoge tu ubicación ni el nombre de la red Wi-Fi a la que te conectas ni el
        identificador del router. Tampoco guarda tu nombre, tu número de teléfono, tu correo ni tus
        contactos. La huella de la red de tu casa se calcula en el teléfono y se queda ahí.
      </p>

      <h2>Con quién se trabaja</h2>
      <p>Para funcionar, Pulso usa estos proveedores:</p>
      <ul>
        {PROCESSORS.map(([name, role]) => (
          <li>
            <strong>{name}</strong>: {role}
          </li>
        ))}
      </ul>
      <p>
        No se venden ni se comparten con terceros; los proveedores solo los procesan para que Pulso
        funcione. Todo viaja cifrado (HTTPS).
      </p>

      <h2>Borrar todo desde la app</h2>
      <p>
        En la app, entra a Ajustes y toca "Borrar mis datos". Se borran en el servidor tu
        dispositivo, tu casa, los eventos, los cortes, los seguidores y los avisos, y la app vuelve
        al principio. Si ya no tienes la app, mira{' '}
        <a href="/borrar-datos">cómo pedirlo por correo</a>.
      </p>

      <h2>El código de la casa</h2>
      <p>
        Cada casa tiene un código de 8 caracteres. Quien lo tenga puede ver si hay luz en esa casa,
        cuánto lleva el corte y el nombre de la casa, y recibir los avisos de esa casa. Lo compartes
        tú, con quien quieras. Si quieres que deje de circular, regenéralo en Ajustes: el código y
        el enlace viejos dejan de servir y se quita a todos los que siguen la casa. Para volver a
        seguirla necesitarán el código nuevo.
      </p>

      <h2>Contacto</h2>
      <p>
        Si tienes dudas sobre tus datos, escríbenos a{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>

      <nav>
        <a href="/borrar-datos">Cómo borrar mis datos</a>
      </nav>
    </Layout>
  );
}

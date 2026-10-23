import { CONTACT_EMAIL, LAST_UPDATE, Layout } from './layout';

export function DeleteData() {
  return (
    <Layout title="Borrar mis datos · Pulso">
      <h1>Borrar mis datos de Pulso</h1>
      <p class="muted">Última actualización: {LAST_UPDATE}</p>

      <p>
        Puedes borrar todo lo que Pulso guarda en su servidor cuando quieras. Es definitivo: no se
        puede deshacer.
      </p>

      <h2>Desde la app</h2>
      <ol>
        <li>Abre Pulso y entra a Ajustes.</li>
        <li>Toca "Borrar mis datos".</li>
        <li>Confirma. La app borra todo y vuelve al principio.</li>
      </ol>

      <h2>Si ya no tienes la app</h2>
      <p>
        Escribe a <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> y pide que borren tus
        datos. Incluye el código de la casa (los 8 caracteres que ves en la app o que te
        compartieron). Sin ese código no podemos saber cuáles datos son los tuyos, porque Pulso no
        guarda tu nombre ni tu correo. Ten en cuenta que quien tenga el código de la casa también
        puede pedir el borrado. Te avisamos por correo cuando esté hecho.
      </p>

      <h2>Qué se borra</h2>
      <ul>
        <li>El dispositivo y su identificador.</li>
        <li>La casa y su código.</li>
        <li>Los eventos que mandó el teléfono.</li>
        <li>Los cortes de luz detectados.</li>
        <li>Los seguidores de la casa y las casas que seguías.</li>
        <li>Los avisos enviados y el código para mandarle notificaciones al teléfono.</li>
      </ul>
      <p>
        En el teléfono, la app también borra su historial local y cancela sus tareas. Las copias de
        respaldo cifradas desaparecen solas a los 14 días. Los reportes de errores que recibe Sentry
        no llevan datos personales a propósito y se guardan según el plan de Sentry.
      </p>

      <nav>
        <a href="/privacidad">Política de privacidad</a>
      </nav>
    </Layout>
  );
}

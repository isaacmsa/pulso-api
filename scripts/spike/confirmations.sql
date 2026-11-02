-- Tarea 4.4 (D-013, corte B7): los cortes de los últimos 30 días con su confirmación y los eventos
-- alrededor de cada uno, en un solo JSON. Solo lee: se corre en el editor SQL de Supabase y el
-- resultado (una fila, una columna) se guarda como archivo.
--
-- Sin ids de dispositivo ni de casa: cada casa es un número, en el orden en que se creó. Los
-- eventos van como los mandó el teléfono, con `at` ya corregido, igual que la ventana de
-- `ingest_batch`. Cada corte trae los eventos de la casa desde 2 h antes de su inicio hasta 2 h
-- después de su fin. Uno sin fin (`abierto` o `sin_datos`) llega hasta ahora con un tope de 48 h
-- desde su inicio: un `sin_datos` viejo traería semanas de eventos que no dicen nada del corte.
-- `reports` trae los botones y las respuestas de confirmación de la casa en los 30 días, para
-- buscar los cortes que el clasificador no vio. Solo entran los cortes cuya ventana completa cabe
-- en los 30 días: antes de eso, la retención ya borró sus eventos.
WITH params AS (
  SELECT
    (extract(epoch FROM now()) * 1000)::bigint AS now_ms,
    30 * 86400000::bigint AS days_ms,
    2 * 3600000::bigint AS margin_ms,
    48 * 3600000::bigint AS open_cap_ms
),
numbered AS (
  SELECT h.id, row_number() OVER (ORDER BY h.created_at, h.id) AS n
  FROM app.homes h
)
SELECT json_build_object(
  'exportedAt', p.now_ms,
  'homes', coalesce((
    SELECT json_agg(json_build_object(
      'home', hn.n,
      'outages', coalesce((
        SELECT json_agg(json_build_object(
          'start', o.started_at,
          'end', o.ended_at,
          'status', o.status,
          'confidence', o.confidence,
          'confirmed', o.confirmed,
          'events', coalesce((
            SELECT json_agg(e.payload || jsonb_build_object('at', e.at) ORDER BY e.at, e.id)
            FROM app.events e
            WHERE e.home_id = o.home_id
              AND e.at >= o.started_at - p.margin_ms
              AND e.at <= coalesce(o.ended_at, least(p.now_ms, o.started_at + p.open_cap_ms)) + p.margin_ms
          ), '[]'::json)
        ) ORDER BY o.started_at)
        FROM app.outages o
        WHERE o.home_id = hn.id AND o.started_at - p.margin_ms >= p.now_ms - p.days_ms
      ), '[]'::json),
      'reports', coalesce((
        SELECT json_agg(e.payload || jsonb_build_object('at', e.at) ORDER BY e.at, e.id)
        FROM app.events e
        WHERE e.home_id = hn.id
          AND e.kind IN ('report', 'confirmation')
          AND e.at >= p.now_ms - p.days_ms
      ), '[]'::json)
    ) ORDER BY hn.n)
    FROM numbered hn
  ), '[]'::json)
) AS export
FROM params p;

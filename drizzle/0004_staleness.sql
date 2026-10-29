-- "Sin noticias" y sin_datos (A-037, A-038) y los cortes cuyo inicio ya se purgó (A-042).

-- ingest_batch, misma firma y mismos permisos que en 0001. Solo cambia qué cortes devuelve:
--   · los sin_datos que empiezan en la ventana entran en la reconciliación, para que unos eventos
--     atrasados los reclasifiquen en vez de duplicarlos (A-038);
--   · ningún corte que empiece antes de from, tampoco uno abierto (A-042).
-- La ventana y pending_anchor (A-024) no cambian.
CREATE OR REPLACE FUNCTION app.ingest_batch(
  p_device_id uuid,
  p_home_id uuid,
  p_events jsonb,
  p_offset_ms bigint,
  p_received_at bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_total integer := jsonb_array_length(p_events);
  v_accepted integer;
  v_oldest_at bigint;
  v_confirmation_anchor bigint;
  v_anchor bigint;
  v_from bigint;
  v_revision bigint;
  v_mode text;
  v_status text;
  v_status_since bigint;
  v_window jsonb;
  v_outages jsonb;
BEGIN
  -- device_at queda como llegó; at es la hora corregida con el desfase del lote.
  WITH inserted AS (
    INSERT INTO app.events (device_id, id, home_id, kind, device_at, at, payload, received_at)
    SELECT p_device_id, (e->>'id')::uuid, p_home_id, e->>'kind',
           (e->>'at')::bigint, (e->>'at')::bigint + p_offset_ms, e, p_received_at
    FROM jsonb_array_elements(p_events) AS e
    ON CONFLICT (device_id, id) DO NOTHING
    RETURNING kind, at, payload
  )
  SELECT count(*),
         min(at),
         -- outageStart es la hora del servidor que devolvió la API: no lleva desfase.
         -- 300000 = CONFIRMATION_TOLERANCE_MS (src/domain/detection/constants.ts).
         min((payload->>'outageStart')::bigint - 300000) FILTER (WHERE kind = 'confirmation')
  INTO v_accepted, v_oldest_at, v_confirmation_anchor
  FROM inserted;

  IF v_accepted = 0 THEN
    -- Un reenvío. Si algo quedó sin clasificar (un apply_outages perdido o rechazado), se clasifica
    -- otra vez desde el ancla pendiente como si el lote fuera nuevo: si no, esos eventos no se
    -- clasificarían nunca. El WHERE se vuelve a evaluar con la fila bloqueada (A-024).
    UPDATE app.homes SET ingest_revision = ingest_revision + 1
    WHERE id = p_home_id AND pending_anchor IS NOT NULL
    RETURNING ingest_revision, mode, status, status_since, pending_anchor
    INTO v_revision, v_mode, v_status, v_status_since, v_anchor;

    IF NOT FOUND THEN
      SELECT ingest_revision, mode, status, status_since
      INTO v_revision, v_mode, v_status, v_status_since
      FROM app.homes WHERE id = p_home_id;
      RETURN jsonb_build_object(
        'accepted', 0,
        'duplicated', v_total,
        'revision', v_revision,
        'mode', v_mode,
        'status', jsonb_build_object('state', v_status, 'since', v_status_since),
        'window', '[]'::jsonb,
        'outages', '[]'::jsonb
      );
    END IF;
  ELSE
    -- Toma el candado de la casa: un lote en paralelo espera aquí y, al seguir, ya ve estos
    -- eventos. El estado sale de esta misma fila: incluye todo apply_outages que aplicó antes, y
    -- la revisión nueva impide que otro aplique después sin que apply_outages de este lote lo
    -- note (A-023). El ancla del lote se junta con la pendiente (least ignora NULL): si el
    -- apply_outages de otro lote se perdió o lo rechazó la revisión, esta ventana también cubre
    -- sus eventos (A-024).
    v_anchor := least(v_oldest_at, v_confirmation_anchor);
    UPDATE app.homes
    SET ingest_revision = ingest_revision + 1,
        pending_anchor = least(pending_anchor, v_anchor)
    WHERE id = p_home_id
    RETURNING ingest_revision, mode, status, status_since, pending_anchor
    INTO v_revision, v_mode, v_status, v_status_since, v_anchor;
  END IF;

  -- pending_anchor guarda el ancla antes de ampliarla por los cortes guardados: los cortes se
  -- vuelven a leer aquí en cada llamada, y mientras quede algo pendiente ningún apply_outages los
  -- cambió, así que un reintento reproduce la misma ventana.
  --
  -- Si el ancla cae dentro de un corte guardado (abierto, o que terminó en el ancla o después),
  -- la ventana arranca antes de ese corte. Un corte manual sigue abierto aunque haya snapshots
  -- powered repetidos dentro: empezar a mitad de corte haría que el clasificador inventara otro.
  -- Un sin_datos no amplía la ventana: no se cierra solo, así que la arrastraría hasta su inicio
  -- en cada lote. Entra en la reconciliación solo si cae en la ventana (abajo).
  SELECT least(v_anchor, min(started_at)) INTO v_anchor
  FROM app.outages
  WHERE home_id = p_home_id
    AND status <> 'sin_datos'
    AND started_at < v_anchor
    AND (ended_at IS NULL OR ended_at >= v_anchor);

  -- Desde el último snapshot powered (plugged y en casa) antes del ancla: ahí el clasificador
  -- está armado y sin corte abierto.
  SELECT at INTO v_from
  FROM app.events
  WHERE home_id = p_home_id
    AND at < v_anchor
    AND kind = 'snapshot'
    AND (payload->>'plugged')::boolean
    AND coalesce((payload->>'homeWifi')::boolean, (payload->>'onWifi')::boolean)
  ORDER BY at DESC
  LIMIT 1;

  IF v_from IS NULL THEN
    SELECT min(at) INTO v_from FROM app.events WHERE home_id = p_home_id;
  END IF;

  SELECT coalesce(jsonb_agg(payload || jsonb_build_object('at', at) ORDER BY at, id), '[]'::jsonb)
  INTO v_window
  FROM app.events
  WHERE home_id = p_home_id AND at >= v_from;

  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', id,
               'start', started_at,
               'end', ended_at,
               'status', status,
               'confidence', confidence,
               'confirmed', confirmed
             )
             ORDER BY started_at, id
           ),
           '[]'::jsonb
         )
  INTO v_outages
  -- Los cortes que empiezan en la ventana, de cualquier estado: un sin_datos con eventos atrasados
  -- se vuelve a reconciliar (A-038). Uno que empieza antes de from queda fuera, también si sigue
  -- abierto: sus eventos de inicio ya no están (la retención borra los de más de 30 días), el
  -- clasificador no lo puede volver a ver y la reconciliación lo reescribiría a descartado (A-042).
  FROM app.outages
  WHERE home_id = p_home_id
    AND started_at >= v_from;

  RETURN jsonb_build_object(
    'accepted', v_accepted,
    'duplicated', v_total - v_accepted,
    'revision', v_revision,
    'mode', v_mode,
    'status', jsonb_build_object('state', v_status, 'since', v_status_since),
    'window', v_window,
    'outages', v_outages
  );
END;
$$;
--> statement-breakpoint

-- El cron sweep marca lo que se quedó sin noticias, en una consulta (A-037, A-038):
--   1. cada corte abierto de una casa de la que no llega ningún evento nuevo (received_at, la hora
--      del servidor) desde hace 24 h o más pasa a sin_datos: no suma horas y deja de ser el corte
--      abierto de la casa;
--   2. cada casa sin corte abierto (ya contando los del paso 1) que no está en sin_noticias y cuyo
--      teléfono no tiene latido desde hace 40 min o más pasa a sin_noticias desde ese latido.
-- Sube ingest_revision de cada casa que toca (A-023): un lote en vuelo no puede aplicar encima un
-- estado calculado antes. Bloquea las casas candidatas en orden de id antes de tocar sus cortes,
-- en el mismo orden que apply_outages (casa y luego cortes), así que no se interbloquean.
-- 2400000 = 40 min y 86400000 = 24 h (docs/api.md).
CREATE FUNCTION app.mark_stale(p_now bigint) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_homes uuid[];
  v_no_data uuid[];
  v_no_data_count integer;
  v_no_news uuid[];
BEGIN
  WITH candidates AS (
    SELECT h.id
    FROM app.homes AS h
    WHERE (
        h.status <> 'sin_noticias'
        AND (SELECT max(d.last_seen_at) FROM app.devices AS d WHERE d.home_id = h.id)
            <= p_now - 2400000
        AND NOT EXISTS (
          SELECT 1 FROM app.outages AS o WHERE o.home_id = h.id AND o.status = 'abierto')
      )
      OR (
        EXISTS (SELECT 1 FROM app.outages AS o WHERE o.home_id = h.id AND o.status = 'abierto')
        AND NOT EXISTS (
          SELECT 1 FROM app.events AS e
          WHERE e.home_id = h.id AND e.received_at > p_now - 86400000)
      )
    ORDER BY h.id
    FOR UPDATE
  )
  SELECT coalesce(array_agg(id), '{}') INTO v_homes FROM candidates;

  IF cardinality(v_homes) = 0 THEN
    RETURN jsonb_build_object('noNews', 0, 'noData', 0);
  END IF;

  -- Con las casas bloqueadas, un lote nuevo espera: lo que se lee aquí ya no cambia por debajo.
  WITH stale AS (
    UPDATE app.outages AS o
    SET status = 'sin_datos', updated_at = p_now
    WHERE o.home_id = ANY(v_homes)
      AND o.status = 'abierto'
      AND NOT EXISTS (
        SELECT 1 FROM app.events AS e
        WHERE e.home_id = o.home_id AND e.received_at > p_now - 86400000)
    RETURNING o.home_id
  )
  SELECT coalesce(array_agg(DISTINCT home_id), '{}'), count(*)
  INTO v_no_data, v_no_data_count
  FROM stale;

  -- Esta sentencia ya ve los sin_datos de la anterior.
  WITH phones AS (
    SELECT home_id, max(last_seen_at) AS last_seen
    FROM app.devices
    WHERE home_id = ANY(v_homes)
    GROUP BY home_id
  ),
  silent AS (
    UPDATE app.homes AS h
    SET status = 'sin_noticias', status_since = p.last_seen
    FROM phones AS p
    WHERE h.id = p.home_id
      AND h.status <> 'sin_noticias'
      AND p.last_seen <= p_now - 2400000
      AND NOT EXISTS (
        SELECT 1 FROM app.outages AS o WHERE o.home_id = h.id AND o.status = 'abierto')
    RETURNING h.id
  )
  SELECT coalesce(array_agg(id), '{}') INTO v_no_news FROM silent;

  UPDATE app.homes SET ingest_revision = ingest_revision + 1
  WHERE id = ANY(v_no_data || v_no_news);

  RETURN jsonb_build_object('noNews', cardinality(v_no_news), 'noData', v_no_data_count);
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.mark_stale(bigint) FROM PUBLIC;

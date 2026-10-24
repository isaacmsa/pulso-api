-- Regenerar el código quita a todos los seguidores (A-041, D-030). Es una función y no un solo
-- CTE porque en una sola sentencia el DELETE usa la instantánea de antes del UPDATE: un follow
-- confirmado mientras el UPDATE esperaba el candado de la fila sobrevivía. En plpgsql cada
-- sentencia toma su propia instantánea, así que el DELETE ve los follows confirmados mientras el
-- UPDATE esperaba. El otro lado de la carrera (un follow que lee el código viejo) lo cierra el
-- `FOR KEY SHARE` de la consulta de `followHome`.

-- Cambia el share_code de la casa y borra todos sus follows. Devuelve el código nuevo, o NULL si
-- la casa no existe (entonces no borra nada). Si el código choca (23505) lanza el error y todo
-- se deshace: nadie queda sin seguir por un intento fallido.
CREATE FUNCTION app.replace_share_code(p_home_id uuid, p_code text) RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = app, pg_temp
AS $$
BEGIN
  -- Toma el candado de la fila: un follow en curso (su FK ya tomó FOR KEY SHARE) termina antes.
  UPDATE app.homes SET share_code = p_code WHERE id = p_home_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- Sentencia aparte: su instantánea es posterior al candado, así que ve esos follows.
  DELETE FROM app.follows WHERE home_id = p_home_id;
  RETURN p_code;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.replace_share_code(uuid, text) FROM PUBLIC;

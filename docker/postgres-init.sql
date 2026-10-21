-- Prepara PostgreSQL para Pulso: roles como en Supabase y las bases de desarrollo y de test.
-- Local: lo corre el contenedor al crear el volumen. CI: `psql` como superusuario contra el servicio.

CREATE ROLE pulso_api LOGIN PASSWORD 'pulso_dev';
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;

CREATE DATABASE pulso_dev;
CREATE DATABASE pulso_test;

-- pulso_api crea y es dueño del esquema `app` (y del esquema `drizzle` de las migraciones).
GRANT CREATE ON DATABASE pulso_dev TO pulso_api;
GRANT CREATE ON DATABASE pulso_test TO pulso_api;

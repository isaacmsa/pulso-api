import { afterAll, describe, expect, it } from 'vitest';
import { adminSql, testDb } from './helpers';

const TABLES = ['devices', 'events', 'follows', 'homes', 'outages', 'push_tickets'];

describe('esquema app', () => {
  const { sql } = testDb();
  const admin = adminSql();

  afterAll(async () => {
    await sql.end();
    await admin.end();
  });

  it('todas las tablas viven en app con RLS activado', async () => {
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'app' ORDER BY tablename`;
    expect(tables.map((t) => t.tablename)).toEqual(TABLES);

    const rls = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY c.relname`;
    expect(rls).toHaveLength(6);
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('app no tiene políticas de RLS', async () => {
    const policies = await sql`SELECT policyname FROM pg_policies WHERE schemaname = 'app'`;
    expect(policies).toHaveLength(0);
  });

  it('pulso_api es dueño del esquema app', async () => {
    const [row] = await sql<{ owner: string }[]>`
      SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'app'`;
    expect(row?.owner).toBe('pulso_api');
  });

  it('anon no puede leer nada de app', async () => {
    // SET ROLE exige ser miembro de anon, así que va con el superusuario y dentro de una transacción
    await expect(
      admin.begin(async (tx) => {
        await tx`SET LOCAL ROLE anon`;
        await tx`SELECT 1 FROM app.homes`;
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('no hay tablas de Pulso en public', async () => {
    const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    expect(tables).toHaveLength(0);
  });
});

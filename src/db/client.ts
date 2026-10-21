import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

export type CreateDbOptions = {
  /** Se llama una vez por consulta que sale a la base. Sirve para contarlas en los tests. */
  onQuery?: () => void;
};

/**
 * Crea el cliente de una petición. El Worker lo llama dentro del handler con
 * `env.HYPERDRIVE.connectionString`: nunca a nivel de módulo.
 */
export function createDb(
  connectionString: string,
  options: CreateDbOptions = {},
): { sql: postgres.Sql; db: Db } {
  const { onQuery } = options;
  const sql = postgres(connectionString, {
    max: 5,
    fetch_types: false,
    ...(onQuery ? { debug: () => onQuery() } : {}),
  });
  return { sql, db: drizzle(sql, { schema }) };
}

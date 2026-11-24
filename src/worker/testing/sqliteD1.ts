import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

// workerd has these natively; Node 24 does not.
Uint8Array.prototype.toBase64 ??= function (this: Uint8Array) {
  return Buffer.from(this).toString("base64");
};
Uint8Array.fromBase64 ??= (text) => new Uint8Array(Buffer.from(text, "base64"));

const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

const migrationFiles = () =>
  NodeFS.readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .toSorted();

/**
 * D1 refuses a compound SELECT of more than 5 terms ("too many terms in
 * compound SELECT"); node:sqlite allows 500. Counted over the whole
 * statement, which is stricter than D1 for unions in separate subqueries.
 */
export const D1_MAX_COMPOUND_SELECT = 5;

function checkD1Limits(sql: string): void {
  const joins = sql.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi)?.length ?? 0;
  if (joins + 1 > D1_MAX_COMPOUND_SELECT) {
    throw new Error("D1_ERROR: too many terms in compound SELECT: SQLITE_ERROR");
  }
}

/**
 * The subset of D1 the services use, backed by an in-memory node:sqlite
 * database with the real migrations. `before` stops at that migration file
 * prefix; `applyMigrationsFrom` runs the rest later, to test a backfill.
 */
export function makeTestD1(options: { readonly before?: string } = {}): D1Database {
  const sqlite = new NodeSqlite.DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationFiles()) {
    if (options.before !== undefined && file >= options.before) break;
    sqlite.exec(NodeFS.readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }

  const statement = (sql: string, params: Array<NodeSqlite.SQLInputValue> = []) => {
    checkD1Limits(sql);
    return statementOf(sql, params);
  };
  const statementOf = (sql: string, params: Array<NodeSqlite.SQLInputValue> = []) => ({
    bind: (...values: Array<unknown>) => statement(sql, values as Array<NodeSqlite.SQLInputValue>),
    first: async () => (sqlite.prepare(sql).get(...params) as unknown) ?? null,
    rows: () => sqlite.prepare(sql).all(...params),
    all: async () => ({
      results: sqlite.prepare(sql).all(...params),
      success: true,
      meta: {},
    }),
    run: async () => {
      const prepared = sqlite.prepare(sql);
      // RETURNING statements must be stepped with all() to apply.
      if (/\breturning\b/i.test(sql)) {
        const rows = prepared.all(...params);
        return { results: [], success: true, meta: { changes: rows.length } };
      }
      const result = prepared.run(...params);
      return {
        results: [],
        success: true,
        meta: { changes: Number(result.changes) },
      };
    },
  });

  const db = {
    prepare: (sql: string) => statement(sql),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    batch: async (statements: Array<ReturnType<typeof statement>>) => {
      // Runs without yielding, so an overlapping batch never lands inside this transaction.
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((item) => ({
          results: item.rows(),
          success: true,
          meta: {},
        }));
        sqlite.exec("COMMIT");
        return results;
      } catch (cause) {
        sqlite.exec("ROLLBACK");
        throw cause;
      }
    },
  };
  return db as unknown as D1Database;
}

export async function applyMigrationsFrom(db: D1Database, from: string): Promise<void> {
  for (const file of migrationFiles()) {
    if (file >= from) await db.exec(NodeFS.readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
}

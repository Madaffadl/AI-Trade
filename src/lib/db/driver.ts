import 'server-only';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from '@/lib/config/env';

/**
 * Minimal database abstraction over SQLite (local) and PostgreSQL (deployed).
 *
 * All callers write SQL with `?` placeholders. The PostgreSQL driver rewrites
 * them to `$1..$n`. Keeping to the portable SQL subset documented in
 * schema.sql means no query needs a dialect branch.
 */
export type Dialect = 'sqlite' | 'postgres';

export interface Db {
  readonly dialect: Dialect;
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  run(sql: string, params?: readonly unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** Rewrite `?` placeholders to PostgreSQL `$n`, ignoring `?` inside string literals. */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let inSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'") inSingle = !inSingle;
    if (c === '?' && !inSingle) {
      out += `$${++n}`;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * SQLite stores epoch-ms as INTEGER; node:sqlite may return BigInt for large
 * integers depending on build. Normalise to JS number (safe: epoch-ms is well
 * below Number.MAX_SAFE_INTEGER until year 287396).
 */
function normaliseRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out as T;
}

class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  // node:sqlite's DatabaseSync; typed loosely to avoid a hard type dependency.
  private db: {
    prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
    exec(sql: string): void;
    close(): void;
  };

  constructor(db: SqliteDb['db']) {
    this.db = db;
  }

  static async open(path: string): Promise<SqliteDb> {
    const { DatabaseSync } = await import('node:sqlite');
    const inMemory = path === ':memory:';
    // The database path is runtime configuration, and the database file must
    // never be traced into the server bundle. Without this hint Turbopack (the
    // default bundler since Next 16) saw a dynamic filesystem path and traced
    // the ENTIRE project into the build output.
    const target = inMemory ? path : resolve(/* turbopackIgnore: true */ process.cwd(), path);
    if (!inMemory) mkdirSync(dirname(target), { recursive: true });
    const db = new DatabaseSync(target);
    if (!inMemory) db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    return new SqliteDb(db as unknown as SqliteDb['db']);
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const rows = this.db.prepare(sql).all(...sanitize(params)) as Record<string, unknown>[];
    return rows.map((r) => normaliseRow<T>(r));
  }

  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...sanitize(params));
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** node:sqlite accepts null/number/string/bigint/Uint8Array only. */
function sanitize(params: readonly unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.getTime();
    return p;
  });
}

class PostgresDb implements Db {
  readonly dialect = 'postgres' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sql: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(sql: any) {
    this.sql = sql;
  }

  static async open(url: string): Promise<PostgresDb> {
    const mod = await import('postgres');
    const postgres = mod.default;
    const sql = postgres(url, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      // Epoch-ms BIGINT columns are returned as strings by default; parse them.
      types: {
        bigint: {
          to: 20,
          from: [20],
          serialize: (x: number | bigint) => String(x),
          parse: (x: string) => Number(x),
        },
      },
    });
    return new PostgresDb(sql);
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const rows = await this.sql.unsafe(toPgPlaceholders(sql), sanitize(params));
    return rows as T[];
  }

  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    await this.sql.unsafe(toPgPlaceholders(sql), sanitize(params));
  }

  async exec(sql: string): Promise<void> {
    await this.sql.unsafe(sql);
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

let instance: Promise<Db> | null = null;

/** Process-wide database handle. */
export function db(): Promise<Db> {
  if (!instance) {
    const e = env();
    instance = e.DATABASE_URL
      ? PostgresDb.open(e.DATABASE_URL)
      : SqliteDb.open(e.SQLITE_PATH);
  }
  return instance;
}

/** Apply schema.sql. Idempotent: every statement uses IF NOT EXISTS. */
export async function migrate(target?: Db): Promise<{ dialect: Dialect; statements: number }> {
  const handle = target ?? (await db());
  const schemaPath = resolve(process.cwd(), 'src/lib/db/schema.sql');
  const sql = readFileSync(schemaPath, 'utf8');
  const statements = splitStatements(sql);
  for (const stmt of statements) {
    await handle.exec(stmt);
  }
  return { dialect: handle.dialect, statements: statements.length };
}

/**
 * Split a DDL file into executable statements.
 *
 * `--` comments are stripped character-by-character rather than line-by-line,
 * because an inline comment may legitimately contain an apostrophe (e.g.
 * "the candle's period"), which a naive line filter leaves behind as an
 * unterminated string literal.
 */
export function splitStatements(sql: string): string[] {
  let cleaned = '';
  let inString = false;
  let inComment = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (inComment) {
      if (c === '\n') {
        inComment = false;
        cleaned += c;
      }
      continue;
    }
    if (!inString && c === '-' && next === '-') {
      inComment = true;
      i++;
      continue;
    }
    if (c === "'") inString = !inString;
    cleaned += c;
  }

  // Statement separation is safe now that comments are gone: the schema
  // contains no semicolons inside string literals.
  return cleaned
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Open an isolated in-memory SQLite database. Test-only. */
export async function openMemoryDb(): Promise<Db> {
  return SqliteDb.open(':memory:');
}

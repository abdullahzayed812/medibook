import {
  createPool,
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type { AppConfig } from '../../config/env.js';

/**
 * Values that may be bound to a `?` placeholder. Restricting the type keeps
 * callers from passing objects/arrays that mysql2 would expand in surprising ways.
 */
export type SqlValue = string | number | bigint | boolean | Date | Buffer | null;
export type SqlParams = readonly SqlValue[];

/**
 * Minimal query surface shared by the pool and by transactions.
 * Repositories depend on this interface, so the same repository code runs
 * inside or outside a transaction.
 */
export interface SqlExecutor {
  /** Runs a SELECT (or other row-returning statement) and returns its rows. */
  query<TRow extends object>(sql: string, params?: SqlParams): Promise<TRow[]>;
  /** Runs an INSERT/UPDATE/DELETE and returns affected rows / insert id. */
  execute(sql: string, params?: SqlParams): Promise<ResultSetHeader>;
}

export type TransactionCallback<T> = (tx: SqlExecutor) => Promise<T>;

class ConnectionExecutor implements SqlExecutor {
  constructor(private readonly runner: Pool | PoolConnection) {}

  async query<TRow extends object>(sql: string, params: SqlParams = []): Promise<TRow[]> {
    // `execute` uses server-side prepared statements: values are always bound, never interpolated.
    const [rows] = await this.runner.execute<RowDataPacket[]>(sql, params as SqlValue[]);
    // Justified cast: the caller declares the row shape it SELECTs; MySQL returns plain row objects.
    return rows as unknown as TRow[];
  }

  async execute(sql: string, params: SqlParams = []): Promise<ResultSetHeader> {
    const [result] = await this.runner.execute<ResultSetHeader>(sql, params as SqlValue[]);
    return result;
  }
}

export function buildPoolOptions(config: AppConfig['database']): PoolOptions {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.connectionLimit,
    connectTimeout: config.connectTimeoutMs,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    charset: 'utf8mb4_0900_ai_ci',
    // Store and read all DATETIME/TIMESTAMP values as UTC.
    timezone: 'Z',
    // BIGINT / DECIMAL are returned as strings to avoid silent precision loss.
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    // Application connections never run multiple statements per call (SQL injection hardening).
    multipleStatements: false,
    namedPlaceholders: false,
  };
}

/**
 * Database access layer: a MySQL connection pool plus parameterized query and
 * transaction helpers. Contains no business rules.
 */
export class Database implements SqlExecutor {
  private readonly executor: ConnectionExecutor;

  constructor(private readonly pool: Pool) {
    this.executor = new ConnectionExecutor(pool);
  }

  static fromConfig(config: AppConfig['database']): Database {
    return new Database(createPool(buildPoolOptions(config)));
  }

  query<TRow extends object>(sql: string, params?: SqlParams): Promise<TRow[]> {
    return this.executor.query<TRow>(sql, params);
  }

  execute(sql: string, params?: SqlParams): Promise<ResultSetHeader> {
    return this.executor.execute(sql, params);
  }

  /**
   * Runs `callback` inside a single transaction on one dedicated connection.
   * Commits when the callback resolves, rolls back when it throws (and rethrows).
   * Nested transactions are intentionally unsupported: the `tx` executor has no
   * `transaction` method, so nesting is a compile-time error.
   */
  async transaction<T>(
    callback: TransactionCallback<T>,
    options: { isolation?: 'READ COMMITTED' } = {},
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      // Applies to the next transaction on this connection only (MySQL semantics).
      if (options.isolation !== undefined)
        await connection.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation}`);
      await connection.beginTransaction();
      const result = await callback(new ConnectionExecutor(connection));
      await connection.commit();
      connection.release();
      return result;
    } catch (err) {
      try {
        await connection.rollback();
        connection.release();
      } catch {
        // The connection state is unknown; never hand it back to the pool.
        // The original error is more useful to the caller than the rollback failure.
        connection.destroy();
      }
      throw err;
    }
  }

  /**
   * Like `transaction`, but retries the WHOLE callback (bounded, with jitter) when MySQL aborts
   * it as a deadlock victim (1213) or on a lock-wait timeout (1205). Both roll back fully, so a
   * retry starts from a clean state. Use only for callbacks without side effects outside MySQL.
   */
  async transactionWithRetry<T>(
    callback: TransactionCallback<T>,
    options: { isolation?: 'READ COMMITTED'; attempts?: number } = {},
  ): Promise<T> {
    const attempts = options.attempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transaction(callback, options);
      } catch (err) {
        const errno = (err as { errno?: number }).errno;
        if ((errno !== 1213 && errno !== 1205) || attempt >= attempts) throw err;
        await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.random() * 20));
      }
    }
  }

  /** Lightweight connectivity check used by readiness probes. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /** Waits for in-flight queries, then closes all pooled connections. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

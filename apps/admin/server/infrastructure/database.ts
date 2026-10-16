import pg from 'pg'
import type { PoolClient } from 'pg'

export type Row = Record<string, unknown>
export interface SqlConnection {
  query<T extends Row = Row>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<T[]>
}
export interface Database extends SqlConnection {
  transaction<T>(
    operation: (connection: SqlConnection) => Promise<T>,
  ): Promise<T>
  lease(key: string): Promise<DatabaseLease | null>
  close(): Promise<void>
}
export interface DatabaseLease {
  /** Resolves only when the connection is unexpectedly lost, not on release. */
  lost: Promise<Error>
  release(): Promise<void>
}

export function createDatabase(connectionString: string): Database {
  const url = connectionString.replace(/^postgresql\+asyncpg:/, 'postgresql:')
  if (!/^postgres(ql)?:\/\//.test(url))
    throw new Error('PostgreSQL connection URL required')
  const pool = new pg.Pool({
    connectionString: url,
    max: 15,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })
  const leases = new Set<DatabaseLease>()
  pool.on('error', () => {
    console.error('An idle PostgreSQL connection failed')
  })
  function connection(client: PoolClient): SqlConnection {
    return {
      async query<T extends Row>(sql: string, values: readonly unknown[] = []) {
        const result = await client.query<T>(sql, [...values])
        return Array.isArray(result)
          ? result.flatMap((item) => item.rows)
          : result.rows
      },
    }
  }
  return {
    async query<T extends Row>(sql: string, values: readonly unknown[] = []) {
      const result = await pool.query<T>(sql, [...values])
      return Array.isArray(result)
        ? result.flatMap((item) => item.rows)
        : result.rows
    },
    async transaction<T>(
      operation: (client: SqlConnection) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect()
      let discard = false
      try {
        await client.query('BEGIN')
        const result = await operation(connection(client))
        await client.query('COMMIT')
        return result
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          discard = true
        }
        throw error
      } finally {
        client.release(discard)
      }
    },
    async lease(key: string): Promise<DatabaseLease | null> {
      const client = new pg.Client({
        connectionString: url,
        connectionTimeoutMillis: 10_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 5_000,
      })
      let released = false
      let reportLost!: (error: Error) => void
      const lost = new Promise<Error>((resolve) => {
        reportLost = resolve
      })
      const fail = (error: Error) => {
        if (!released) reportLost(error)
      }
      client.on('error', fail)
      client.on('end', () =>
        fail(new Error('PostgreSQL ownership connection closed')),
      )
      await client.connect()
      try {
        const result = await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
          [key],
        )
        if (!result.rows[0]?.acquired) {
          released = true
          await client.end()
          return null
        }
      } catch (error) {
        released = true
        await client.end()
        throw error
      }
      const heartbeat = setInterval(() => {
        void client.query('SELECT 1').catch(fail)
      }, 5_000)
      heartbeat.unref()
      const lease: DatabaseLease = {
        lost,
        async release() {
          if (released) return
          released = true
          clearInterval(heartbeat)
          leases.delete(lease)
          await client.end()
        },
      }
      leases.add(lease)
      return lease
    },
    async close() {
      await Promise.all([...leases].map((lease) => lease.release()))
      await pool.end()
    },
  }
}

export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

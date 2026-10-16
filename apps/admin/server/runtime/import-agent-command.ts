import { join } from 'node:path'
import type { Database, DatabaseLease } from '../infrastructure/database.ts'
import { schemaRevision } from '../infrastructure/schema.ts'
import { importAgentData } from './import-agent-data.ts'

export class AgentImportError extends Error {}

/** Offline entry: no schema writes, credentials, Docker access or Host startup. */
export async function importExistingAgentData(options: {
  database: Database
  dataDirectory: string
  sourceDirectory: string
  ownerUserId: string
  connectorId: string
}) {
  const { database } = options
  const controller = new AbortController()
  const leases: DatabaseLease[] = []
  const own = async (name: string, unavailable: string) => {
    const lease = await database.lease(name).catch(() => {
      throw new AgentImportError(
        'Cannot acquire database ownership; verify the saved database configuration',
      )
    })
    if (!lease) throw new AgentImportError(unavailable)
    leases.push(lease)
    void lease.lost.then(() =>
      controller.abort(
        new AgentImportError(
          'Database ownership was lost; the import was cancelled',
        ),
      ),
    )
  }
  try {
    await own(
      'superdsh:platform-api',
      'The platform is running; stop its API and Agents before importing data',
    )
    await own(
      `server-agent:${options.ownerUserId}`,
      'This user still has an active Agent; stop it before importing data',
    )
    let matches: boolean
    try {
      const revision = await database.query(
        'SELECT version_num FROM alembic_version',
      )
      if (revision.length !== 1 || revision[0]?.version_num !== schemaRevision)
        throw new AgentImportError(
          `Upgrade the database to ${schemaRevision} before importing Agent data; this command does not run migrations`,
        )
      const rows = await database.query(
        `SELECT s.owner_user_id, s.connector_id, c.user_id, c.executor_kind, u.deleted_at
         FROM server_agents s JOIN connectors c ON c.id=s.connector_id JOIN users u ON u.id=s.owner_user_id
         WHERE s.owner_user_id=$1 AND s.connector_id=$2`,
        [options.ownerUserId, options.connectorId],
      )
      matches =
        rows.length === 1 &&
        rows[0]?.user_id === options.ownerUserId &&
        rows[0]?.executor_kind === 'server-agent' &&
        !rows[0]?.deleted_at
    } catch (error) {
      if (error instanceof AgentImportError) throw error
      throw new AgentImportError(
        'Database ownership could not be verified; no data was imported',
      )
    }
    if (!matches)
      throw new AgentImportError(
        'User and Connector must match an existing server Agent binding owned by a non-deleted account',
      )
    controller.signal.throwIfAborted()
    try {
      return await importAgentData({
        sourceDirectory: options.sourceDirectory,
        rootDirectory: join(options.dataDirectory, 'agents'),
        ownerUserId: options.ownerUserId,
        connectorId: options.connectorId,
        signal: controller.signal,
      })
    } catch (error) {
      // The filesystem importer never handles connection strings or keys.
      throw new AgentImportError(
        error instanceof SyntaxError
          ? 'Export contains invalid runtime metadata; review the source locally'
          : error instanceof Error
            ? error.message
            : 'Agent data import failed',
      )
    }
  } finally {
    for (const lease of leases.reverse()) await lease.release()
  }
}

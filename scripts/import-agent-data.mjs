import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import {
  developmentEnvironment,
  developmentEnvFile,
} from './server-development.mjs'
import { createDatabase } from '../apps/admin/server/infrastructure/database.ts'
import { serverConfiguration } from '../apps/admin/server/infrastructure/configuration.ts'
import {
  AgentImportError,
  importExistingAgentData,
} from '../apps/admin/server/runtime/import-agent-command.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const usage =
  'Usage: yarn server:import-agent-data --source <absolute-export-directory> --user-id <stable-user-id> --connector-id <existing-connector-id> [--env <existing-production-env-file>]'

export function importArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (
      !['--source', '--user-id', '--connector-id', '--env'].includes(name) ||
      values[name] ||
      !args[index + 1] ||
      args[index + 1].startsWith('--')
    )
      throw new AgentImportError(usage)
    values[name] = args[++index]
  }
  if (
    !values['--source'] ||
    !isAbsolute(values['--source']) ||
    !values['--user-id'] ||
    !values['--connector-id']
  )
    throw new AgentImportError(usage)
  return {
    sourceDirectory: resolve(values['--source']),
    ownerUserId: values['--user-id'],
    connectorId: values['--connector-id'],
    envFile: values['--env'],
  }
}

export function importEnvironment(envFile, environment = process.env) {
  const selected = envFile || environment.SUPERDSH_SERVER_ENV
  const file = selected
    ? resolve(root, selected)
    : developmentEnvFile(root, environment)
  if (!existsSync(file))
    throw new AgentImportError(
      'The saved environment file is missing; restore it before importing. No new keys were generated.',
    )
  if (!selected) return developmentEnvironment(root, environment)
  return {
    ...parseEnv(readFileSync(file, 'utf8')),
    ...environment,
    SUPERDSH_BOOTSTRAP_DEV_ADMIN: '0',
  }
}

export async function runImport(args, environment = process.env) {
  const options = importArguments(args)
  const config = serverConfiguration(
    importEnvironment(options.envFile, environment),
  )
  const database = createDatabase(config.databaseUrl)
  try {
    const result = await importExistingAgentData({
      ...options,
      dataDirectory: config.dataDirectory,
      database,
    })
    console.log(`Imported ${result.copiedFiles} files into ${result.directory}`)
    console.log(
      `Relocated ${result.relocatedSessions} existing sessions to the native workspace; session IDs and conversation events were preserved.`,
    )
    console.log(
      `Skipped ${result.skipped.length} runtime/cache entries. Source and database records were not changed.`,
    )
    return result
  } finally {
    await database.close()
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.includes('--help')) console.log(usage)
  else
    try {
      await runImport(process.argv.slice(2))
    } catch (error) {
      console.error(
        error instanceof AgentImportError
          ? error.message
          : 'Agent import failed; verify the original environment, database connectivity and target permissions. Credentials are not printed.',
      )
      process.exitCode = 1
    }
}

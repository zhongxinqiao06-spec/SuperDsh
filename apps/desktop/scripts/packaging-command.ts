import { spawnSync } from 'node:child_process'

/** Execute the new application's gate once, with the caller's sanitized environment. */
export function runNextPackagingCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  _workspaceRoot: string,
): void {
  const result = spawnSync(command, [...args], { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`Packaging command failed (${result.status}): ${command}`)
}

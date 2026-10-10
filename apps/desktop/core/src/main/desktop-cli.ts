/** Packaged CLI delegates all Harness resolution to the engine plugin. */
import { fileURLToPath } from 'node:url'
import { runDesktopDshCli } from '@superdsh/harness/desktop-cli'
export * from '@superdsh/harness/desktop-cli'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runDesktopDshCli().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

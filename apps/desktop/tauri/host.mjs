/** Run the shared profile under Node and expose readiness and bounded shutdown to the Tauri parent. */
import { createRequire } from 'node:module'
import { stat } from 'node:fs/promises'
import { delimiter, dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const [cliManifest] = process.argv.slice(2)
const protocol = 'VERBOO_HOST_V1\t'
let outputOpen = true
const send = (message) => { if (outputOpen) process.stdout.write(`${protocol}${JSON.stringify(message)}\n`) }
let application
let stopping

/** Dispose the profile before the parent terminates Node; repeated requests share the same shutdown. */
function stop() {
  stopping ??= (async () => {
    const running = await application?.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    send({ type: 'stopped' })
    input.close()
    process.stdin.destroy()
  })()
  return stopping
}

const input = createInterface({ input: process.stdin })
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') { process.exitCode = 1 }
  outputOpen = false
  void stop()
})
input.on('line', (line) => {
  let request
  try { request = JSON.parse(line) } catch (error) {
    // A malformed parent message cannot become a command.
    send({ type: 'invalid-command' })
    return
  }
  if (request?.type === 'shutdown') void stop()
})
input.once('close', () => { void stop() })

async function boot() {
  if (cliManifest === undefined) throw new Error('missing-cli-manifest')
  // createRequire accepts nonexistent paths and NODE_PATH can otherwise select an unrelated CLI.
  if (!(await stat(cliManifest)).isFile()) throw new Error('invalid-cli-manifest')
  const require = createRequire(pathToFileURL(cliManifest))
  const { runProfile } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')).href)
  const { loadLayeredEnv } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const managerManifest = require.resolve('pnpm')
  const manager = require('pnpm')
  const managerEntry = resolve(dirname(managerManifest), manager.bin.pnpm)
  return runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'verboo',
    patchFiles: [],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    packageManager: {
      command: process.execPath,
      args: [managerEntry],
      env: { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` },
    },
  })
}

application = boot()
try {
  const { ctx } = await application
  if (stopping !== undefined || input.closed) {
    await stop()
  } else {
    const url = ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`)
    send({ type: 'ready', url })
  }
} catch (error) {
  // The parent displays its own localized failure; diagnostic payloads never contain configuration or credentials.
  send({ type: 'fatal', code: 'host_boot_failed' })
  const names = error instanceof Error ? [...new Set(error.message.match(/@deepseek-ai\/[a-z0-9-]+/g) ?? [])].slice(0, 5) : []
  console.error('Verboo Code: host_boot_failed', error instanceof Error ? error.name : 'Error', ...names)
  input.close()
  process.exitCode = 1
}

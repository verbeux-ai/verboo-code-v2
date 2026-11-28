/** Contracts between the product's update bridge and the native updater. */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFile(join(DESKTOP, path), 'utf8')

const UPDATE_COMMANDS = ['updates_status', 'updates_restart', 'updates_dismiss'] as const

describe('the product update bridge', () => {
  it('registers and grants the update commands used by the owned product window', async () => {
    const [bridge, main, permissions] = await Promise.all([
      read('tauri/bridge.js'),
      read('src-tauri/src/main.rs'),
      read('src-tauri/permissions/desktop.toml'),
    ])
    const product = /identifier = "desktop-native"[\s\S]*?commands\.allow = \[([^\]]*)\]/.exec(permissions)
    expect(product).not.toBeNull()
    expect(main).toContain('.window("main")')
    expect(main).toContain('.permission("desktop-native")')
    for (const command of UPDATE_COMMANDS) {
      expect(bridge).toContain(`invoke('${command}'`)
      expect(main).toContain(`update::${command}`)
      expect(product![1]).toContain(`"${command}"`)
    }
  })

  it('reports the phases used by the sidebar and polls while a download is active', async () => {
    const [bridge, update] = await Promise.all([
      read('tauri/bridge.js'),
      read('src-tauri/src/update.rs'),
    ])
    for (const phase of ['checking', 'downloading', 'ready', 'error']) {
      expect(update).toContain(`phase: "${phase}"`)
    }
    expect(bridge).toContain("phase === 'checking' || phase === 'downloading'")
    expect(bridge).toContain('listener(next)')
  })
})

describe('the staged update flow', () => {
  it('records the target before installation and clears it if installation fails', async () => {
    const update = await read('src-tauri/src/update.rs')
    const marker = update.indexOf('write_marker(app, APPLIED_FILE, version)')
    const install = update.indexOf('update.install(bytes)', marker)
    const failure = update.indexOf('Err(error) => {', install)
    expect(marker).toBeGreaterThan(0)
    expect(install).toBeGreaterThan(marker)
    expect(failure).toBeGreaterThan(install)
    expect(update.indexOf('remove_file(app, APPLIED_FILE)', failure)).toBeGreaterThan(failure)
    expect(update.indexOf('discard_staged(app)', failure)).toBeGreaterThan(failure)
  })

  it('checks that the staged version still matches the offered update before applying it', async () => {
    const update = await read('src-tauri/src/update.rs')
    const restart = update.slice(update.indexOf('pub async fn updates_restart'))
    expect(restart).toContain('staged(&app)')
    expect(restart).toContain('update.version != version')
    expect(restart.indexOf('update.version != version')).toBeLessThan(restart.indexOf('install_and_restart(&app'))
  })

  it('applies a staged update on the next launch and checks for updates in the background', async () => {
    const [main, update] = await Promise.all([
      read('src-tauri/src/main.rs'),
      read('src-tauri/src/update.rs'),
    ])
    expect(main).toContain('update::install(&app.handle())')
    expect(main).toContain('update::spawn(&app)')
    expect(update).toContain('apply_staged(app)')
    expect(update).toContain('std::thread::spawn')
    expect(update).toContain('update_check_failed')
    expect(update).not.toContain('startup_failure')
  })
})

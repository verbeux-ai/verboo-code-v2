/** Contracts between the product's update bridge and the native updater. */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFile(join(DESKTOP, path), 'utf8')

const UPDATE_COMMANDS = ['update_snapshot', 'update_restart', 'update_retry'] as const

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
    expect(product![1]).not.toContain('"update_install"')
    expect(product![1]).not.toContain('"update_close"')
  })

  it('publishes validated progress events used by the sidebar', async () => {
    const [bridge, update] = await Promise.all([
      read('tauri/bridge.js'),
      read('src-tauri/src/update.rs'),
    ])
    for (const phase of ['checking', 'downloading', 'ready', 'error']) {
      expect(update).toMatch(new RegExp(`(?:phase: |set_snapshot\\([^,]+, )"${phase}"`))
    }
    expect(update).toContain("window.dispatchEvent(new CustomEvent('verboo-update-state'")
    expect(bridge).toContain("window.addEventListener('verboo-update-state', onState)")
    expect(bridge).toContain('state = updateState(event.detail)')
    expect(bridge).toContain('listener(state)')
    expect(bridge).toContain("window.removeEventListener('verboo-update-state', onState)")
  })
})

describe('the staged update flow', () => {
  it('records the target before installation and clears it if installation fails', async () => {
    const update = await read('src-tauri/src/update.rs')
    const restart = update.slice(update.indexOf('pub async fn update_restart'), update.indexOf('fn retire_failed_cache'))
    const marker = restart.indexOf('write_marker(&app, APPLIED_FILE, &downloaded.update.version)')
    const install = restart.indexOf('downloaded.update.install(&bytes)', marker)
    const failure = restart.indexOf('Err(error) => {', install)
    expect(marker).toBeGreaterThan(0)
    expect(install).toBeGreaterThan(marker)
    expect(failure).toBeGreaterThan(install)
    expect(restart.indexOf('config_file(&app, APPLIED_FILE)', failure)).toBeGreaterThan(failure)
    expect(restart.indexOf('fs::remove_file(path)', failure)).toBeGreaterThan(failure)
    expect(restart.indexOf('requires_manual_recovery(&error)', failure)).toBeGreaterThan(failure)
  })

  it('revalidates the cached package against the offered update before shutting down the Host', async () => {
    const update = await read('src-tauri/src/update.rs')
    const restart = update.slice(update.indexOf('pub async fn update_restart'), update.indexOf('fn retire_failed_cache'))
    const verification = restart.indexOf('read_verified_package(&root, &downloaded.update)?')
    expect(verification).toBeGreaterThan(0)
    expect(restart.indexOf('stop_host.stop()')).toBeGreaterThan(verification)
    const verifier = update.slice(update.indexOf('fn read_verified_package'), update.indexOf('fn read_verified_staged'))
    expect(verifier).toContain('update.verify(&bytes)')
  })

  it('applies a staged update on the next launch and checks for updates in the background', async () => {
    const [main, update] = await Promise.all([
      read('src-tauri/src/main.rs'),
      read('src-tauri/src/update.rs'),
    ])
    expect(main).toContain('update::install(&app.handle())')
    const pendingInstall = main.indexOf('update::install_pending(&app')
    const hostStart = main.indexOf('HostProcess::start(&config', pendingInstall)
    expect(pendingInstall).toBeGreaterThan(0)
    expect(hostStart).toBeGreaterThan(pendingInstall)
    expect(main.indexOf('update::spawn(&app)', hostStart)).toBeGreaterThan(hostStart)
    expect(update).toContain('exclusive && install_pending_inner(app)')
    const background = update.slice(update.indexOf('pub fn spawn('), update.indexOf('#[cfg(test)]\nmod tests'))
    expect(background).toContain('std::thread::spawn')
    expect(background).toContain('monitor_or_download(app.clone())')
    expect(background).toContain('set_snapshot(&app, "error", None)')
    expect(background).not.toContain('startup_failure')
  })
})

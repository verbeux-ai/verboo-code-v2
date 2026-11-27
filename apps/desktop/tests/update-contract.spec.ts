/** Contracts between the product's update bridge and the native updater. */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFile(join(DESKTOP, path), 'utf8')

const UPDATE_COMMANDS = ['update_snapshot', 'update_restart', 'update_retry'] as const

function expectInOrder(source: string, tokens: readonly string[]): void {
  let previous = -1
  for (const token of tokens) {
    const position = source.indexOf(token, previous + 1)
    expect(position, token).toBeGreaterThan(previous)
    previous = position
  }
}

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

  it('validates the snapshot and subscribes to the same progress event the updater emits', async () => {
    const [bridge, update] = await Promise.all([
      read('tauri/bridge.js'),
      read('src-tauri/src/update.rs'),
    ])
    for (const phase of ['checking', 'downloading', 'ready', 'installing', 'error']) {
      expect(update).toMatch(new RegExp(`set_snapshot\\([^,]+, "${phase}",`))
      expect(bridge).toContain(`'${phase}'`)
    }
    expect(update).toContain("CustomEvent('verboo-update-state'")
    expect(bridge).toContain("updateState(await invoke('update_snapshot'))")
    expect(bridge).toContain('state = updateState(event.detail)')
    expect(bridge).toContain("addEventListener('verboo-update-state', onState)")
    expect(bridge).toContain("removeEventListener('verboo-update-state', onState)")
  })
})

describe('the staged update flow', () => {
  it('records the target before installation and clears it if installation fails', async () => {
    const update = await read('src-tauri/src/update.rs')
    expectInOrder(update, [
      'fn install_pending_inner(',
      'write_recovery_marker(app, &downloaded.update.version)',
      'write_marker(app, APPLIED_FILE, &downloaded.update.version)',
      'downloaded.update.install(&downloaded.bytes)',
      'Err(error) => {',
      'config_file(app, APPLIED_FILE)',
      'std::fs::remove_file(path)',
      'retire_failed_cache(&root, Some(&marker))',
    ])
  })

  it('checks the staged package against the selected signed update before stopping the Host', async () => {
    const update = await read('src-tauri/src/update.rs')
    expectInOrder(update, ['fn read_verified_package(', 'read_bounded(', 'update.verify(&bytes)'])
    expectInOrder(update, [
      'pub async fn update_restart(',
      'crate::owned_window(&window, &host)?',
      'inner.downloaded.take()',
      'lock_verification_gate(&coordination_root(&app)?)',
      'read_verified_package(&root, &downloaded.update)',
      'stop_host.stop()',
      'downloaded.update.install(&bytes)',
    ])
  })

  it('applies a staged update on the next launch and checks for updates in the background', async () => {
    const [main, update] = await Promise.all([
      read('src-tauri/src/main.rs'),
      read('src-tauri/src/update.rs'),
    ])
    expect(main).toContain('update::install(&app.handle())')
    expectInOrder(main, ['update::install_pending(&app', 'update::show_applied(&app)', 'update::spawn(&app)'])
    expectInOrder(update, ['pub fn install_pending(', 'install_pending_inner(app)'])
    expectInOrder(update, ['pub fn spawn(', 'std::thread::spawn', 'monitor_or_download(app.clone())', 'update_background_failed'])
  })
})

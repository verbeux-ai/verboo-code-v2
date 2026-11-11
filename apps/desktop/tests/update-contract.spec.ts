/**
 * Contract coverage tying the shipped pages to the Rust that drives them.
 *
 * A page and the module that injects its copy can drift without either side
 * failing on its own: a renamed role, a dropped script name, or an unused
 * translation all compile and all render. These assertions fail on that drift.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFile(join(DESKTOP, path), 'utf8')

const PAGES = {
  update: 'tauri/ui/update.html',
  updated: 'tauri/ui/updated.html',
} as const

const RUST = {
  logic: 'src-tauri/src/update_logic.rs',
  update: 'src-tauri/src/update.rs',
  main: 'src-tauri/src/main.rs',
  locale: 'src-tauri/src/locale.rs',
  permissions: 'src-tauri/permissions/desktop.toml',
} as const

/** Every `data-role` a page declares. */
function roles(html: string): string[] {
  return [...html.matchAll(/data-role="([a-z-]+)"/g)].map(match => match[1]!)
}

/** Every `window.__x` global a page reads. */
function globals(html: string): string[] {
  return [...new Set([...html.matchAll(/window\.(__VERBOO_[A-Z_]+?)__(?!_)/g)].map(match => match[1]! + '__'))]
}

/** Every `window.__x(...)` function a page defines or calls. */
function functions(html: string): string[] {
  return [...new Set([...html.matchAll(/window\.(__[a-zA-Z]+)\s*[=(]/g)].map(match => match[1]!))]
}

describe('the pages and the Rust agree on names', () => {
  it('assigns the global each page reads', async () => {
    const logic = await read(RUST.logic)
    const updatePage = await read(PAGES.update)
    const updatedPage = await read(PAGES.updated)

    // The assignment name and the read name are the same string on both sides.
    for (const [page, global] of [
      [updatePage, '__VERBOO_UPDATE__'],
      [updatedPage, '__VERBOO_UPDATED__'],
    ] as const) {
      expect(globals(page)).toContain(global)
      expect(logic).toContain(`"${global}"`)
    }
  })

  it('defines every window function the Rust evaluates', async () => {
    // The builders live in the logic module; the indeterminate arm is emitted
    // from the command that owns the download, so both files can emit.
    const rust = (await read(RUST.logic)) + (await read(RUST.update))
    const page = await read(PAGES.update)
    const defined = functions(page)

    // Each statement the Rust emits calls a function the page defines.
    for (const called of ['__enterProgress', '__setProgress', '__setIndeterminate', '__fail']) {
      expect(defined, `${called} is not defined by the page`).toContain(called)
      expect(rust, `${called} is not emitted by the Rust`).toContain(`window.${called}`)
    }
  })

  it('renders every role the page script writes to', async () => {
    for (const path of Object.values(PAGES)) {
      const html = await read(path)
      const declared = roles(html)
      const used = [...new Set([...html.matchAll(/role\('([a-z-]+)'\)/g)].map(match => match[1]!))]
      for (const role of used) {
        expect(declared, `${path} reads undefined role ${role}`).toContain(role)
      }
    }
  })

  it('declares every command the pages invoke', async () => {
    const main = await read(RUST.main)
    const permissions = await read(RUST.permissions)
    const invoked = new Set<string>()
    for (const path of Object.values(PAGES)) {
      const html = await read(path)
      for (const match of html.matchAll(/invoke\('([a-z_]+)'\)/g)) invoked.add(match[1]!)
    }
    expect([...invoked].sort()).toEqual(['update_close', 'update_install'])
    for (const command of invoked) {
      // Registered as a handler, allowed by the update window's capability, and
      // exported from the module that defines it.
      expect(main, `${command} is not registered`).toContain(`update::${command}`)
      expect(permissions, `${command} is not permitted`).toContain(`"${command}"`)
    }
  })

  it('keeps the update commands off the product window capability', async () => {
    const permissions = await read(RUST.permissions)
    const product = /identifier = "desktop-native"[\s\S]*?commands\.allow = \[([^\]]*)\]/.exec(permissions)
    expect(product).not.toBeNull()
    expect(product![1]).not.toContain('update_install')
    expect(product![1]).not.toContain('update_close')
  })

  it('guards each command by the window label it accepts', async () => {
    const update = await read(RUST.update)
    // Both commands refuse a label that is not one of the two update windows.
    expect(update).toContain('window.label() != UPDATE_WINDOW && window.label() != UPDATED_WINDOW')
    expect(update).toContain('window.label() != UPDATE_WINDOW {')
  })
})

describe('the windows are described as the product window is', () => {
  it('uses the same product identity and a fixed size', async () => {
    const update = await read(RUST.update)
    // Undecorated, fixed, centered, and above the product window it belongs to.
    for (const option of ['.decorations(false)', '.resizable(false)', '.center()', '.always_on_top(true)']) {
      expect(update, `missing ${option}`).toContain(option)
    }
    expect(update).toContain('.title("Verboo Code")')
  })

  it('loads a packaged document rather than a remote origin', async () => {
    const update = await read(RUST.update)
    for (const page of ['update.html', 'updated.html', 'index.html']) {
      if (page === 'index.html') continue
      expect(update).toContain(`WebviewUrl::App("${page}".into())`)
    }
    // A remote URL here would put product chrome on a network origin.
    expect(update).not.toMatch(/WebviewUrl::External/)
  })

  it('keeps the shipped fonts and license beside the pages', async () => {
    const updatePage = await read(PAGES.update)
    expect(updatePage).toContain("url('fonts/nunito-latin-variable.woff2')")
    expect(updatePage).toContain("url('fonts/nunito-latin-ext-variable.woff2')")
    // The full-range copy is the one the notice uses; both must be shipped.
    const licence = await read('tauri/ui/fonts/OFL-Nunito.txt')
    expect(licence).toContain('SIL OPEN FONT LICENSE')
  })

  it('never hardcodes copy in the pages', async () => {
    for (const path of Object.values(PAGES)) {
      const html = await read(path)
      // Every visible string arrives from the Rust copy; the only literals are
      // the static brand wordmark and the document title.
      expect(html).toContain('Verboo Code')
      const script = html.split('<script>')[1] ?? ''
      // No long English-looking literal is assigned to a role.
      expect(script).not.toMatch(/role\('(?:title|body|status|percent)'\)\.textContent = '[^']{4,}'/)
    }
  })
})

describe('the update flow keeps its guarantees', () => {
  it('records the installed version before restarting', async () => {
    const update = await read(RUST.update)
    const applied = update.indexOf('write_marker(&app, APPLIED_FILE, &version)')
    const restart = update.indexOf('app.restart()')
    expect(applied).toBeGreaterThan(0)
    expect(restart).toBeGreaterThan(applied)
  })

  it('shows the applied notice once and clears its marker', async () => {
    const update = await read(RUST.update)
    expect(update).toContain('remove_file(path)')
    // The marker is removed before the window opens, so a failure cannot repeat it.
    const removed = update.indexOf('remove_file(path)')
    const built = update.indexOf('WebviewWindowBuilder::new(app, UPDATED_WINDOW')
    expect(removed).toBeLessThan(built)
  })

  it('declines silently and never blocks startup', async () => {
    const update = await read(RUST.update)
    // A failed check is a log line, not a startup failure.
    expect(update).toContain('update_check_failed')
    expect(update).not.toContain('startup_failure')
    expect(update).toContain('if cfg!(debug_assertions)')
  })

  it('takes the offered update exactly once', async () => {
    const update = await read(RUST.update)
    expect(update).toContain('state.0.lock().ok().and_then(|mut slot| slot.take())')
    // A second confirm cannot install twice.
    expect(update).toContain('update_install_unprepared')
  })
})

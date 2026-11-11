/**
 * Real-DOM integration coverage for the update windows.
 *
 * The pages are loaded as shipped and driven exactly as the Rust commands drive
 * them: the offer copy is injected before the document parses, the install command
 * swaps in the running state, and progress arrives as the statements the updater
 * evaluates. Each case starts from a fresh document, and several cases run in
 * sequence to prove the states compose rather than only work alone.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const UI = join(dirname(fileURLToPath(import.meta.url)), '../tauri/ui')

/** Copy the Rust pump emitted for every shipped language. */
const COPY = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/update-copy.json'), 'utf8'),
) as Record<string, {
  version: string
  title: string
  body: string
  install: string
  later: string
  close: string
  failed: string
  running: { title: string; body: string; status: string }
  applied: { title: string; body: string; dwellMs: number }
}>

const LANGUAGES = Object.keys(COPY)

/** One rendered window with the Tauri bridge it talks to. */
interface Window {
  dom: JSDOM
  invoke: ReturnType<typeof vi.fn>
  role: (name: string) => HTMLElement
  click: (name: string) => void
  evalInPage: (script: string) => void
}

const open: Window[] = []

afterEach(() => {
  for (const window of open.splice(0)) window.dom.window.close()
})

/**
 * Load one shipped page with the copy variable the Rust script assigns.
 * @param file - the page inside the packaged UI directory.
 * @param variable - the window variable the page reads its copy from.
 * @param payload - the value Rust injects.
 * @returns the rendered document and its bridge.
 */
async function render(
  file: string,
  variable: string,
  payload: unknown,
): Promise<Window> {
  const html = await readFile(join(UI, file), 'utf8')
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://tauri.localhost/',
    beforeParse(window) {
      // The Rust side assigns the copy before the document script runs.
      ;(window as unknown as Record<string, unknown>)[variable] = payload
      const invoke = vi.fn(async () => undefined)
      ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke }
      ;(window as unknown as Record<string, { invoke: typeof invoke }>).__bridge = { invoke }
    },
  })
  const window = dom.window as unknown as {
    document: Document
    eval: (script: string) => void
    __bridge: { invoke: ReturnType<typeof vi.fn> }
  }
  const role = (name: string) => {
    const element = window.document.querySelector<HTMLElement>(`[data-role="${name}"]`)
    if (element === null) throw new Error(`missing role ${name}`)
    return element
  }
  const rendered: Window = {
    dom,
    invoke: window.__bridge.invoke,
    role,
    click: (name) => { role(name).click() },
    evalInPage: (script) => { window.eval(script) },
  }
  open.push(rendered)
  return rendered
}

/** Load the offer page for one language. */
async function offer(language = 'pt') {
  const copy = COPY[language]!
  return {
    copy,
    window: await render('update.html', '__VERBOO_UPDATE__', copy),
  }
}

describe('the update offer window', () => {
  it.each(LANGUAGES)('shows its copy in %s', async (language) => {
    const { copy, window } = await offer(language)
    expect(window.role('title').textContent).toBe(copy.title)
    expect(window.role('body').textContent).toBe(copy.body)
    expect(window.role('install').textContent).toBe(copy.install)
    expect(window.role('later').textContent).toBe(copy.later)
    expect(window.role('version').textContent).toBe(copy.version)
  })

  it('starts with the progress bar hidden and buttons in the flow', async () => {
    const { window } = await offer()
    expect(window.role('progress').hidden).toBe(true)
    expect(window.role('install').hidden).toBe(false)
    expect(window.role('later').hidden).toBe(false)
    expect(window.role('install').textContent).not.toBe('')
  })

  it('focuses the confirm button so the window is usable from the keyboard', async () => {
    const { window } = await offer()
    expect(window.dom.window.document.activeElement).toBe(window.role('install'))
  })

  it('confirms the installation once and disables both buttons', async () => {
    const { window } = await offer()
    window.click('install')
    await vi.waitFor(() => { expect(window.invoke).toHaveBeenCalledTimes(1) })
    expect(window.invoke).toHaveBeenCalledWith('update_install')
    expect((window.role('install') as HTMLButtonElement).disabled).toBe(true)
    expect((window.role('later') as HTMLButtonElement).disabled).toBe(true)
  })

  it('declines through the close command without installing', async () => {
    const { window } = await offer()
    window.click('later')
    await vi.waitFor(() => { expect(window.invoke).toHaveBeenCalledTimes(1) })
    expect(window.invoke).toHaveBeenCalledWith('update_close')
  })

  it('declines on Escape before the download starts', async () => {
    const { window } = await offer()
    window.dom.window.document.dispatchEvent(
      new window.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await vi.waitFor(() => { expect(window.invoke).toHaveBeenCalledWith('update_close') })
  })

  it('reports a refused install instead of freezing the window', async () => {
    const { copy, window } = await offer()
    window.invoke.mockRejectedValueOnce(new Error('update_install_unprepared'))
    window.click('install')
    await vi.waitFor(() => { expect(window.role('status').textContent).toBe(copy.failed) })
    expect(window.role('status').classList.contains('failure')).toBe(true)
    // The only way out is the dismiss button, which now reads as a close action.
    expect(window.role('later').hidden).toBe(false)
    expect(window.role('later').textContent).toBe(copy.close)
    expect((window.role('install') as HTMLButtonElement).hidden).toBe(true)
  })

  it('does not answer Escape once the download is running', async () => {
    const { copy, window } = await offer()
    window.evalInPage(`window.__enterProgress(${JSON.stringify(copy.running)})`)
    window.dom.window.document.dispatchEvent(
      new window.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    // The window must survive: the app restarts on its own when it finishes.
    expect(window.invoke).not.toHaveBeenCalled()
  })
})

describe('the running state', () => {
  it('swaps the offer for progress and keeps the restart promise visible', async () => {
    const { copy, window } = await offer()
    window.evalInPage(`window.__enterProgress(${JSON.stringify(copy.running)})`)
    expect(window.role('progress').hidden).toBe(false)
    expect(window.role('title').textContent).toBe(copy.running.title)
    expect(window.role('body').textContent).toBe(copy.running.body)
    expect(window.role('status').textContent).toBe(copy.running.status)
    expect(window.role('install').hidden).toBe(true)
    expect(window.role('later').hidden).toBe(true)
  })

  it('exposes the bar as a progressbar with a bounded range', async () => {
    const { copy, window } = await offer()
    window.evalInPage(`window.__enterProgress(${JSON.stringify(copy.running)})`)
    const bar = window.role('progress')
    expect(bar.getAttribute('role')).toBe('progressbar')
    expect(bar.getAttribute('aria-label')).toBe(copy.running.status)
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    expect(bar.getAttribute('aria-valuenow')).toBe('0')
  })

  it.each([
    [0, '0%', '0%'],
    [0.42, '42%', '42%'],
    [1, '100%', '100%'],
  ])('shows %s as %s', (ratio, width, label) => {
    return offer().then(({ copy, window }) => {
      window.evalInPage(`window.__enterProgress(${JSON.stringify(copy.running)})`)
      window.evalInPage(`window.__setProgress(${ratio})`)
      expect(window.role('fill').style.width).toBe(width)
      expect(window.role('percent').textContent).toBe(label)
      expect(window.role('progress').getAttribute('aria-valuenow')).toBe(label.replace('%', ''))
    })
  })

  it('shows motion instead of a percentage when the feed reports no length', async () => {
    const { copy, window } = await offer()
    window.evalInPage(`window.__enterProgress(${JSON.stringify(copy.running)})`)
    window.evalInPage('window.__setIndeterminate()')
    expect(window.role('fill').dataset.indeterminate).toBe('true')
    expect(window.role('percent').textContent).toBe('')
    // No number is announced, so assistive technology reports indeterminate.
    expect(window.role('progress').getAttribute('aria-valuenow')).toBeNull()
  })

  it('returns to a stated percentage when a length becomes known', async () => {
    const { copy, window } = await offer()
    window.evalInPage(`window.__enterProgress(${JSON.stringify(copy.running)})`)
    window.evalInPage('window.__setIndeterminate()')
    window.evalInPage('window.__setProgress(0.6)')
    expect(window.role('fill').dataset.indeterminate).toBe('false')
    expect(window.role('fill').style.width).toBe('60%')
    expect(window.role('percent').textContent).toBe('60%')
  })

  it('marks a failure with an error state and a dismiss action', async () => {
    const { copy, window } = await offer()
    window.evalInPage(`window.__enterProgress(${JSON.stringify(copy.running)})`)
    window.evalInPage(`window.__fail(${JSON.stringify(copy.failed)})`)
    expect(window.role('status').textContent).toBe(copy.failed)
    expect(window.role('status').classList.contains('failure')).toBe(true)
    expect(window.role('fill').style.width).toBe('100%')
    expect(window.role('fill').style.background).toContain('--danger')
    expect(window.role('later').hidden).toBe(false)
    expect((window.role('install') as HTMLButtonElement).hidden).toBe(true)
  })
})

describe('a whole update, state after state', () => {
  it('goes from offer to progress to failure without leaking the previous state', async () => {
    const { copy, window } = await offer('pt')

    // 1. Offer.
    expect(window.role('title').textContent).toBe(copy.title)
    expect(window.role('progress').hidden).toBe(true)

    // 2. The user confirms; the window switches to progress at zero.
    window.evalInPage(`window.__enterProgress(${JSON.stringify(copy.running)})`)
    expect(window.role('progress').getAttribute('aria-valuenow')).toBe('0')

    // 3. The download advances through the statements the updater evaluates.
    for (const ratio of [0.25, 0.5, 0.75]) {
      window.evalInPage(`window.__setProgress(${ratio})`)
    }
    expect(window.role('percent').textContent).toBe('75%')

    // 4. The install fails; the percentage and the bar's range both go away.
    window.evalInPage(`window.__fail(${JSON.stringify(copy.failed)})`)
    expect(window.role('percent').textContent).toBe('')
    expect(window.role('progress').getAttribute('aria-valuenow')).toBeNull()
    expect(window.role('progress').getAttribute('aria-label')).toBeNull()
    expect(window.role('status').textContent).toBe(copy.failed)

    // 5. Dismissing reports the same command the decline button uses.
    window.click('later')
    await vi.waitFor(() => { expect(window.invoke).toHaveBeenCalledWith('update_close') })
  })

  it('never shows two actions at once', async () => {
    const { copy, window } = await offer()
    const visible = () =>
      ['install', 'later'].filter(name => !window.role(name).hidden)

    expect(visible()).toEqual(['install', 'later'])
    window.evalInPage(`window.__enterProgress(${JSON.stringify(copy.running)})`)
    expect(visible()).toEqual([])
    window.evalInPage(`window.__fail(${JSON.stringify(copy.failed)})`)
    expect(visible()).toEqual(['later'])
  })

  it('survives repeated progress statements without drifting', async () => {
    const { copy, window } = await offer()
    window.evalInPage(`window.__enterProgress(${JSON.stringify(copy.running)})`)
    // The updater skips redundant percentages, but the window must also stay
    // correct if the same statement arrives twice.
    for (let index = 0; index < 5; index += 1) window.evalInPage('window.__setProgress(0.3)')
    expect(window.role('percent').textContent).toBe('30%')
    expect(window.role('fill').style.width).toBe('30%')
  })
})

describe('the applied notice', () => {
  it.each(LANGUAGES)('thanks the user in %s', async (language) => {
    const copy = COPY[language]!
    const window = await render('updated.html', '__VERBOO_UPDATED__', copy.applied)
    expect(window.role('title').textContent).toBe(copy.applied.title)
    expect(window.role('body').textContent).toBe(copy.applied.body)
  })

  it('names the version that is now running', async () => {
    const window = await render('updated.html', '__VERBOO_UPDATED__', COPY.pt!.applied)
    expect(window.role('body').textContent).toContain('0.2.2-alpha.13')
  })

  it('closes itself after the dwell the Rust side chose', async () => {
    vi.useFakeTimers()
    try {
      const payload = { ...COPY.en!.applied, dwellMs: 1200 }
      const window = await render('updated.html', '__VERBOO_UPDATED__', payload)
      expect(window.invoke).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1199)
      expect(window.invoke).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => { expect(window.invoke).toHaveBeenCalledWith('update_close') })
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * End-to-end coverage for the update windows in a real browser.
 *
 * Each case serves the packaged UI from a loopback origin, exactly as Tauri serves
 * it, so every relative asset — the mascot, both Nunito faces — resolves the way it
 * does in the shipped application. A local feed stands in for the release server,
 * and a scripted bridge stands in for the Rust commands so the download can be
 * driven step by step without installing anything.
 */
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// This spec lives in apps/web/tests; the packaged UI belongs to apps/desktop.
const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '../../desktop')
const UI = join(DESKTOP, 'tauri/ui')
const FONTS = join(dirname(fileURLToPath(import.meta.url)), '../public/fonts')
const ARTIFACTS = process.env.UPDATE_QA_DIR ?? join(tmpdir(), 'verboo-update-qa')

const COPY = JSON.parse(
  await readFile(join(DESKTOP, 'tests/fixtures/update-copy.json'), 'utf8'),
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

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/** Serve the packaged UI plus the fonts it references. */
async function serveUi(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]!
    const file = path.startsWith('/fonts/')
      ? join(FONTS, path.slice('/fonts/'.length))
      : join(UI, path === '/' ? 'index.html' : path)
    readFile(file).then(
      (body) => {
        response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
        response.end(body)
      },
      () => { response.writeHead(404).end('not found') },
    )
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('ui server did not start')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

/** One loaded page with its recorded bridge calls. */
interface Loaded {
  page: Page
  calls: string[]
}

let browser: Browser
let ui: { server: Server; origin: string }

beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true })
  ui = await serveUi()
  browser = await chromium.launch()
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => { ui?.server.close(() => { resolve() }) })
})

/**
 * Load one update page with the copy Rust injects and a recording bridge.
 * @param file - page inside the packaged UI directory.
 * @param variable - window variable carrying the copy.
 * @param payload - value Rust assigns before the document script runs.
 * @returns the page and the commands it invoked.
 */
async function open(file: string, variable: string, payload: unknown): Promise<Loaded> {
  const page = await browser.newPage({ viewport: { width: 468, height: 308 } })
  const calls: string[] = []
  await page.addInitScript(({ variable, payload }) => {
    ;(window as unknown as Record<string, unknown>)[variable] = payload
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: (command: string) => {
        ;(window as unknown as { __calls: string[] }).__calls.push(command)
        return Promise.resolve()
      },
    }
    ;(window as unknown as { __calls: string[] }).__calls = []
  }, { variable, payload })
  await page.goto(`${ui.origin}/${file}`, { waitUntil: 'load' })
  // Mirror the bridge's own record into the test process.
  const read = async () => {
    const recorded = await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)
    calls.splice(0, calls.length, ...recorded)
    return calls
  }
  loaded.set(page, read)
  return { page, calls }
}

const loaded = new Map<Page, () => Promise<string[]>>()

/** Read the commands a page invoked so far. */
async function commands(entry: Loaded): Promise<string[]> {
  const read = loaded.get(entry.page)
  return read === undefined ? entry.calls : await read()
}

const role = (entry: Loaded, name: string) =>
  entry.page.locator(`[data-role="${name}"]`)

/** Wait for one locator's text. */
const text = (entry: Loaded, name: string) =>
  expect.poll(() => role(entry, name).textContent(), { timeout: 8000 })

/** Wait for one locator's visibility. */
const shown = (entry: Loaded, name: string, want: boolean) =>
  expect.poll(() => role(entry, name).isVisible(), { timeout: 8000 }).toBe(want)

/** Whether a locator is disabled. */
const disabled = (entry: Loaded, name: string) =>
  role(entry, name).evaluate(node => (node as HTMLButtonElement).disabled)

describe('the update offer window in a browser', () => {
  it('renders the offer with every packaged asset loaded', async () => {
    const entry = await open('update.html', '__VERBOO_UPDATE__', COPY.pt!)
    const copy = COPY.pt!

    await text(entry, 'title').toBe(copy.title)
    await text(entry, 'body').toBe(copy.body)
    await text(entry, 'install').toBe(copy.install)
    await text(entry, 'later').toBe(copy.later)

    // The mascot is a real image, not a broken reference.
    const mascot = entry.page.locator('header img')
    expect(await mascot.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)

    // The brand face loaded, so the window matches the product identity.
    const fontFamily = await entry.page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue('font-family'))
    expect(fontFamily).toContain('Verboo Nunito')
    const fontsReady = await entry.page.evaluate(async () => {
      await document.fonts.ready
      return [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family)
    })
    expect(fontsReady).toContain('Verboo Nunito')

    await entry.page.screenshot({ path: join(ARTIFACTS, 'offer.png'), animations: 'disabled' })
    await entry.page.close()
  })

  it('has no console errors or failed requests', async () => {
    const page = await browser.newPage({ viewport: { width: 468, height: 308 } })
    const problems: string[] = []
    page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()) })
    page.on('pageerror', (error) => { problems.push(String(error)) })
    page.on('requestfailed', (request) => { problems.push(`failed ${request.url()}`) })
    await page.addInitScript((payload) => {
      ;(window as unknown as Record<string, unknown>).__VERBOO_UPDATE__ = payload
      ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: () => Promise.resolve() }
    }, COPY.en as unknown as string)
    await page.goto(`${ui.origin}/update.html`, { waitUntil: 'networkidle' })
    expect(problems).toEqual([])
    await page.close()
  })

  it('offers the confirm action and reports it once', async () => {
    const entry = await open('update.html', '__VERBOO_UPDATE__', COPY.pt!)
    await role(entry, 'install').click()
    await expect.poll(() => commands(entry)).toEqual(['update_install'])
    expect(await disabled(entry, 'install')).toBe(true)
    expect(await disabled(entry, 'later')).toBe(true)
    await entry.page.close()
  })

  it('declines without installing', async () => {
    const entry = await open('update.html', '__VERBOO_UPDATE__', COPY.pt!)
    await role(entry, 'later').click()
    await expect.poll(() => commands(entry)).toEqual(['update_close'])
    await entry.page.close()
  })

  it('closes on Escape while the offer is shown', async () => {
    const entry = await open('update.html', '__VERBOO_UPDATE__', COPY.pt!)
    await entry.page.keyboard.press('Escape')
    await expect.poll(() => commands(entry)).toEqual(['update_close'])
    await entry.page.close()
  })
})

describe('the running window in a browser', () => {
  it('fills the bar as the download advances, then fails gracefully', async () => {
    const copy = COPY.pt!
    const entry = await open('update.html', '__VERBOO_UPDATE__', copy)

    await entry.page.evaluate((value) => {
      ;(window as unknown as { __enterProgress: (input: unknown) => void }).__enterProgress(value)
    }, copy.running)
    await shown(entry, 'progress', true)
    await text(entry, 'title').toBe(copy.running.title)
    await text(entry, 'status').toBe(copy.running.status)
    await shown(entry, 'install', false)
    await shown(entry, 'later', false)

    // Walk the bar the way the updater reports chunks.
    for (const ratio of [0.1, 0.35, 0.7, 1]) {
      await entry.page.evaluate((value) => {
        ;(window as unknown as { __setProgress: (ratio: number) => void }).__setProgress(value)
      }, ratio)
    }
    await text(entry, 'percent').toBe('100%')
    const width = await role(entry, 'fill').evaluate(node => (node as HTMLElement).style.width)
    expect(width).toBe('100%')
    await entry.page.screenshot({ path: join(ARTIFACTS, 'progress-complete.png'), animations: 'disabled' })

    await entry.page.evaluate((message) => {
      ;(window as unknown as { __fail: (value: string) => void }).__fail(message)
    }, copy.failed)
    await text(entry, 'status').toBe(copy.failed)
    await shown(entry, 'later', true)
    await text(entry, 'later').toBe(copy.close)
    await entry.page.screenshot({ path: join(ARTIFACTS, 'progress-failed.png'), animations: 'disabled' })

    await role(entry, 'later').click()
    await expect.poll(() => commands(entry)).toEqual(['update_close'])
    await entry.page.close()
  })

  it('shows motion rather than a percentage without a content length', async () => {
    const copy = COPY.en!
    const entry = await open('update.html', '__VERBOO_UPDATE__', copy)
    await entry.page.evaluate((value) => {
      ;(window as unknown as { __enterProgress: (input: unknown) => void }).__enterProgress(value)
    }, copy.running)
    await entry.page.evaluate(() => {
      ;(window as unknown as { __setIndeterminate: () => void }).__setIndeterminate()
    })
    await text(entry, 'percent').toBe('')
    await expect.poll(() => role(entry, 'fill').getAttribute('data-indeterminate')).toBe('true')
    // The sweep is an animation, so the bar is visibly alive.
    const animation = await role(entry, 'fill').evaluate(node => getComputedStyle(node).animationName)
    expect(animation).not.toBe('none')
    await entry.page.screenshot({ path: join(ARTIFACTS, 'progress-indeterminate.png'), animations: 'disabled' })
    await entry.page.close()
  })

  it('keeps the promise that the app restarts on its own', async () => {
    const entry = await open('update.html', '__VERBOO_UPDATE__', COPY.pt!)
    // The window states the restart before the user confirms anything.
    await expect.poll(async () => (await role(entry, 'body').textContent()) ?? '').toContain('reinicia sozinho')
    await entry.page.close()
  })
})

describe('the applied notice in a browser', () => {
  it('thanks the user and closes itself', async () => {
    const entry = await open('updated.html', '__VERBOO_UPDATED__', { ...COPY.pt!.applied, dwellMs: 800 })
    await expect.poll(async () => (await role(entry, 'title').textContent()) ?? '').toBe(COPY.pt!.applied.title)
    await expect.poll(async () => (await role(entry, 'body').textContent()) ?? '').toContain('0.2.2-alpha.13')
    await entry.page.screenshot({ path: join(ARTIFACTS, 'applied.png'), animations: 'disabled' })
    // It leaves on its own, so the user never has to dismiss a celebration.
    await expect.poll(() => commands(entry), { timeout: 6000 }).toEqual(['update_close'])
    await entry.page.close()
  })
})

describe('both windows under both themes and a narrow viewport', () => {
  // Sizes match the windows the Rust builder creates.
  const cases = [
    ['offer', 'update.html', '__VERBOO_UPDATE__', 'light', 468, 308],
    ['offer', 'update.html', '__VERBOO_UPDATE__', 'dark', 468, 308],
    ['applied', 'updated.html', '__VERBOO_UPDATED__', 'light', 428, 112],
    ['applied', 'updated.html', '__VERBOO_UPDATED__', 'dark', 428, 112],
  ] as const

  for (const [name, file, variable, theme, width, height] of cases) {
    it(`renders ${name} in ${theme} without overflow`, async () => {
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme })
      await page.addInitScript(({ variable, payload }) => {
        ;(window as unknown as Record<string, unknown>)[variable] = payload
        ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: () => Promise.resolve() }
      }, { variable, payload: name === 'offer' ? COPY.pt! : COPY.pt!.applied })
      await page.goto(`${ui.origin}/${file}`, { waitUntil: 'load' })

      // Measure the settled layout: the entrance animation starts a few pixels
      // lower on purpose, so its first frame is not the steady state.
      const overflow = await page.evaluate(() => {
        for (const animation of document.getAnimations()) animation.finish()
        return {
          x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        }
      })
      expect(overflow.x).toBeLessThanOrEqual(0)
      expect(overflow.y).toBeLessThanOrEqual(0)

      // The surface follows the theme instead of staying white.
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
      expect(background).toBe(theme === 'dark' ? 'rgb(10, 10, 10)' : 'rgb(255, 255, 255)')

      await page.screenshot({ path: join(ARTIFACTS, `${name}-${theme}.png`), animations: 'disabled' })
      await page.close()
    })
  }
})

// @vitest-environment jsdom
/** One policy decides every external destination; refusals publish a notice. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExternalLinkDeps, ExternalLinkFailure, ExternalLinkWindow } from '../src/client/links.ts'
import { ExternalLinks, activateHandoff, openableUrl } from '../src/client/links.ts'

/** A granted popup whose calls the assertions inspect. */
interface TestPopup extends ExternalLinkWindow {
  readonly close: ReturnType<typeof vi.fn<() => void>>
  readonly location: { replace: ReturnType<typeof vi.fn<(url: string) => void>> }
}

function popup(closed = false): TestPopup {
  return { closed, opener: {} as Window, close: vi.fn<() => void>(), location: { replace: vi.fn<(url: string) => void>() } }
}

function bench(overrides: Partial<ExternalLinkDeps> = {}) {
  const reported: ExternalLinkFailure[] = []
  const openWindow = vi.fn<(url: string) => ExternalLinkWindow | null>(() => popup())
  const openSidebar = vi.fn<(url: string) => void>()
  const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve())
  const deps: ExternalLinkDeps = {
    native: undefined,
    openWindow,
    sidebar: () => true,
    openSidebar,
    preference: () => 'sidebar',
    report: (failure) => { reported.push(failure) },
    ...overrides,
  }
  return { links: new ExternalLinks(deps), openWindow, openSidebar, openExternal, reported }
}

afterEach(() => { vi.restoreAllMocks() })

describe('openableUrl', () => {
  it.each([
    ['https://example.com/a?b=1', true],
    ['http://127.0.0.1:8080/health', true],
    ['http://localhost/', true],
    ['http://[::1]:3000/', true],
    ['mailto:dev@example.com', true],
    ['tel:+5511999999999', true],
    ['http://example.com/', true],
    ['file:///etc/passwd', false],
    ['ftp://example.com/x', false],
    ['ssh://git@example.com/repo', false],
    ['javascript:alert(1)', false],
    ['data:text/html,<b>x</b>', false],
    ['blob:https://example.com/id', false],
    ['verboo://open', false],
    ['/settings', false],
    ['example.com', false],
    ['https://user:secret@example.com/', false],
  ])('accepts only the allowlisted destination shape: %s', (value, accepted) => {
    expect(openableUrl(value) === undefined).toBe(!accepted)
  })
})

describe('ExternalLinks', () => {
  it('opens a Desktop destination through the native bridge and never a popup', async () => {
    const b = bench()
    const native = bench({ native: { openExternal: b.openExternal } })
    await expect(native.links.open('https://example.com/a')).resolves.toBe('native')
    expect(b.openExternal).toHaveBeenCalledWith('https://example.com/a')
    expect(native.openWindow).not.toHaveBeenCalled()
    expect(native.openSidebar).not.toHaveBeenCalled()
    expect(native.reported).toEqual([])
  })

  it('reports a native refusal instead of claiming the system browser opened it', async () => {
    const refused = () => Promise.reject(new Error('external_url_invalid'))
    const browsable = bench({ native: { openExternal: refused } })
    await expect(browsable.links.open('https://example.com/a')).resolves.toBe('blocked')
    expect(browsable.reported).toEqual(['nativeFailed'])
    const handoff = bench({ native: { openExternal: refused } })
    await expect(handoff.links.open('mailto:dev@example.com')).resolves.toBe('blocked')
    expect(handoff.reported).toEqual(['unsupported'])
  })

  it('opens a browsable destination in the Sidebar Browser under the sidebar preference', async () => {
    const b = bench()
    await expect(b.links.open('https://example.com/a')).resolves.toBe('sidebar')
    expect(b.openSidebar).toHaveBeenCalledWith('https://example.com/a')
    expect(b.openWindow).not.toHaveBeenCalled()
  })

  it('opens a reserved popup, clears its opener, and reserves again for the next open', async () => {
    const b = bench({ preference: () => 'new-tab' })
    const reservation = popup()
    b.openWindow.mockReturnValueOnce(reservation)
    expect(b.links.begin()).toBe(reservation)
    expect(reservation.opener).toBeNull()
    await expect(b.links.open('https://example.com/a')).resolves.toBe('window')
    expect(reservation.location.replace).toHaveBeenCalledWith('https://example.com/a')
    await expect(b.links.open('https://example.com/b')).resolves.toBe('window')
    expect(b.openWindow).toHaveBeenCalledTimes(2)
  })

  it('closes only an unused reservation', () => {
    const b = bench()
    const first = popup()
    const second = popup()
    b.openWindow.mockReturnValueOnce(first).mockReturnValueOnce(second)
    b.links.begin()
    b.links.begin()
    expect(first.close).toHaveBeenCalledOnce()
    b.links.end()
    expect(second.close).toHaveBeenCalledOnce()
    b.links.end()
    expect(second.close).toHaveBeenCalledOnce()
  })

  it('reports a blocked popup instead of leaving the click silent', async () => {
    const b = bench({ preference: () => 'new-tab' })
    b.openWindow.mockReturnValue(null)
    await expect(b.links.open('https://example.com/a')).resolves.toBe('blocked')
    expect(b.reported).toEqual(['blocked'])
    expect(b.openSidebar).not.toHaveBeenCalled()
  })

  it('treats a popup the browser already closed as blocked', async () => {
    const b = bench({ preference: () => 'new-tab' })
    b.openWindow.mockReturnValue(popup(true))
    await expect(b.links.open('https://example.com/a')).resolves.toBe('blocked')
    expect(b.reported).toEqual(['blocked'])
  })

  it('leaves the Sidebar Browser out when it is not registered or the scheme has no page', async () => {
    const absent = bench({ sidebar: () => false })
    await expect(absent.links.open('https://example.com/a')).resolves.toBe('window')
    expect(absent.openSidebar).not.toHaveBeenCalled()
    const registered = bench()
    await expect(registered.links.open('mailto:dev@example.com')).resolves.toBe('window')
    expect(registered.openSidebar).not.toHaveBeenCalled()
  })

  it('hands a mail or telephone destination to the browser through an anchor', async () => {
    const b = bench({ preference: () => 'new-tab' })
    const watched = watchedAnchors()
    await expect(b.links.open('mailto:dev@example.com')).resolves.toBe('window')
    expect(watched.activated).toHaveLength(1)
    expect(watched.activated[0]?.getAttribute('href')).toBe('mailto:dev@example.com')
    expect(watched.activated[0]?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(watched.click).toHaveBeenCalledOnce()
    expect(b.openWindow).not.toHaveBeenCalled()
  })

  it('keeps the shared notice silent when the caller shows its own refusal', async () => {
    const b = bench()
    const reservations = bench({ preference: () => 'new-tab' })
    reservations.openWindow.mockReturnValue(null)
    await expect(reservations.links.open('https://example.com/a', { notice: false })).resolves.toBe('blocked')
    expect(reservations.reported).toEqual([])
    await expect(b.links.open('file:///etc/passwd', { notice: false })).resolves.toBe('blocked')
    expect(b.reported).toEqual([])
  })

  it('refuses an unlisted destination and a cancelled gesture before opening anything', async () => {
    const b = bench()
    await expect(b.links.open('file:///etc/passwd')).resolves.toBe('blocked')
    expect(b.reported).toEqual(['unsupported'])
    const controller = new AbortController()
    controller.abort()
    await expect(b.links.open('https://example.com/a', { signal: controller.signal })).rejects.toThrow()
    expect(b.openSidebar).not.toHaveBeenCalled()
  })

  it('abandons a native handoff cancelled while it was in flight', async () => {
    const controller = new AbortController()
    const b = bench({
      native: {
        openExternal: () => {
          controller.abort()
          return Promise.resolve()
        },
      },
    })
    await expect(b.links.open('https://example.com/a', { signal: controller.signal })).rejects.toThrow()
  })
})

/** Capture anchors this document activates, without replacing `createElement`. */
function watchedAnchors() {
  const activated: HTMLAnchorElement[] = []
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    activated.push(this)
  })
  return { activated, click }
}

describe('activateHandoff', () => {
  it('activates a detached anchor instead of navigating this document', () => {
    const watched = watchedAnchors()
    activateHandoff('tel:+5511999999999')
    expect(watched.activated).toHaveLength(1)
    expect(watched.activated[0]?.getAttribute('href')).toBe('tel:+5511999999999')
    expect(watched.click).toHaveBeenCalledOnce()
  })
})

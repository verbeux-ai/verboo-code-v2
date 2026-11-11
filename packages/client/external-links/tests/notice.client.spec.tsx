// @vitest-environment jsdom
/** The refusal notice and the plugin's own activation surface. */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import * as plugin from '../src/client/index.ts'
import { ExternalLinkNotice, type ExternalLinkNoticeProps, type ExternalLinkNoticeState } from '../src/client/notice.tsx'
import { en, ja, zh } from '../src/client/locales.ts'
import { apply as applyHost } from '../src/index.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

function mount(state: ExternalLinkNoticeState | null) {
  const dismiss = vi.fn()
  const props = {
    useNotice: <T,>(select: (value: ExternalLinkNoticeState | null) => T): T => select(state),
    dismiss,
    t: makeTranslate(en),
  } as ExternalLinkNoticeProps
  return { view: render(<ExternalLinkNotice {...props} />), dismiss }
}

describe('ExternalLinkNotice', () => {
  it('renders nothing without a refusal', () => {
    mount(null)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['unsupported', 'blocked', 'nativeFailed'] as const)('names the %s refusal', (failure) => {
    // The banner renders through a body portal, so it is read from the document.
    mount({ failure, seq: 1 })
    expect(screen.getByRole('alert').textContent).toBe(en[failure])
  })

  it('dismisses itself once the banner finishes', async () => {
    vi.useFakeTimers()
    const { dismiss } = mount({ failure: 'blocked', seq: 3 })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('keys a repeat by its publish counter', () => {
    const first = mount({ failure: 'blocked', seq: 1 })
    expect(screen.getByRole('alert').textContent).toBe(en.blocked)
    first.view.unmount()
    mount({ failure: 'unsupported', seq: 2 })
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
  })
})

describe('external-links activation', () => {
  it('leaves the Host entry inert', () => {
    expect(() => { applyHost() }).not.toThrow()
  })

  it('provides the service, registers the notice, and routes a refusal to it', async () => {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.mount(plugin)
    await runtime.root.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } },
      ({ renderSlot }) => renderSlot('shell.overlay', {}))
    runtime.renderRoot()
    const service = runtime.ctx.externalLinks
    expect(service).toBeDefined()
    // No Sidebar Browser and no Desktop bridge: a window is asked for and denied.
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await act(async () => { await service.open('https://example.com/page') })
    expect(open).toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(en.blocked)
    service.setPreference('new-tab')
    service.begin()
    service.end()
    open.mockRestore()
  })

  it('refuses an unlisted destination and closes the notice on unmount', async () => {
    const runtime = await SlotTestRuntime.create()
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.mount(plugin)
    await runtime.root.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } },
      ({ renderSlot }) => renderSlot('shell.overlay', {}))
    runtime.renderRoot()
    await act(async () => { await runtime.ctx.externalLinks.open('file:///etc/passwd') })
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    await runtime.dispose()
  })

  it('opens through the Desktop bridge when the page installed it', async () => {
    const openExternal = vi.fn(async () => {})
    vi.stubGlobal('__VERBOO_DESKTOP__', { framework: 'tauri', protocolVersion: 1, openExternal })
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.mount(plugin)
    await runtime.root.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } },
      ({ renderSlot }) => renderSlot('shell.overlay', {}))
    runtime.renderRoot()
    const native = vi.spyOn(window, 'open')
    await expect(runtime.ctx.externalLinks.open('https://example.com/page')).resolves.toBe('native')
    expect(openExternal).toHaveBeenCalledWith('https://example.com/page')
    // Desktop takes absolute precedence over the destination preference.
    runtime.ctx.externalLinks.setPreference('sidebar')
    await expect(runtime.ctx.externalLinks.open('https://example.com/other')).resolves.toBe('native')
    expect(native).not.toHaveBeenCalled()
  })
})

describe('service wiring', () => {
  it('opens a Sidebar Browser tab when the tab type is registered', async () => {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const openTab = vi.fn()
    runtime.ctx.provide('sidebarRightTabs', { get: (kind: string) => kind === 'browser' ? {} : undefined })
    runtime.ctx.provide('sidebarRight', { openTab })
    await runtime.mount(plugin)
    await runtime.root.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } },
      ({ renderSlot }) => renderSlot('shell.overlay', {}))
    runtime.renderRoot()
    const browser = vi.spyOn(window, 'open')
    await expect(runtime.ctx.externalLinks.open('https://example.com/a')).resolves.toBe('sidebar')
    expect(openTab).toHaveBeenCalledWith('browser', { params: { url: 'https://example.com/a' } })
    expect(browser).not.toHaveBeenCalled()
  })

  it('reserves nothing on Desktop, where the native opener takes the destination', async () => {
    const openExternal = vi.fn(async () => {})
    vi.stubGlobal('__VERBOO_DESKTOP__', { framework: 'tauri', protocolVersion: 1, openExternal })
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.mount(plugin)
    await runtime.root.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } },
      ({ renderSlot }) => renderSlot('shell.overlay', {}))
    runtime.renderRoot()
    const browser = vi.spyOn(window, 'open')
    runtime.ctx.externalLinks.begin()
    expect(browser).not.toHaveBeenCalled()
    runtime.ctx.externalLinks.end()
  })
})

describe('dictionaries', () => {
  it.each([zh, en, ja])('cover every refusal key', (dictionary) => {
    expect(Object.keys(dictionary).sort()).toEqual(['blocked', 'nativeFailed', 'unsupported'])
  })
})

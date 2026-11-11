// @vitest-environment jsdom
/** The sign-in handoff tracks its attempt and retires an unused reservation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { ExternalLinksService } from '@deepseek-ai/dsh-client-external-links/client'
import { BrowserLogin } from '../src/client/browser-login.ts'

afterEach(() => { vi.restoreAllMocks() })

function view(phase: NonNullable<AccountView['attempt']>['phase'], authorizeUrl?: string): AccountView {
  return {
    status: 'signed-out',
    links: { usageUrl: '', topUpUrl: '' },
    attempt: { id: 'attempt' as SignInAttemptId, phase, ...(authorizeUrl ? { authorizeUrl } : {}) },
  }
}

function service() {
  const open = vi.fn<ExternalLinksService['open']>(() => Promise.resolve('window'))
  const begin = vi.fn<() => void>()
  const end = vi.fn<() => void>()
  return { open, begin, end, setPreference: vi.fn<() => void>() } satisfies ExternalLinksService
}

describe('BrowserLogin', () => {
  it('navigates once when waiting-browser arrives after the initial RPC response', async () => {
    const links = service()
    const browser = new BrowserLogin(() => links, url => url)
    browser.begin()
    expect(links.begin).toHaveBeenCalledOnce()
    browser.follow(view('initializing'))
    expect(links.open).not.toHaveBeenCalled()
    browser.update(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
    browser.update(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
    await vi.waitFor(() => { expect(links.open).toHaveBeenCalledOnce() })
    expect(links.open).toHaveBeenCalledWith('https://platform.deepseek.com/dsh/authorize', { notice: false })
    browser.dispose()
    expect(links.end).toHaveBeenCalled()
  })

  it('retires the reservation on request failure without opening late', async () => {
    const links = service()
    const browser = new BrowserLogin(() => links, url => url)
    browser.begin()
    browser.dispose()
    const released = links.end.mock.calls.length
    browser.update(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
    expect(links.open).not.toHaveBeenCalled()
    expect(links.end.mock.calls.length).toBe(released)
    expect(released).toBeGreaterThan(0)
  })

  it('keeps the manual link route working when no link service is available', () => {
    const browser = new BrowserLogin(() => undefined, url => url)
    expect(() => { browser.begin() }).not.toThrow()
    expect(() => { browser.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize')) }).not.toThrow()
    browser.dispose()
  })

  it('releases the reservation when the authenticated start request rejects', async () => {
    const links = service()
    const browser = new BrowserLogin(() => links, url => url)
    await expect(browser.start(() => Promise.reject(new Error('disconnected')), () => undefined))
      .rejects.toThrow('disconnected')
    // The rejection retires the reservation this gesture took.
    expect(links.end).toHaveBeenCalled()
    expect(links.open).not.toHaveBeenCalled()
  })

  it('uses a waiting frame received before the initial response', async () => {
    const links = service()
    const browser = new BrowserLogin(() => links, url => url)
    await browser.start(async () => view('initializing'), () => view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
    await vi.waitFor(() => { expect(links.open).toHaveBeenCalledOnce() })
  })

  it.each(['failed', 'expired', 'cancelled'] as const)('retires an already opened handoff on %s', (phase) => {
    const links = service()
    const browser = new BrowserLogin(() => links, url => url)
    browser.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
    links.end.mockClear()
    browser.update(view(phase))
    expect(links.end).toHaveBeenCalledOnce()
  })

  it('leaves success completion to the Platform page', () => {
    const links = service()
    const browser = new BrowserLogin(() => links, url => url)
    browser.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
    links.end.mockClear()
    browser.update(view('succeeded'))
    // Success spends the reservation once; a later disposal releases nothing.
    expect(links.end).toHaveBeenCalledOnce()
    browser.dispose()
    expect(links.end).toHaveBeenCalledTimes(2)
  })

  it('spends a reservation the Host finished before it navigated', () => {
    const links = service()
    const browser = new BrowserLogin(() => links, url => url)
    browser.begin()
    links.end.mockClear()
    browser.follow(view('exchanging'))
    browser.update(view('succeeded'))
    expect(links.end).toHaveBeenCalledOnce()
    expect(links.open).not.toHaveBeenCalled()
  })

  it('opens the destination mapped from the authorization URL', async () => {
    const links = service()
    const browser = new BrowserLogin(() => links, url => `${url}?theme=dark`)
    browser.begin()
    browser.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
    await vi.waitFor(() => { expect(links.open).toHaveBeenCalledOnce() })
    expect(links.open).toHaveBeenCalledWith('https://platform.deepseek.com/dsh/authorize?theme=dark', { notice: false })
  })
})

// @vitest-environment jsdom
/** The account handoff delegates its policy to the product link service. */
import { describe, expect, it, vi } from 'vitest'
import type { ExternalLinksService } from '@deepseek-ai/dsh-client-external-links/client'
import { ExternalNavigation, ExternalNavigationError } from '../src/client/navigation.ts'

function service(
  open: ExternalLinksService['open'] = () => Promise.resolve('window'),
) {
  const begin = vi.fn<() => void>()
  const end = vi.fn<() => void>()
  return {
    open,
    begin,
    end,
    setPreference: vi.fn<(preference: 'sidebar' | 'new-tab') => void>(),
  } satisfies ExternalLinksService
}

describe('ExternalNavigation', () => {
  it('reserves and releases the handoff through the link service', () => {
    const links = service()
    const navigation = new ExternalNavigation(() => links)
    navigation.reserve()
    expect(links.begin).toHaveBeenCalledOnce()
    navigation.release()
    expect(links.end).toHaveBeenCalledOnce()
  })

  it('opens the Host destination without adding a second notice', async () => {
    const open = vi.fn<ExternalLinksService['open']>(() => Promise.resolve('window'))
    const navigation = new ExternalNavigation(() => service(open))
    await navigation.open('https://code.verboo.ai/pt/plans')
    expect(open).toHaveBeenCalledWith('https://code.verboo.ai/pt/plans', { notice: false })
  })

  it.each(['window', 'native', 'sidebar'] as const)(
    'accepts a handoff the service routed to %s', async (destination) => {
      const navigation = new ExternalNavigation(() => service(() => Promise.resolve(destination)))
      await expect(navigation.open('https://code.verboo.ai/')).resolves.toBeUndefined()
    },
  )

  it('reports a refused destination as a blocked handoff', async () => {
    const navigation = new ExternalNavigation(() => service(() => Promise.resolve('blocked')))
    await expect(navigation.open('https://code.verboo.ai/')).rejects.toBeInstanceOf(ExternalNavigationError)
    await expect(navigation.open('https://code.verboo.ai/')).rejects.toMatchObject({ code: 'browser_blocked' })
  })

  it('fails loudly when no link service is registered', async () => {
    const navigation = new ExternalNavigation(() => undefined)
    expect(() => { navigation.reserve() }).not.toThrow()
    navigation.release()
    await expect(navigation.open('https://code.verboo.ai/')).rejects.toBeInstanceOf(ExternalNavigationError)
  })

  it('resolves the service again on every handoff', () => {
    const first = service()
    const second = service()
    let current: ExternalLinksService | undefined = first
    const navigation = new ExternalNavigation(() => current)
    navigation.reserve()
    current = second
    navigation.reserve()
    expect(first.begin).toHaveBeenCalledOnce()
    expect(second.begin).toHaveBeenCalledOnce()
  })
})

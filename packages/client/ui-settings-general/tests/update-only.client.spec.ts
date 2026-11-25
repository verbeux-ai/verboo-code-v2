// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'

const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.unstubAllGlobals()
})

it('registers only the localized desktop update row for a product-owned settings UI', () => {
  const unsubscribe = vi.fn()
  const subscribe = vi.fn(() => unsubscribe)
  vi.stubGlobal('__VERBOO_DESKTOP__', {
    protocolVersion: 1,
    updates: { subscribe, status: async () => ({ phase: 'idle' }), restart: async () => {}, dismiss: async () => {} },
  })
  const registerLocale = vi.fn(() => vi.fn())
  const registerSlot = vi.fn((_options: unknown, _component: unknown) => undefined)
  const ctx = new Context()
  Object.defineProperties(ctx, {
    locale: { value: { register: registerLocale } },
    slots: { value: { inject: (_name: string, callback: () => void) => { callback() }, register: registerSlot } },
    effect: { value: (callback: () => (() => void) | undefined) => {
      const dispose = callback()
      if (dispose) disposers.push(dispose)
    } },
  })

  apply(ctx, { updateOnly: true })

  expect(registerLocale).toHaveBeenCalledOnce()
  expect(registerSlot).toHaveBeenCalledOnce()
  expect(registerSlot.mock.calls[0]?.[0]).toMatchObject({ name: 'sidebar.footer.row', locale: 'settings' })
  expect(subscribe).toHaveBeenCalledOnce()
  disposers.splice(0).forEach((dispose) => { dispose() })
  expect(unsubscribe).toHaveBeenCalledOnce()
})

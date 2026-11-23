// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ConversationAppearance, type ConversationAppearanceProps } from '../src/client/ConversationAppearance.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('waits for the stored preference and restores the toggle after a refused write', async () => {
  const setting: ConfigFormSnapshot<{ minimalist: boolean }> = {
    status: 'loading', writable: true, value: undefined, base: undefined, user: undefined, revision: undefined,
  }
  const first = Promise.withResolvers<boolean>()
  const retry = Promise.withResolvers<boolean>()
  const setMinimalist = vi.fn<(enabled: boolean) => Promise<boolean>>()
    .mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
  const props: ConversationAppearanceProps = {
    useConversationAppearance: select => select(setting), setMinimalist,
    t: key => (en as Readonly<Record<string, string>>)[key] ?? key,
  }
  const view = render(<ConversationAppearance {...props} />)
  const toggle = view.getByRole('checkbox', { name: en.minimalistTitle })
  if (!(toggle instanceof HTMLInputElement)) throw new Error('Expected a native checkbox')
  expect(toggle.disabled).toBe(true)
  expect(toggle.checked).toBe(false)
  setting.status = 'ready'
  setting.writable = false
  setting.value = { minimalist: false }
  view.rerender(<ConversationAppearance {...props} />)
  expect(toggle.disabled).toBe(true)
  setting.writable = true
  view.rerender(<ConversationAppearance {...props} />)
  expect(toggle.disabled).toBe(false)
  fireEvent.click(toggle)
  expect(setMinimalist).toHaveBeenNthCalledWith(1, true)
  expect(toggle.disabled).toBe(true)
  await act(() => first.resolve(false))
  expect(view.getByRole('alert').textContent).toBe(en.minimalistSaveFailed)
  expect(toggle.disabled).toBe(false)
  expect(toggle.checked).toBe(false)
  fireEvent.click(toggle)
  expect(setMinimalist).toHaveBeenNthCalledWith(2, true)
  expect(view.queryByRole('alert')).toBeNull()
  setting.value = { minimalist: true }
  await act(() => retry.resolve(true))
  expect(toggle.checked).toBe(true)
  expect(toggle.disabled).toBe(false)
  expect(view.queryByRole('alert')).toBeNull()
})

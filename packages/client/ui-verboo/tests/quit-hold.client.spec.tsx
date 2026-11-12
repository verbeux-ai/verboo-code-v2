// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QuitHold, QUIT_CONFIRM_MS } from '../src/client/QuitHold.tsx'
import { pt } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
function setup(mac = true) {
  vi.useFakeTimers()
  const quit = vi.fn().mockResolvedValue(undefined)
  const copy: Readonly<Record<string, string>> = pt
  render(<QuitHold mac={mac} quit={quit} t={(key, values) =>
    (copy[key] ?? key).replace('{shortcut}', typeof values?.shortcut === 'string' ? values.shortcut : '')} />)
  return { quit, modifier: mac ? { metaKey: true } : { ctrlKey: true } }
}

it.each([true, false])('requires two distinct presses with mac=%s', (mac) => {
  const { quit, modifier } = setup(mac)
  fireEvent.keyDown(window, { code: 'KeyQ', key: 'q', ...modifier })
  expect(screen.getByRole('status').textContent).toContain(mac ? '⌘Q' : 'Ctrl+Q')
  fireEvent.keyDown(window, { code: 'KeyQ', key: 'q', repeat: true, ...modifier })
  expect(quit).not.toHaveBeenCalled()
  fireEvent.keyUp(window, { code: 'KeyQ', key: 'q', ...modifier })
  expect(screen.getByRole('status')).toBeTruthy()
  fireEvent.keyDown(window, { code: 'KeyQ', key: 'q', ...modifier })
  expect(quit).toHaveBeenCalledTimes(1)
  fireEvent.keyUp(window, { code: 'KeyQ', key: 'q', ...modifier })
  fireEvent.keyDown(window, { code: 'KeyQ', key: 'q', ...modifier })
  expect(quit).toHaveBeenCalledTimes(1)
})

it.each(['timeout', 'blur', 'escape'])('cancels confirmation on %s', (reason) => {
  const { quit, modifier } = setup()
  fireEvent.keyDown(window, { code: 'KeyQ', key: 'q', ...modifier })
  fireEvent.keyUp(window, { code: 'KeyQ', key: 'q', ...modifier })
  if (reason === 'timeout') act(() => { vi.advanceTimersByTime(QUIT_CONFIRM_MS) })
  if (reason === 'blur') fireEvent.blur(window)
  if (reason === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.keyDown(window, { code: 'KeyQ', key: 'q', ...modifier })
  expect(quit).not.toHaveBeenCalled()
  expect(screen.getByRole('status')).toBeTruthy()
})

it('ignores unrelated combinations and key repeats', () => {
  const { quit } = setup()
  fireEvent.keyDown(window, { code: 'KeyQ', ctrlKey: true })
  fireEvent.keyDown(window, { code: 'KeyQ', metaKey: true, shiftKey: true })
  fireEvent.keyDown(window, { code: 'KeyQ', metaKey: true, repeat: true })
  expect(quit).not.toHaveBeenCalled()
  expect(screen.queryByRole('status')).toBeNull()
})

it('shows an error and allows retry after quit fails', async () => {
  const { quit, modifier } = setup()
  quit.mockRejectedValueOnce(new Error('failed'))
  fireEvent.keyDown(window, { code: 'KeyQ', key: 'q', ...modifier })
  fireEvent.keyUp(window, { code: 'KeyQ', key: 'q', ...modifier })
  fireEvent.keyDown(window, { code: 'KeyQ', key: 'q', ...modifier })
  await act(async () => {})
  expect(screen.getByRole('alert')).toBeTruthy()
  fireEvent.keyUp(window, { code: 'KeyQ', key: 'q', ...modifier })
  fireEvent.keyDown(window, { code: 'KeyQ', key: 'q', ...modifier })
  expect(screen.getByRole('status')).toBeTruthy()
})

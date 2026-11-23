// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DesktopQuitHold, QuitHold, QUIT_CONFIRM_MS } from '../src/client/QuitHold.tsx'
import { pt } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const copy: Readonly<Record<string, string>> = pt
const translate = (key: string, values?: Record<string, unknown>) =>
  (copy[key] ?? key).replace('{shortcut}', typeof values?.shortcut === 'string' ? values.shortcut : '')

function setup(mac = true) {
  vi.useFakeTimers()
  const quit = vi.fn().mockResolvedValue(undefined)
  render(<QuitHold mac={mac} quit={quit} t={translate} />)
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

it.each([true, false])('releases the second press when only the modifier is released with mac=%s', (mac) => {
  const { quit, modifier } = setup(mac)
  fireEvent.keyDown(window, { code: 'KeyQ', ...modifier })
  fireEvent.keyUp(window, { key: 'A', code: 'KeyA' })
  fireEvent.keyDown(window, { code: 'KeyQ', ...modifier })
  expect(quit).not.toHaveBeenCalled()
  fireEvent.keyUp(window, { key: mac ? 'Meta' : 'Control' })
  fireEvent.keyDown(window, { code: 'KeyQ', ...modifier })
  expect(quit).toHaveBeenCalledOnce()
})

it('cancels the confirmation when the window becomes hidden', () => {
  const { quit, modifier } = setup()
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  fireEvent.keyDown(window, { code: 'KeyQ', ...modifier })
  fireEvent.keyUp(window, { code: 'KeyQ' })
  fireEvent(document, new Event('visibilitychange'))
  expect(screen.getByRole('status')).toBeTruthy()
  hidden.mockReturnValue(true)
  fireEvent(document, new Event('visibilitychange'))
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.keyDown(window, { code: 'KeyQ', ...modifier })
  expect(quit).not.toHaveBeenCalled()
})

it('binds the quit shortcut only when the desktop provides it', () => {
  vi.stubGlobal('__VERBOO_DESKTOP__', undefined)
  const { rerender } = render(<DesktopQuitHold t={translate} />)
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  fireEvent.keyDown(window, { code: 'KeyQ', metaKey: true })
  expect(screen.queryByRole('status')).toBeNull()
  const quit = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('__VERBOO_DESKTOP__', { quit })
  rerender(<DesktopQuitHold t={translate} />)
  fireEvent.keyDown(window, { code: 'KeyQ', metaKey: true })
  expect(screen.getByRole('status').textContent).toContain('⌘Q')
  fireEvent.keyUp(window, { code: 'KeyQ' })
  fireEvent.keyDown(window, { code: 'KeyQ', metaKey: true })
  expect(quit).toHaveBeenCalledOnce()
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

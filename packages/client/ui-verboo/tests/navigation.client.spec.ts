// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import {
  ExternalNavigation,
  ExternalNavigationError,
} from '../src/client/navigation.ts'
import type { NavigationWindow } from '../src/client/navigation.ts'
it('reserves a browser window synchronously and navigates it after the URL arrives', async () => {
  const popup: NavigationWindow = {
    closed: false,
    opener: null,
    close: vi.fn(),
    location: { replace: vi.fn() },
  }
  const open = vi.fn(() => popup)
  const navigation = new ExternalNavigation(() => undefined, open)
  navigation.reserve()
  expect(open).toHaveBeenCalledOnce()
  await Promise.resolve()
  await navigation.open('https://code.verboo.ai/pt/plans')
  expect(open).toHaveBeenCalledOnce()
  expect(popup.location.replace).toHaveBeenCalledWith(
    'https://code.verboo.ai/pt/plans',
  )
  navigation.release()
  expect(popup.close).not.toHaveBeenCalled()
})
it('classifies blocked popups and closes only unused reservations', () => {
  const blocked = new ExternalNavigation(
    () => undefined,
    () => null,
  )
  expect(() =>{  blocked.reserve() }).toThrow(ExternalNavigationError)
  const popup: NavigationWindow = {
    closed: false,
    opener: null,
    close: vi.fn(),
    location: { replace: vi.fn() },
  }
  const navigation = new ExternalNavigation(
    () => undefined,
    () => popup,
  )
  navigation.reserve()
  navigation.release()
  expect(popup.close).toHaveBeenCalledOnce()
})
it('uses the native browser opener without reserving a Web popup or accepting credential URLs', async () => {
  const openExternal = vi.fn(async () => {})
  const browser = vi.fn(() => null)
  const navigation = new ExternalNavigation(() => ({ openExternal }), browser)
  navigation.reserve()
  await navigation.open('https://code.verboo.ai/pt/plans')
  expect(browser).not.toHaveBeenCalled()
  expect(openExternal).toHaveBeenCalledOnce()
  await expect(
    navigation.open('https://secret@example.invalid'),
  ).rejects.toThrow()
  await expect(navigation.open('http://example.invalid')).rejects.toThrow()
})

// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { paneShortcutKeys } from '../src/client/panes/shortcut-labels.ts'

afterEach(() => { delete document.documentElement.dataset.platform })

it.each([
  ['darwin', ['⌘', 'Shift', 'D'], ['⌘', '⌥', '← ↑ ↓ →']],
  ['windows', ['Ctrl', 'Shift', 'D'], ['Ctrl', 'Alt', '← ↑ ↓ →']],
])('shows the registered pane keys for %s', (platform, down, move) => {
  document.documentElement.dataset.platform = platform
  expect(paneShortcutKeys().down).toEqual(down)
  expect(paneShortcutKeys().move).toEqual(move)
})

it('falls back to the browser platform when the document carries no signal', () => {
  // The document attribute is the shared device signal; a page that has not set
  // it yet must still name the right keys for the platform it runs on.
  const original = Object.getOwnPropertyDescriptor(navigator, 'platform')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  try {
    expect(paneShortcutKeys().close).toEqual(['⌘', 'W'])
  } finally {
    if (original === undefined) Reflect.deleteProperty(navigator, 'platform')
    else Object.defineProperty(navigator, 'platform', original)
  }
})

// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { paneShortcutLabels } from '../src/client/panes/shortcut-labels.ts'

afterEach(() => { delete document.documentElement.dataset.platform })

it.each([
  ['darwin', ['⌘', 'Shift', 'D'], ['⌘', '⌥', '← ↑ ↓ →']],
  ['windows', ['Ctrl', 'Shift', 'D'], ['Ctrl', 'Alt', '← ↑ ↓ →']],
])('shows the registered pane keys for %s', (platform, down, move) => {
  document.documentElement.dataset.platform = platform
  expect(paneShortcutLabels().down).toEqual(down)
  expect(paneShortcutLabels().move).toEqual(move)
})

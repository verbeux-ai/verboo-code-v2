/** Use the same device signal as the shared shortcut service.
 * @returns Shortcut labels for the current platform. */
export function paneShortcutLabels(): { right: string[]; down: string[]; close: string[]; move: string[] } {
  const device = document.documentElement.dataset.platform ?? navigator.platform
  const mac = /darwin|mac|iphone|ipad/iu.test(device)
  const primary = mac ? '⌘' : 'Ctrl'
  return {
    right: [primary, 'D'],
    down: [primary, 'Shift', 'D'],
    close: [primary, 'W'],
    move: [primary, mac ? '⌥' : 'Alt', '← ↑ ↓ →'],
  }
}

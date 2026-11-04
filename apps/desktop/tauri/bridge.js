/** Native capabilities are present only on the owned, authenticated Host origin. */
(() => {
  if (window.location.hostname !== '127.0.0.1' || window.top !== window) return
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args)
  const reported = new WeakSet()
  const report = error => {
    if (!(error instanceof Error) || reported.has(error)) return
    reported.add(error)
    const frames = []
    for (const match of (error.stack ?? '').matchAll(/(http:\/\/127\.0\.0\.1:\d+\/[^\s()]+\.js):(\d+):(\d+)/g)) {
      const url = new URL(match[1])
      if (url.origin !== location.origin || url.search !== '' || !/^\/[a-zA-Z0-9/._-]+$/.test(url.pathname)) continue
      frames.push({ asset: url.pathname.slice(0, 160), line: Number(match[2]), column: Number(match[3]) })
      if (frames.length === 5) break
    }
    const entries = []
    void invoke('client_diagnostic', { frames, entries }).catch((_error) => {
      // Native shutdown may close IPC before the browser finishes reporting.
    })
  }
  const originalError = console.error.bind(console)
  console.error = (...args) => { for (const value of args) report(value); originalError(...args) }
  window.addEventListener('error', event => report(event.error))
  window.addEventListener('unhandledrejection', event => report(event.reason))
  Object.defineProperty(window, '__DSH_DIRECTORY_PICKER__', {
    value: Object.freeze({ pick: () => invoke('pick_directory') }),
  })
  Object.defineProperty(window, '__VERBOO_DESKTOP__', {
    value: Object.freeze({
      framework: 'tauri', protocolVersion: 1, deviceInfo: () => invoke('desktop_info'),
      openExternal(url) {
        const target = new URL(url)
        if (target.username || target.password || (target.protocol !== 'https:'
          && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)))) {
          return Promise.reject(new Error('Verboo Code: external_url_invalid'))
        }
        return invoke('plugin:opener|open_url', { url: target.href, with: null })
      },
    }),
  })
  document.addEventListener('DOMContentLoaded', () => {
    void invoke('desktop_info').catch(() => { console.error('Verboo Code: native_bridge_unavailable') })
    document.documentElement.dataset.verbooDesktop = 'tauri'
    document.title = 'Verboo Code'
    const root = document.getElementById('root')
    if (root === null) return
    const reportReady = () => {
      if (root.querySelector('[data-verboo-shell]') === null || root.querySelector('[data-dsh-boot]') !== null) return
      observer.disconnect()
      void invoke('client_ready').catch(() => { console.error('Verboo Code: native_bridge_unavailable') })
    }
    const observer = new MutationObserver(reportReady)
    observer.observe(root, { childList: true, subtree: true })
    reportReady()
  }, { once: true })
})()

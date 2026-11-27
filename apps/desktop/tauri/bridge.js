/** Native capabilities are present only on the owned, authenticated Host origin. */
(() => {
  if (window.location.hostname !== '127.0.0.1' || window.top !== window) return
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args)
  // The Host uses a fresh loopback port on each launch. Restore only layout and
  // terminal bookkeeping before client stores enumerate this origin's storage.
  const layoutKey = key => key === 'dsh.verboo.layout.v1' || key === 'dsh.terminal.shell'
    || key.startsWith('dsh.sidebar-right.v1.') || key.startsWith('dsh.terminal.binding.v1.')
    || key.startsWith('dsh.terminal.close.v1.')
  const setStorage = Storage.prototype.setItem
  const removeStorage = Storage.prototype.removeItem
  let pending = Promise.resolve()
  let canWriteLayout = false
  const writeLayout = (key, value) => {
    if (!canWriteLayout) return
    pending = pending.then(() => invoke('desktop_layout_write', { key, value })).catch(() => {
      console.error('Verboo Code: layout_storage_unavailable')
    })
  }
  let readTimer
  const layoutReady = Promise.race([
    invoke('desktop_layout_read'),
    new Promise((_, reject) => { readTimer = setTimeout(() => reject(new Error('layout_storage_timeout')), 2000) }),
  ]).then(saved => {
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('layout_storage_invalid')
    const storage = window.localStorage
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i)
      if (key !== null && layoutKey(key)) removeStorage.call(storage, key)
    }
    for (const [key, value] of Object.entries(saved)) {
      if (layoutKey(key) && typeof value === 'string') setStorage.call(storage, key, value)
    }
    canWriteLayout = true
  }).catch(() => { console.error('Verboo Code: layout_storage_unavailable') })
    .finally(() => { clearTimeout(readTimer) })
  Storage.prototype.setItem = function (key, value) {
    setStorage.call(this, key, value)
    if (this === window.localStorage && layoutKey(String(key))) writeLayout(String(key), String(value))
  }
  Storage.prototype.removeItem = function (key) {
    removeStorage.call(this, key)
    if (this === window.localStorage && layoutKey(String(key))) writeLayout(String(key), null)
  }
  Object.defineProperty(window, '__VERBOO_LAYOUT_STORAGE__', { value: Object.freeze({ ready: layoutReady }) })
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
    // Audit errors may name required plugins, but can also contain private
    // exception text. Forward only well-formed names at the start of audit lines.
    const entries = []
    if (error.message.startsWith('web boot: ')) {
      for (const line of error.message.split('\n').slice(1)) {
        const match = line.match(/^(@deepseek-ai\/[a-z0-9-]+)(?: \(required\))?: /)
        if (match && !entries.includes(match[1])) entries.push(match[1])
        if (entries.length >= 32) break
      }
    }
    void invoke('client_diagnostic', { frames, entries: entries.slice(0, 32) }).catch((_error) => {
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
  // The native updater owns the state and validates the caller when installing.
  // Validate both snapshots and event payloads before exposing them to the UI.
  const updateState = value => {
    if (value === null || typeof value !== 'object'
      || !['idle', 'checking', 'downloading', 'ready', 'installing', 'error'].includes(value.phase)
      || !(value.percent === null || (Number.isInteger(value.percent) && value.percent >= 0 && value.percent <= 100))) {
      throw new Error('Verboo Code: desktop_update_state_invalid')
    }
    return Object.freeze({ phase: value.phase, percent: value.percent })
  }
  Object.defineProperty(window, '__VERBOO_UPDATE__', {
    value: Object.freeze({
      getState: async () => updateState(await invoke('update_snapshot')),
      subscribe(listener) {
        const onState = event => {
          let state
          try { state = updateState(event.detail) } catch (_error) { return /* Ignore malformed renderer events. */ }
          listener(state)
        }
        window.addEventListener('verboo-update-state', onState)
        return () => window.removeEventListener('verboo-update-state', onState)
      },
      install: confirmed => invoke('update_restart', { confirmed }),
      retry: () => invoke('update_retry'),
    }),
  })
  // Buffer requests until the React overlay has subscribed.
  let quitPending = false
  const quitListeners = new Set()
  window.addEventListener('verboo-quit-confirmation', () => {
    quitPending = true
    for (const listener of quitListeners) listener()
  })
  Object.defineProperty(window, '__VERBOO_QUIT_CONFIRMATION__', {
    value: Object.freeze({
      subscribe(listener) {
        quitListeners.add(listener)
        if (quitPending) listener()
        return () => quitListeners.delete(listener)
      },
      async respond(confirmed) {
        await invoke('quit_confirmation_response', { confirmed })
        quitPending = false
      },
    }),
  })
  Object.defineProperty(window, '__VERBOO_DESKTOP__', {
    value: Object.freeze({
      framework: 'tauri', protocolVersion: 1, deviceInfo: () => invoke('desktop_info'),
      quit: () => invoke('quit_after_hold'),
      openCardSetup: setup => invoke('open_card_setup', { setup }),
      closeCardSetup: operation => invoke('close_card_setup', { operation }),
      openExternal(url) {
        const target = new URL(url)
        // Same allowlist the native navigation hook applies: a browsable page on
        // either scheme, or a destination another program registered. Credentials
        // never leave this document.
        if (target.username || target.password
          || !['https:', 'http:', 'mailto:', 'tel:'].includes(target.protocol)) {
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

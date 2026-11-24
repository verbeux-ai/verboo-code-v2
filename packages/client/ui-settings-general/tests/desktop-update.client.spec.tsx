// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { DesktopUpdateIndicator } from '../src/client/DesktopUpdateIndicator.tsx'
import type { DesktopUpdateBridge, DesktopUpdatePresentation } from '../src/types.ts'
import { DesktopUpdateSource } from '../src/client/desktop-update-source.ts'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { allowAllAccess, contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import { en, pt, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// The row consumes none of the standard seats; the fixture still has to carry them.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const unusedHook = (() => { throw new Error('unused by the update row') }) as never
const kit = {
  useSessions: unusedHook,
  useSessionStatus: unusedHook,
  usePanelInfo: ((selector: (state: { activePanelId: null }) => unknown) => selector({ activePanelId: null })) as GlobalStandardProps['usePanelInfo'],
  useSessionRetainInfo: () => undefined,
  useResource,
  useWorkspaces: unusedHook,
  ...allowAllAccess,
  useContextMenu: contextMenuHook(),
}

type SettingsTranslate = PropsLocale<'settings'>['t']

function translate(dictionary: typeof zh | typeof en | typeof pt): SettingsTranslate {
  const messages: Readonly<Record<string, string>> = dictionary
  return (key, params) => Object.entries(params ?? {})
    .reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
      messages[key] ?? key)
}

function fixture(options: { settleStatus?: boolean } = {}) {
  let listener: ((state: DesktopUpdatePresentation) => void) | undefined
  const status = Promise.withResolvers<DesktopUpdatePresentation>()
  const unsubscribe = vi.fn()
  const restart = vi.fn(async () => {})
  const dismiss = vi.fn(async () => {})
  const bridge: DesktopUpdateBridge = {
    status: () => (options.settleStatus === true ? Promise.resolve({ phase: 'idle' }) : status.promise),
    restart,
    dismiss,
    subscribe: (next) => { listener = next; return unsubscribe },
  }
  const source = new DesktopUpdateSource(bridge)
  const subscribe = (notify: () => void) => source.store.subscribe(notify)
  const snapshot = () => source.store.getSnapshot()
  function Indicator({ wide = true, dictionary = en }: {
    wide?: boolean
    dictionary?: typeof zh | typeof en | typeof pt
  }) {
    const state = useSyncExternalStore(subscribe, snapshot)
    return (
      <DesktopUpdateIndicator
        {...kit}
        wide={wide}
        t={translate(dictionary)}
        useDesktopUpdate={selector => selector(state)}
        restartDesktopUpdate={() => { source.restart() }}
        dismissDesktopUpdate={() => { source.dismiss() }}
      />
    )
  }
  const view = render(<Indicator />)
  const unmount = view.unmount
  view.unmount = () => { source.dispose(); unmount() }
  return {
    restart, dismiss, status, unsubscribe, view, Indicator, source,
    emit: async (state: DesktopUpdatePresentation) => {
      await act(async () => { listener?.(state) })
    },
  }
}

it('renders nothing outside the desktop carrier', () => {
  const source = new DesktopUpdateSource(undefined)
  const view = render(<DesktopUpdateIndicator {...kit} wide t={translate(en)}
    useDesktopUpdate={selector => selector(source.store.getSnapshot())}
    restartDesktopUpdate={() => { source.restart() }} dismissDesktopUpdate={() => { source.dismiss() }} />)
  source.restart()
  source.dismiss()
  source.dispose()
  expect(view.container.innerHTML).toBe('')
})

it('stays silent until there is something to report', async () => {
  const f = fixture()
  expect(f.view.container.innerHTML).toBe('')
  await f.emit({ phase: 'idle' })
  expect(f.view.container.innerHTML).toBe('')
  f.view.unmount()
})

it('reports the download, then offers one restart once the installer is staged', async () => {
  const f = fixture()
  await f.emit({ phase: 'downloading', version: '1.0.1', percent: 42 })
  const busy = screen.getByRole('button')
  expect(busy.textContent).toContain('42%')
  expect(busy.getAttribute('aria-disabled')).toBe('true')
  // A busy row ignores clicks: the native side owns the download.
  fireEvent.click(busy)
  expect(f.restart).not.toHaveBeenCalled()

  await f.emit({ phase: 'ready', version: '1.0.1' })
  const staged = screen.getByRole('button')
  expect(staged.textContent).toContain('Update ready')
  expect(staged.getAttribute('data-staged')).toBe('true')
  fireEvent.click(staged)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByText(/1\.0\.1/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Restart now' }))
  expect(f.restart).toHaveBeenCalledOnce()
  f.view.unmount()
})

it('closes the confirmation without restarting when the reader defers', async () => {
  const f = fixture()
  await f.emit({ phase: 'ready', version: '2.0.0' })
  fireEvent.click(screen.getByRole('button'))
  // The dialog close control shares the deferral label; the footer action is last.
  const defer = screen.getAllByRole('button', { name: 'On next restart' })
  fireEvent.click(defer[defer.length - 1] as HTMLElement)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.restart).not.toHaveBeenCalled()
  f.view.unmount()
})

it('reports a failure without a restart affordance', async () => {
  const f = fixture()
  await f.emit({ phase: 'error', version: '1.0.1', failure: 'download' })
  const row = screen.getByRole('button')
  expect(row.textContent).toContain('Retry update')
  expect(row.getAttribute('data-staged')).toBeNull()
  fireEvent.click(row)
  expect(f.restart).not.toHaveBeenCalled()
  expect(f.dismiss).toHaveBeenCalledOnce()
  f.view.unmount()
})

it('keeps the newest event and drops late events after disposal', async () => {
  const f = fixture()
  await f.emit({ phase: 'downloading', version: '1.0.1', percent: 10 })
  await f.emit({ phase: 'ready', version: '1.0.1' })
  expect(screen.getByRole('button').textContent).toContain('Update ready')
  f.view.unmount()
  expect(f.unsubscribe).toHaveBeenCalled()
})

it('accepts an initial status that already settled', async () => {
  const f = fixture({ settleStatus: true })
  await act(async () => { await Promise.resolve() })
  expect(f.view.container.innerHTML).toBe('')
  f.view.unmount()
})

it('coalesces repeated restarts into one native call', async () => {
  const f = fixture()
  await f.emit({ phase: 'ready', version: '1.0.1' })
  fireEvent.click(screen.getByRole('button'))
  const confirm = screen.getByRole('button', { name: 'Restart now' })
  fireEvent.click(confirm)
  f.source.restart()
  f.source.restart()
  expect(f.restart).toHaveBeenCalledOnce()
  f.view.unmount()
})

it('renders the row copy in the active locale', async () => {
  const f = fixture()
  await f.emit({ phase: 'ready', version: '1.0.1' })
  f.view.rerender(<f.Indicator dictionary={pt} />)
  expect(screen.getByRole('button').textContent).toContain('Atualização pronta')
  f.view.unmount()
})

it('labels the collapsed rail without text', async () => {
  const f = fixture()
  await f.emit({ phase: 'ready', version: '1.0.1' })
  f.view.rerender(<f.Indicator wide={false} />)
  const row = screen.getByRole('button')
  expect(row.textContent).toBe('')
  expect(row.getAttribute('aria-label')).toContain('Update ready')
  f.view.unmount()
})

it('ignores a dismiss when no version was reported', () => {
  const f = fixture()
  f.source.dismiss()
  expect(f.dismiss).not.toHaveBeenCalled()
  f.view.unmount()
})

it('surfaces a bridge failure as a retryable row', async () => {
  let fail = true
  const bridge: DesktopUpdateBridge = {
    status: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve({ phase: 'idle' })),
    restart: async () => {},
    dismiss: async () => {},
    subscribe: () => () => {},
  }
  const source = new DesktopUpdateSource(bridge)
  await act(async () => { await Promise.resolve() })
  const view = render(<DesktopUpdateIndicator {...kit} wide t={translate(en)}
    useDesktopUpdate={selector => selector(source.store.getSnapshot())}
    restartDesktopUpdate={() => { source.restart() }} dismissDesktopUpdate={() => { source.dismiss() }} />)
  expect(screen.getByRole('button').textContent).toContain('Retry update')
  fail = false
  source.dispose()
  view.unmount()
})

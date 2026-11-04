// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/src/client/contract/slots.ts'
import { ExecutionStatus } from '../src/client/Execution.tsx'
import { en, pt, zh } from '../src/client/locales.ts'

afterEach(cleanup)
function fixture(locale = 'pt') {
  const sessionId = 'session-execution' as SessionId
  const session: SessionSnapshot = {
    sessionId, pendingSubmissions: [], running: false, subagent: null, removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false,
    promptError: null, blank: false, lastAgentError: null, promptAttempted: true, awaitingFirstTurn: false,
  }
  const reading: { session: SessionSnapshot; connection: ConnectionState | undefined; waiting: boolean } = { session, connection: 'connected', waiting: false }
  const copy: Readonly<Record<string, string>> = locale === 'pt' ? pt : locale === 'zh' ? zh : en
  const approval = new PendingApproval(sessionId, { toolName: 'connections_execute' })
  const props: ComponentProps<typeof ExecutionStatus> = {
    sessionId, t: key => copy[key] ?? key,
    useSession: selector => selector(reading.session),
    useExecutionConnection: selector => selector(reading.connection),
    useSessionStatus: selector => selector(new Map([[sessionId, {
      running: reading.session.running,
      completionUnread: false,
      pendingInteraction: reading.waiting ? approval : undefined,
    }]])),
  }
  return { reading, props }
}
describe('conversation execution state', () => {
  it('keeps a visible idle state and switches to working when the Session starts', () => {
    const { reading, props } = fixture()
    const view = render(<ExecutionStatus {...props} />)
    expect(screen.getByRole('status').textContent).toBe('Parado')
    reading.session = { ...reading.session, running: true }
    view.rerender(<ExecutionStatus {...props} />)
    expect(screen.getByRole('status').textContent).toBe('Trabalhando')
    reading.session = { ...reading.session, running: false }
    view.rerender(<ExecutionStatus {...props} />)
    expect(screen.getByRole('status').textContent).toBe('Parado')
  })
  it('keeps a still-running Session working when a previous action reports an error', () => {
    const { reading, props } = fixture()
    reading.session = { ...reading.session, running: true, lastAgentError: 'previous run error' }
    render(<ExecutionStatus {...props} />)
    expect(screen.getByRole('status').textContent).toBe('Trabalhando')
  })
  it('never claims confirmed idle or working while reconnecting', () => {
    const { reading, props } = fixture()
    const view = render(<ExecutionStatus {...props} />)
    for (const connection of [undefined, 'disconnected', 'connecting'] as const) {
      reading.connection = connection
      reading.session = { ...reading.session, running: !reading.session.running }
      view.rerender(<ExecutionStatus {...props} />)
      expect(screen.getByRole('status').textContent).toBe(connection === undefined ? 'Conectando…' : 'Reconectando…')
    }
    reading.connection = 'connected'
    reading.session = { ...reading.session, running: false }
    view.rerender(<ExecutionStatus {...props} />)
    expect(screen.getByRole('status').textContent).toBe('Parado')
  })
  it('distinguishes awaiting a user decision, first turn admission, loading and a failed run', () => {
    const { reading, props } = fixture()
    reading.session = { ...reading.session, running: true }
    reading.waiting = true
    const view = render(<ExecutionStatus {...props} />)
    expect(screen.getByRole('status').textContent).toBe('Aguardando você')
    reading.waiting = false
    reading.session = { ...reading.session, awaitingFirstTurn: true }
    view.rerender(<ExecutionStatus {...props} />)
    expect(screen.getByRole('status').textContent).toBe('Iniciando…')
    reading.session = { ...reading.session, awaitingFirstTurn: false, openState: 'loading' }
    view.rerender(<ExecutionStatus {...props} />)
    expect(screen.getByRole('status').textContent).toBe(pt.loading)
    reading.session = { ...reading.session, openState: 'open', running: false, lastAgentError: 'not exposed to UI' }
    view.rerender(<ExecutionStatus {...props} />)
    expect(screen.getByRole('status').textContent).toBe('Requer atenção')
    expect(view.container.textContent).not.toContain('not exposed')
  })
  it.each(['pt', 'en', 'zh'])('announces changes accessibly in %s', (locale) => {
    const { props } = fixture(locale)
    render(<ExecutionStatus {...props} />)
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByRole('status').textContent).toMatchSnapshot()
  })
})

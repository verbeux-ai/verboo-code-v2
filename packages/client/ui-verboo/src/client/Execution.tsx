/** Execution labels use live Session and transport facts, including pending user interaction. */
import type { ExecutionProps } from './contracts.ts'
import css from './Product.module.css'

/**
 * Persistent, accessible execution state beside the active conversation's composer.
 * @param props - Renderer-bound Session, interaction and transport selectors.
 * @returns A localized live status that never reports confirmed idle while disconnected.
 */
export function ExecutionStatus(props: Pick<ExecutionProps, 'useExecutionConnection' | 'useSession' | 'useSessionStatus' | 'sessionId' | 't'>) {
  const connection = props.useExecutionConnection(state => state)
  const session = props.useSession(state => state)
  const waiting = props.useSessionStatus(state => state.get(props.sessionId)?.pendingInteraction !== undefined)
  const state = connection === undefined ? 'connecting' : connection !== 'connected' ? 'reconnecting'
    : session.openState === 'error' ? 'error'
      : session.openState !== 'open' ? 'loading'
        : waiting ? 'waiting'
          : session.awaitingFirstTurn ? 'starting'
            : session.running ? 'working'
              : session.lastAgentError !== null || session.promptError !== null ? 'error' : 'idle'
  const labels = { connecting: 'executionConnecting', reconnecting: 'executionReconnecting', error: 'executionError', loading: 'loading', waiting: 'executionWaiting', starting: 'executionStarting', working: 'executionWorking', idle: 'executionIdle' } as const
  return (
    <div className={css.executionStatus} data-verboo-execution={state} role="status" aria-live="polite" aria-atomic="true">
      <span className={css.executionDot} aria-hidden="true" />
      <span>{props.t(labels[state])}</span>
    </div>
  )
}

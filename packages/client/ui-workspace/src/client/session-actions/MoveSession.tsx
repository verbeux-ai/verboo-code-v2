/** Move-to-project dialog: the one place a conversation changes the project it works in. */
import { useState } from 'react'
import type { SessionActivity, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the refusal class this dialog reports in place.
import type { WorkspaceMoveSessionError } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SessionMoveDialogInjected, SessionMoveDialogProps, SessionMoveRequest,
} from '../contract/slots.ts'
import browserCss from '../rows/WorkspaceBrowser.module.css'

/**
 * The `shell.overlay` entry: nothing while no move is pending, otherwise one
 * dialog per request (keyed by the Session). The destination choices are the
 * registered Workspaces other than the current owner; confirming asks the Host
 * to make the chosen Workspace the Session's project, and cancelling leaves
 * the conversation where it is.
 * @param props - the request hook, its settlement, the move hop, the locale seat, and the Workspaces hook.
 * @returns the open dialog, or null.
 */
export function SessionMoveDialog({
  useMoveRequest, settleSessionMove, moveSession, useWorkspaces, t,
}: SessionMoveDialogProps) {
  const request = useMoveRequest(pending => pending)
  if (request === null) return null
  return (
    <MoveForm
      key={request.sessionId}
      request={request}
      moveSession={moveSession}
      onSettle={settleSessionMove}
      useWorkspaces={useWorkspaces}
      t={t}
    />
  )
}

/** One request's dialog: the chosen destination and any refusal die with it. */
function MoveForm({
  request, moveSession, onSettle, useWorkspaces, t,
}: {
  request: SessionMoveRequest
  moveSession: SessionMoveDialogInjected['moveSession']
  onSettle: () => void
  useWorkspaces: SessionMoveDialogProps['useWorkspaces']
  t: SessionMoveDialogProps['t']
}) {
  const items = useWorkspaces(snapshot => snapshot.items)
  const choices = items.filter(item => item.workspaceId !== request.currentWorkspaceId)
  const [selected, setSelected] = useState<WorkspaceId | undefined>(choices[0]?.workspaceId)
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<readonly SessionActivity[] | null>(null)
  const close = () => {
    if (moving) return
    onSettle()
  }
  const confirm = () => {
    if (moving || selected === undefined) return
    setMoving(true)
    setError(null)
    setBlocked(null)
    moveSession(request.sessionId, selected).then(() => {
      setMoving(false)
      onSettle()
    }).catch((reason: unknown) => {
      setMoving(false)
      const activity = activeSessionRefusal(reason)
      if (activity === undefined) {
        setError(reason instanceof Error ? reason.message : String(reason))
        return
      }
      setBlocked(activity)
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('move.title')}
      description={t('move.desc', { title: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={moving} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={moving || selected === undefined} onClick={confirm}>
            {t('move.action')}
          </Button>
        </>
      )}
    >
      {choices.length === 0
        ? <p className={browserCss.moveEmpty}>{t('move.empty')}</p>
        : (
          <div className={browserCss.moveChoices} role="radiogroup" aria-label={t('move.choose')}>
            {choices.map(choice => (
              <button
                key={choice.workspaceId}
                type="button"
                role="radio"
                aria-checked={choice.workspaceId === selected}
                tabIndex={choice.workspaceId === selected ? 0 : -1}
                className={browserCss.moveChoice}
                disabled={moving}
                onClick={() => { setSelected(choice.workspaceId); setError(null); setBlocked(null) }}
              >
                <span className={browserCss.moveChoiceLabel}>{choice.title}</span>
                <span className={browserCss.moveChoicePath}>{choice.path}</span>
              </button>
            ))}
          </div>
        )}
      {moving && <div className={browserCss.deleteStatus} role="status">{t('move.pending')}</div>}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
      {blocked !== null && (
        <div className={browserCss.renameError} role="alert">
          {t('move.blocked.desc')}
          <ul className={browserCss.moveBlocked} aria-label={t('move.blocked.listLabel')}>
            {blocked.map((entry, index) => (
              <li key={`${entry.kind}-${String(index)}`}>{activityLine(entry, t)}</li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

/**
 * The activity a Host `workspace/session-active` refusal reported, or nothing
 * for any other failure. The class identity check goes by name: client plugin
 * bundles do not share error-class identity.
 */
function activeSessionRefusal(reason: unknown): readonly SessionActivity[] | undefined {
  if (!(reason instanceof Error) || reason.name !== 'WorkspaceMoveSessionError') return undefined
  const { rpcError } = reason as WorkspaceMoveSessionError
  return rpcError.code === 'workspace/session-active' ? rpcError.details.activity : undefined
}

/**
 * One family's line: its count and the items' labels (ids when a family
 * carries no label). A family whose provider lists no per-item identity counts
 * as the single entry it reported. A family this dictionary does not know — a
 * provider merged into the kind map — falls through to the generic line.
 */
function activityLine(entry: SessionActivity, t: SessionMoveDialogProps['t']): string {
  const items = entry.items ?? []
  const n = Math.max(items.length, 1)
  const names = items.map(item => item.label ?? item.id).join(t('move.blocked.listSeparator'))
  const plural = n === 1 ? 'one' : 'other'
  switch (entry.kind) {
    case 'turn': return t('move.blocked.turn')
    case 'subagent': return t(`move.blocked.subagents.${plural}`, { n, names })
    case 'job': return t(`move.blocked.jobs.${plural}`, { n, names })
    case 'schedule': return t(`move.blocked.schedules.${plural}`, { n, names })
    default: return t(`move.blocked.other.${plural}`, { kind: entry.kind, n })
  }
}

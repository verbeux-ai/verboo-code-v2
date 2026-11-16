/** Ordered Chat rows, local echoes, and running status share the flow slot's parent. */
import { memo, useEffect, useMemo, type ReactElement } from 'react'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ChatFlowSlotProps } from '../contract/slots.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { ChatGroupSeat } from './ChatGroupSeat.tsx'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { chatRenderKey } from './render-entry.ts'
import { RunningStatus } from './RunningStatus.tsx'
import { RunningWhaleTail } from './RunningWhaleTail.tsx'
import { FlowRowVirtualizer } from './flow-row-virtualizer.ts'

/** A local submission echo, or a Host-pending steering item without a local submission. */
type PendingInput = ChatFlowSlotProps['pendingInputs'][number]

/** Whether the echo is a local submission rather than a Host-pending steering item. */
function isLocalSubmission(item: PendingInput): item is PendingSubmission {
  return 'requestId' in item
}

/** Whether the echo is a local submission that opens a new Turn. */
function isTranscriptEcho(item: PendingInput): boolean {
  return isLocalSubmission(item) && item.placement === 'transcript'
}

/** Render the flow without adding a DOM parent or changing keyed row positions. */
export const ChatFlow = memo(function ChatFlow({
  entries, pendingInputs, lastInputTurn, deferCollapse,
  useSession, useChat, useChatNode, useChatNodeBottom, useChatNodeProcess, useChatGroup, usePresentation, useConnectionState,
  useStore, actions, renderSlot, renderFactorySlot, t, useGroupAction, useGroupHeaderAction,
  cwd, openFile, inspectCall, forkAt, loadImage,
}: ChatFlowSlotProps) {
  const rowVirtualizer = useMemo(() => new FlowRowVirtualizer(), [])
  useEffect(() => () => { rowVirtualizer.dispose() }, [rowVirtualizer])
  const nodeStore = useChat(snapshot => snapshot.nodes)
  const running = useSession(snapshot => snapshot.running)
  const disconnected = useConnectionState(state => state === 'disconnected' || state === 'connecting')
  const latestTurnAnchor = useChat(snapshot => snapshot.navigation.items().at(-1)?.anchorKey)
  const runningStartTime = useChatNode(latestTurnAnchor ?? '', (node) => {
    const location = node?.location
    return location?.kind === 'turn' || location?.kind === 'step'
      ? location.turn.status === 'open' ? location.turn.start?.time : undefined
      : undefined
  })
  const latestTurnOpen = useChatNode(latestTurnAnchor ?? '', (node) => {
    const location = node?.location
    return (location?.kind === 'turn' || location?.kind === 'step') && location.turn.status === 'open'
  })
  const holding = !running && latestTurnOpen
  const seatProps = useMemo(() => ({
    nodeStore, useChatNode, useChatNodeBottom, useChatNodeProcess, usePresentation,
    useStore, actions, renderSlot, t, useGroupAction, deferCollapse,
    cwd, openFile, inspectCall, forkAt, loadImage, rowVirtualizer,
  }), [nodeStore, useChatNode, useChatNodeBottom, useChatNodeProcess, usePresentation,
    useStore, actions, renderSlot, t, useGroupAction, deferCollapse,
    cwd, openFile, inspectCall, forkAt, loadImage, rowVirtualizer])
  const latestUserAuthoredKey = useMemo(() => {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (entry?.kind !== 'node') continue
      const kind = nodeStore.get(entry.key)?.kind
      if (kind === 'user' || kind === 'steering') return entry.key
    }
    return null
  }, [entries, nodeStore])
  const deferredRowCount = Math.max(0, entries.length - 100)
  const rows = useMemo(() => entries.map((entry, index) => {
    const deferOffscreenLayout = index < deferredRowCount
    switch (entry.kind) {
      case 'node':
        return <ChatNodeSeat {...seatProps} key={chatRenderKey(entry)} nodeKey={entry.key}
          deferOffscreenLayout={deferOffscreenLayout}
          revealActions={(nodeStore.get(entry.key)?.kind === 'user' || nodeStore.get(entry.key)?.kind === 'steering')
            && entry.key !== latestUserAuthoredKey}
          {...entry.groupPart === undefined ? {} : { groupPart: entry.groupPart }} />
      case 'group':
        return <ChatGroupSeat {...seatProps} key={chatRenderKey(entry)} groupKey={entry.key}
          deferOffscreenLayout={deferOffscreenLayout}
          useChatGroup={useChatGroup} useGroupHeaderAction={useGroupHeaderAction} />
      default:
        return assertNever(entry)
    }
  }), [deferredRowCount, entries, latestUserAuthoredKey, nodeStore, seatProps, useChatGroup, useGroupHeaderAction])
  // Transcript echoes open the running Turn and precede the status; steering
  // and Inbox echoes follow it, so the status stays on the running Turn's tail.
  // The first transcript echo opens the next Turn, whose first claim takes the
  // steering already pending ahead of it before that prompt; those echoes lead
  // the same Turn in claim order.
  const firstTranscript = pendingInputs.findIndex(isTranscriptEcho)
  const leadingRows: ReactElement[] = []
  const openingRows: ReactElement[] = []
  const pendingRows: ReactElement[] = []
  for (const [index, item] of pendingInputs.entries()) {
    const row = isLocalSubmission(item)
      ? <PendingSubmissionBubble key={item.requestId} submission={item}
        loadImage={loadImage} renderFactorySlot={renderFactorySlot} t={t} />
      : <PendingSteeringBubble key={item.id} content={item.content}
        loadImage={loadImage} renderFactorySlot={renderFactorySlot} t={t} />
    if (index <= firstTranscript) leadingRows.push(row)
    else if (isTranscriptEcho(item)) openingRows.push(row)
    else pendingRows.push(row)
  }
  const tail = entries.at(-1)
  const node = tail?.kind === 'node' ? nodeStore.get(tail.key) : undefined
  const dividerRevision = useMemo(() => ({ entries, nodeStore, pendingInputs }), [entries, nodeStore, pendingInputs])
  // An empty opening control follows the echoes that lead its Turn. Keep the
  // memoized keyed rows immutable while inserting the echoes before that control.
  const hasOpeningControl = node?.kind === 'turn-process' && node.location.kind === 'turn'
    && node.location.turn.status === 'open' && node.location.turn.turn !== lastInputTurn
  const flowRows = hasOpeningControl && leadingRows.length > 0
    ? [...rows.slice(0, -1), ...leadingRows, ...rows.slice(-1)]
    : rows
  const trailingLeadingRows = hasOpeningControl ? [] : leadingRows
  // Rows enter before the keyed status and echoes after it, so React never moves its DOM node. The
  // running bit and the Turn's end arrive separately: after the bit clears, an open latest Turn keeps
  // the status slot (hidden) until its actions row takes the slot in the same commit.
  return [
    ...flowRows, ...trailingLeadingRows, ...openingRows,
    ...running || holding ? [<RunningStatus key="running" startTime={runningStartTime} paused={disconnected}
      holding={holding} dividerRevision={dividerRevision} indicator={renderSlot('conversation.chat.running.indicator', {}, {
        fallback: <RunningWhaleTail />,
      })} t={t} />] : [],
    ...pendingRows,
  ]
})

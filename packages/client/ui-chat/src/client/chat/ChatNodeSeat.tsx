import { memo, useCallback, useEffect, useMemo, useSyncExternalStore, type MutableRefObject } from 'react'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConversationLocationDataStore, ConversationTurnDataMap } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeHookContext, ChatNodeOwnerProps, ChatFlowSlotProps, UsePresentation } from '../contract/slots.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatNodeStore } from '../contract/snapshot.ts'
import { isAtOrOutside } from '../contract/group-tree.ts'
import { turnProcessAlwaysOpen } from '../contract/turn-process.ts'
import { turnProcessOpen } from '../stores.ts'
import { hiddenOrCollapsing } from './flow-motion.ts'
import { FlowRowVirtualizer } from './flow-row-virtualizer.ts'
import css from './ChatView.module.css'

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly nodeKey: string
  /** Older user-authored rows reveal their actions only on hover or focus. */
  readonly revealActions?: boolean
  /** Allow the browser to skip offscreen layout for older, settled rows. */
  readonly deferOffscreenLayout?: boolean
  /** A replaced Builder must rebind keyed hooks even when references and keys survive. */
  readonly nodeStore: ChatNodeStore
  readonly useChatNode: ChatFlowSlotProps['useChatNode']
  readonly useChatNodeProcess: ChatFlowSlotProps['useChatNodeProcess']
  readonly usePresentation: UsePresentation
  readonly useStore: ChatFlowSlotProps['useStore']
  readonly actions: ChatFlowSlotProps['actions']
  readonly renderSlot: ChatFlowSlotProps['renderSlot']
  readonly t: ChatFlowSlotProps['t']
  readonly useChatNodeBottom: ChatFlowSlotProps['useChatNodeBottom']
  readonly deferCollapse: boolean
  readonly useGroupAction: ChatFlowSlotProps['useGroupAction']
  readonly rowVirtualizer: FlowRowVirtualizer
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

/** Rows outside a Turn process never advance a disclosure reset generation. */
const NOOP_UNSUBSCRIBE = (): void => {}
const EMPTY_DISCLOSURE_RESET: ObservableSnapshot<number> = Object.freeze({
  getSnapshot: () => 0,
  subscribe: () => NOOP_UNSUBSCRIBE,
})
const NOOP_RESET_DISCLOSURE = (): void => {}

function turnDataOf(node: ChatNode | undefined): ConversationLocationDataStore<ConversationTurnDataMap> | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.data : undefined
}

function turnOf(node: ChatNode | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
}

/**
 * Subscribe, apply Turn-process visibility, and dispatch one stable Context key.
 * Policy reads select this seat's own conclusion, so a mode change re-renders
 * only seats whose visibility actually changes.
 */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, groupPart, revealActions = false, deferOffscreenLayout = false, useChatNode, useChatNodeProcess, usePresentation,
  cwd, openFile, inspectCall, forkAt,
  loadImage, useStore, actions, renderSlot, t, useChatNodeBottom, deferCollapse, useGroupAction, rowVirtualizer,
}: ChatNodeSeatProps) {
  const bottom = useChatNodeBottom(nodeKey)
  const node = useChatNode(nodeKey)
  const routedNode = node as ChatNode | undefined
  const flowKey = groupPart === undefined || groupPart === 'response' ? nodeKey : JSON.stringify([nodeKey, groupPart])
  const turn = turnOf(routedNode)
  const processPresentation = useChatNodeProcess(nodeKey)
  const processSpec = processPresentation?.spec
  const storedOpen = useStore(state => processSpec !== undefined
    && turnProcessOpen(state, processSpec, bottom === true && deferCollapse))
  const liveProcess = processPresentation !== undefined && !processPresentation.turnClosed
  const interleavedInput = processPresentation?.hasInterleavedInput === true
  const alwaysOpen = liveProcess || interleavedInput || turnProcessAlwaysOpen(routedNode)
  const processOpen = alwaysOpen || storedOpen
  const setOpen = useCallback((open: boolean) => {
    if (processSpec !== undefined && !alwaysOpen) {
      actions.setTurnProcessOpen(processSpec.turn, processSpec.answerStep ?? 0, open)
    }
  }, [actions, processSpec, alwaysOpen])
  const foldCompleted = usePresentation(policy => policy.foldCompletedTurns)
  const keepReplies = usePresentation(policy => policy.foldedReplies === 'all')
  // A loaded end makes a partial historical Turn eligible without its start.
  const processWindowReady = processSpec !== undefined
    && processPresentation !== undefined
    && foldCompleted
    && processPresentation.turn === processSpec.turn
    && (processPresentation.turnStarted || processPresentation.turnClosed)
  // With every reply kept, an Assistant reply stays outside whole-Turn folding; its reasoning remains process content.
  const replyRow = keepReplies
    && routedNode?.kind === 'assistant-step'
    && groupPart !== 'reasoning'
    && hasAssistantReplyContent(routedNode.data.blocks)
  const processMember = routedNode !== undefined
    && processWindowReady
    && !replyRow
    && !isAtOrOutside(routedNode, 'turn')
    && routedNode.anchorSeq >= processSpec.processStartSeq
    && (liveProcess || processSpec.answerAnchorSeq === null || routedNode.anchorSeq < processSpec.answerAnchorSeq
      || (groupPart === 'reasoning' && routedNode.kind === 'assistant-step' && routedNode.data.step === processSpec.answerStep))
  const processAnswer = routedNode !== undefined
    && processWindowReady
    && !liveProcess
    && groupPart !== 'reasoning'
    && routedNode.kind === 'assistant-step'
    && routedNode.data.step === processSpec.answerStep
  const ownsDisclosure = routedNode?.kind === 'turn-process' || processAnswer || replyRow
  const foldable = processWindowReady
    && (liveProcess || processMember || ownsDisclosure)
  const turnProcess = useMemo(() => processSpec === undefined
    ? undefined
    : {
      spec: processSpec,
      foldable,
      hasContent: !interleavedInput && (processSpec.inlineReasoning || (keepReplies
        ? processPresentation?.hasNonReplyProcess === true
        : processPresentation?.hasExternalProcess === true)),
      open: processOpen,
      setOpen,
    }, [
    foldable, interleavedInput, keepReplies, processOpen, processSpec,
    processPresentation?.hasExternalProcess, processPresentation?.hasNonReplyProcess, setOpen,
  ])
  const controllerInactive = routedNode?.kind === 'turn-process'
    && foldCompleted && !foldable
  const processHidden = controllerInactive || (foldable && processMember && !processOpen)
  const revealProcess = useCallback(() => {
    if (processMember) setOpen(true)
  }, [processMember, setOpen])
  const wrapperRef = useGroupAction(processHidden, revealProcess)
  const canSuspendContent = deferOffscreenLayout
    && !processMember
    && routedNode?.kind === 'assistant-step'
    && routedNode.data.status !== 'running'
  const subscribeVirtualization = useCallback(
    (listener: () => void) => rowVirtualizer.subscribe(flowKey, listener),
    [flowKey, rowVirtualizer],
  )
  const readVirtualization = useCallback(
    () => rowVirtualizer.getSnapshot(flowKey),
    [flowKey, rowVirtualizer],
  )
  const virtualization = useSyncExternalStore(subscribeVirtualization, readVirtualization, readVirtualization)
  const rootRef = useCallback((element: HTMLDivElement | null) => {
    (wrapperRef as MutableRefObject<HTMLDivElement | null>).current = element
    rowVirtualizer.register(flowKey, element, canSuspendContent)
  }, [canSuspendContent, flowKey, rowVirtualizer, wrapperRef])
  useEffect(() => () => { rowVirtualizer.unregister(flowKey) }, [flowKey, rowVirtualizer])
  const disclosure = useMemo(() => {
    if (!processMember) return { source: EMPTY_DISCLOSURE_RESET, reset: NOOP_RESET_DISCLOSURE }
    const source = createSnapshotStore(0)
    return { source, reset: () => { source.set(source.getSnapshot() + 1) } }
  }, [processMember])
  const { source: disclosureReset, reset: resetDisclosure } = disclosure
  const turnData = turnDataOf(routedNode)
  const hookContext = useMemo<ChatNodeHookContext>(
    () => ({ turnData, disclosureReset, useGroupAction }), [turnData, disclosureReset, useGroupAction],
  )
  useEffect(() => {
    if (processMember && processHidden && wrapperRef.current !== null && hiddenOrCollapsing(wrapperRef.current)) {
      resetDisclosure()
    }
  }, [processMember, processHidden, wrapperRef, resetDisclosure])
  const owner = useMemo<ChatNodeOwnerProps | null>(() => node === undefined
    ? null
    : {
      ...groupPart === undefined ? {} : { groupPart },
      ...virtualization.suspended ? { virtualization: { suspended: true } } : {},
      cwd,
      openFile,
      inspectCall,
      forkAt,
      loadImage,
      turnProcess,
    }, [
    node, groupPart, virtualization.suspended, cwd, openFile, inspectCall, forkAt,
    loadImage, turnProcess,
  ])
  if (routedNode === undefined || owner === null) return null
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner
  const emptyFlow = routedNode.kind === 'turn-process'
    && (routedNode.location.kind === 'turn' || routedNode.location.kind === 'step')
    && routedNode.location.turn.status !== 'closed'
  const steeringBatchStart = routedNode.kind === 'steering' && routedNode.data.batchStart === true
  return (
    <div
      ref={rootRef}
      className={css.flowItem}
      data-chat-anchor-key={flowKey}
      data-chat-flow-key={flowKey}
      data-chat-paging-anchor={routedNode.kind !== 'turn-process' || undefined}
      data-chat-node-key={routedNode.key}
      data-chat-group-part={groupPart}
      data-actions-reveal={revealActions ? 'hover' : undefined}
      data-chat-history-row={deferOffscreenLayout || undefined}
      data-chat-content-virtualized={virtualization.suspended || undefined}
      style={virtualization.suspended && virtualization.height !== null
        ? { minHeight: `${virtualization.height}px` }
        : undefined}
      data-chat-flow-empty={emptyFlow || undefined}
      data-chat-steering-batch-start={steeringBatchStart || undefined}
      data-chat-flow-kind={routedNode.kind}
      data-chat-turn={turn}
      data-turn-process-member={processMember || undefined}
      data-turn-process-hidden={processHidden || undefined}
    >
      {renderSlot('conversation.chat.node', routedOwner, {
        entryKey: routedNode.kind,
        hookContext,
        fallback: (
          <JsonBlock
            label={t('message.unknownSurface', { type: routedNode.kind })}
            payload={routedNode.data}
            truncatedLabel={total => t('json.truncated', { total })}
          />
        ),
      })}
    </div>
  )
})

/** General Settings row for work-details presentation. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatKey } from '../locale.ts'
import { COLLAPSE_TIMINGS, FOLDED_REPLIES, type CollapseTiming, type FoldedReplies } from '../presentation-policy.ts'
import { PreferenceRow } from './PreferenceRow.tsx'

/** Registration-side work-details preference face. */
export interface TranscriptViewRowInjected {
  hooks: {
    /** Persisted collapse timing bound as useCollapseTiming. */
    collapseTiming: SnapshotStore<CollapseTiming>
    /** Persisted folded-reply choice bound as useFoldedReplies. */
    foldedReplies: SnapshotStore<FoldedReplies>
  }
  /** Persist collapse timing independently of the work-details mode. */
  setCollapseTiming: (timing: CollapseTiming) => void
  /** Persist which Assistant replies stay visible in a folded Turn. */
  setFoldedReplies: (replies: FoldedReplies) => void
}

/** Full Settings-row props. */
export type TranscriptViewRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'chat'>
  & InjectFace<TranscriptViewRowInjected>

const COLLAPSE_LABELS = {
  completion: 'settings.collapse.completion',
  'next-input': 'settings.collapse.nextInput',
} as const satisfies Record<CollapseTiming, ChatKey>

const FOLDED_REPLY_LABELS = {
  all: 'settings.foldedReplies.all',
  final: 'settings.foldedReplies.final',
} as const satisfies Record<FoldedReplies, ChatKey>

/**
 * Render the independent, Host-backed collapse-timing and folded-reply selectors.
 * The work-details presentation itself is not a choice: this product ships one.
 * @param props - composed Settings slot props.
 * @returns the preference rows.
 */
export function TranscriptViewRow({
  useCollapseTiming, setCollapseTiming, useFoldedReplies, setFoldedReplies, t,
}: TranscriptViewRowProps) {
  const timing = useCollapseTiming(value => value)
  const replies = useFoldedReplies(value => value)
  return (
    <>
      <PreferenceRow
        title={t('settings.collapse.title')}
        description={t('settings.collapse.description')}
        value={timing}
        selectedLabel={t(COLLAPSE_LABELS[timing])}
        options={COLLAPSE_TIMINGS.map(id => ({ id, label: t(COLLAPSE_LABELS[id]) }))}
        onSelect={(value) => { setCollapseTiming(value as CollapseTiming) }}
      />
      <PreferenceRow
        title={t('settings.foldedReplies.title')}
        description={t('settings.foldedReplies.description')}
        value={replies}
        selectedLabel={t(FOLDED_REPLY_LABELS[replies])}
        options={FOLDED_REPLIES.map(id => ({ id, label: t(FOLDED_REPLY_LABELS[id]) }))}
        onSelect={(value) => { setFoldedReplies(value as FoldedReplies) }}
      />
    </>
  )
}

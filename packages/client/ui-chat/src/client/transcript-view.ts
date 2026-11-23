/** Independent work-details preferences backed by the same Host configuration form. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CollapseTiming, FoldedReplies } from './presentation-policy.ts'
import {
  COLLAPSE_TIMING_FIELD, DEFAULT_COLLAPSE_TIMING, DEFAULT_FOLDED_REPLIES, FOLDED_REPLIES_FIELD,
  TRANSCRIPT_VIEW_MODE,
  type ChatSettings, type TranscriptViewMode,
} from '../chat-settings.ts'

/** Live work-details preference consumed by Chat and its Settings row. */
export class TranscriptViewPolicy {
  private readonly unsubscribe: () => void
  /** Reactive current mode, including the client default before Host settings arrive. */
  readonly mode: SnapshotStore<TranscriptViewMode>
  /** Reactive collapse timing, defaulting to completion until Host settings arrive. */
  readonly collapseTiming: SnapshotStore<CollapseTiming> = createSnapshotStore<CollapseTiming>(DEFAULT_COLLAPSE_TIMING)
  /** Reactive folded-reply choice, keeping every reply until Host settings arrive. */
  readonly foldedReplies: SnapshotStore<FoldedReplies> = createSnapshotStore<FoldedReplies>(DEFAULT_FOLDED_REPLIES)

  /**
   * @param host - durable Chat settings scope.
   */
  constructor(private readonly host: ConfigForm<ChatSettings>) {
    this.mode = createSnapshotStore(TRANSCRIPT_VIEW_MODE)
    this.unsubscribe = host.subscribe(() => { this.adopt() })
    this.adopt()
  }

  /** Release the accepted-value subscription. */
  dispose(): void { this.unsubscribe() }

  /**
   * Publish and persist collapse timing without changing the work-details mode.
   * @param timing - immediate completion folding or deferred folding at the next input.
   */
  setCollapseTiming(timing: CollapseTiming): void {
    if (this.collapseTiming.getSnapshot() === timing) return
    this.collapseTiming.set(timing)
    void this.host.set(COLLAPSE_TIMING_FIELD, timing)
  }

  /**
   * Publish and persist which Assistant replies stay visible in a folded Turn.
   * @param replies - every reply, or only the final answer.
   */
  setFoldedReplies(replies: FoldedReplies): void {
    if (this.foldedReplies.getSnapshot() === replies) return
    this.foldedReplies.set(replies)
    void this.host.set(FOLDED_REPLIES_FIELD, replies)
  }

  /** Adopt the latest accepted Host section without writing it back. */
  private adopt(): void {
    const section = this.host.getSnapshot().value
    if (section === undefined) return
    // The saved mode is accepted by the schema but never applied: this product
    // ships one presentation, and an earlier build's choice must not change it.
    if (this.mode.getSnapshot() !== TRANSCRIPT_VIEW_MODE) this.mode.set(TRANSCRIPT_VIEW_MODE)
    const timing = section.collapseTiming ?? DEFAULT_COLLAPSE_TIMING
    if (this.collapseTiming.getSnapshot() !== timing) this.collapseTiming.set(timing)
    const replies = section.foldedReplies ?? DEFAULT_FOLDED_REPLIES
    if (this.foldedReplies.getSnapshot() !== replies) this.foldedReplies.set(replies)
  }
}

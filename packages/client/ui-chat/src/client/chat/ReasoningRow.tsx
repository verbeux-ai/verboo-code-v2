/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { memo, useMemo } from 'react'
import { DisclosureRow, IconThinkOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatViewSlotProps, UseDisclosure, UsePresentation } from '../contract/slots.ts'
import { reasoningText } from '../reasoning-text.ts'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

const THINK_ICON = <IconThinkOutlineRegular size={14} />

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/**
 * The block's opening line: the first line that carries text, trimmed. It is
 * fixed as soon as it appears, so a streaming preview keeps one stable width
 * instead of chasing each completed paragraph.
 * @param text - complete or streaming reasoning text.
 * @returns the opening line, or `''` while the block holds no text yet.
 */
function openingLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/**
 * Render one assistant reasoning block collapsed until the reader opens it. The
 * collapsed summary omits double-asterisk markers; expanded content renders
 * the complete Markdown with secondary typography. The preview holds the block's
 * opening line for the whole stream, so the row keeps one stable width while the
 * model thinks instead of jumping to each completed paragraph. Mode changes toggle CSS display without unmounting
 * collapsed summaries. The Body Slot receives both original and display-ready text.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.usePresentation - live display-policy selector for this reasoning row.
 * @param props.useDisclosure - independent open state with enclosing-Turn resets.
 * @param props.renderSlot - framework renderer for the standard reasoning Body Slot.
 * @param props.t - conversation locale seat for the disclosure and running status.
 * @returns the reasoning disclosure.
 */
export const ReasoningRow = memo(function ReasoningRow({
  text: rawText, running, textInteractionSource = false, usePresentation, useDisclosure, renderSlot, t,
}: {
  text: string
  running: boolean
  textInteractionSource?: boolean
  useDisclosure: UseDisclosure
  usePresentation: UsePresentation
  t: ChatViewSlotProps['t']
} & Pick<PropsRenderSlots<'conversation.chat.reasoning.body'>, 'renderSlot'>) {
  const { expanded, toggle } = useDisclosure()
  const { text, hidden } = useMemo(() => {
    const text = reasoningText(rawText)
    return { text, hidden: text !== rawText && text.trim() === '' }
  }, [rawText])
  const summaryText = running ? openingLine(text) : firstLine(text)
  const summary = useMemo(() => summaryText.replaceAll('**', ''), [summaryText])
  const preview = usePresentation(policy => !expanded && summary !== ''
    && (running || policy.settledReasoningPreview))
  const collapsedContent = useMemo(() => (
    <>
      <span className={css.separator} data-shimmer-decoration aria-hidden />
      <span className={css.summary} data-streaming={running || undefined}>
        <span className={css.summaryText}>
          <TextShimmer>{summary}</TextShimmer>
        </span>
      </span>
    </>
  ), [running, summary])
  const content = useMemo(() => expanded ? (
    <div className={css.thinkBody} data-text-interaction-source={textInteractionSource && !running ? '' : undefined}>
      {renderSlot('conversation.chat.reasoning.body', { rawText, text, running })}
    </div>
  ) : undefined, [expanded, renderSlot, running, rawText, text, textInteractionSource])

  if (hidden) return null

  return (
    <div
      className={css.root}
      data-variant="think"
      data-state={running ? 'running' : 'ok'}
      data-expanded={expanded || undefined}
      data-preview={preview || undefined}
    >
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        icon={THINK_ICON}
        title={t('message.think')}
        running={running}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={toggle}
        collapsedContent={collapsedContent}
      >
        {content}
      </DisclosureRow>
    </div>
  )
})

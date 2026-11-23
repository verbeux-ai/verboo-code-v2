/** Localized titles for projected step-process activity. */
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ProcessActivitySummary } from '../contract/process-groups.ts'

/**
 * Compose a closed group's localized title from the number of actions it holds.
 *
 * The transcript shows one group per Turn, so listing the categories repeated
 * the same sentence once per reply and read as noise. The count keeps the
 * closed row to one short line while the body still holds every action.
 * @param summary - ranked work and phase evidence for this range.
 * @param t - Chat namespace translator.
 * @returns the secondary disclosure title.
 */
export function processTitle(
  summary: ProcessActivitySummary,
  t: ChatViewSlotProps['t'],
): string {
  const total = summary.counts.reduce((sum, entry) => sum + entry.count, 0)
  if (total === 0) return t('message.stepProcess.done.thinking')
  return t('message.stepProcess.done.summary', { count: total })
}

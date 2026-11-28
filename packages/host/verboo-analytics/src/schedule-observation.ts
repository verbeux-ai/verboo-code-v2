/** Fixed Schedule tool categories derived locally without retaining tool content. */
import { z } from 'zod'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'

/** Schedule tool action categories without task data. */
export type ScheduleObservation = 'schedule_create' | 'schedule_edit' | 'schedule_delete' | 'schedule_pause' | 'schedule_resume'

/**
 * Classify a Schedule tool request without returning its arguments.
 * @param name - tool name.
 * @param args - raw tool arguments, read locally.
 * @returns a fixed action category, or undefined for an unrelated tool.
 */
export function scheduleObservation(name: string, args: string): ScheduleObservation | undefined {
  if (name === 'schedule_create') return 'schedule_create'
  if (name !== 'schedule_edit') return undefined
  if (args.length > 65_536) return 'schedule_edit'
  try {
    const parsed = z.object({ action: z.enum(['update', 'delete']), active: z.boolean().optional() }).safeParse(JSON.parse(args))
    if (!parsed.success) return 'schedule_edit'
    if (parsed.data.action === 'delete') return 'schedule_delete'
    if (parsed.data.active === false) return 'schedule_pause'
    if (parsed.data.active === true) return 'schedule_resume'
  } catch (_error) { /* Invalid tool arguments have no more specific category. */ }
  return 'schedule_edit'
}

/**
 * Classify an authoritative Schedule result; unrecognized output stays unknown.
 * @param message - tool result read locally.
 * @returns a fixed outcome, or undefined if the result is not recognizable.
 */
export function scheduleOutcome(message: ToolResultMessage): 'completed' | 'failed' | undefined {
  if (message.isError === true) return 'failed'
  const text = message.content.length === 1 && message.content[0]?.type === 'text' ? message.content[0].text : undefined
  if (text === undefined || text.length > 65_536) return undefined
  try {
    const parsed = z.object({ kind: z.enum(['after', 'at', 'every', 'daily', 'weekly', 'cron', 'rrule']).optional(),
      deleted: z.boolean().optional(), code: z.string().optional() }).safeParse(JSON.parse(text))
    if (!parsed.success) return undefined
    if (parsed.data.code !== undefined) return 'failed'
    if (parsed.data.kind !== undefined || parsed.data.deleted === true) return 'completed'
  } catch (_error) { /* Unrecognized results do not establish an outcome. */ }
  return undefined
}

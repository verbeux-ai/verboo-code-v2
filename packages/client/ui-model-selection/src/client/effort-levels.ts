/**
 * Level names and explanations for the effort rail.
 *
 * The Host advertises each level by an adapter-owned id, and the same id can
 * reach this Client from several providers: `llm-deepseek` names four levels,
 * the backend vocabulary adds `none` and `xhigh`, and a pi-ai route passes
 * every thinking level through. A known id therefore renders in the reader's
 * own language, while an id this vocabulary does not name keeps the Host's
 * wording, which is the only accurate text for a level it invented.
 */

import type { ModelReasoningEffort } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelKey } from './locales.ts'

/** Level ids this vocabulary names, in escalation order. */
const KNOWN_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One level id this vocabulary names. */
type KnownLevel = typeof KNOWN_LEVELS[number]

/** The name and explanation keys one known level contributes. */
const LEVEL_KEYS: Record<KnownLevel, { name: ModelKey; description: ModelKey }> = {
  off: { name: 'effort.level.off', description: 'effort.description.off' },
  minimal: { name: 'effort.level.minimal', description: 'effort.description.minimal' },
  low: { name: 'effort.level.low', description: 'effort.description.low' },
  medium: { name: 'effort.level.medium', description: 'effort.description.medium' },
  high: { name: 'effort.level.high', description: 'effort.description.high' },
  xhigh: { name: 'effort.level.xhigh', description: 'effort.description.xhigh' },
  max: { name: 'effort.level.max', description: 'effort.description.max' },
}

/**
 * Match a Host level id against the vocabulary.
 * @param id - the adapter-owned level id.
 * @returns the named level, or `undefined` when this vocabulary does not name it.
 */
function knownLevel(id: string): KnownLevel | undefined {
  const normalized = id.trim().toLowerCase()
  return KNOWN_LEVELS.find(level => level === normalized)
}

/**
 * Localized name of one effort level.
 * @param effort - the level the Host advertised.
 * @param t - the `model` namespace translator.
 * @returns the reader's name for a known level, else the Host's own name.
 */
export function effortName(
  effort: ModelReasoningEffort,
  t: (key: ModelKey) => string,
): string {
  const level = knownLevel(effort.id)
  return level === undefined ? effort.name : t(LEVEL_KEYS[level].name)
}

/**
 * Localized explanation of one effort level.
 * @param effort - the level the Host advertised.
 * @param t - the `model` namespace translator.
 * @returns the reader's explanation for a known level, else the Host's own
 * description, or `undefined` when the Host supplied none.
 */
export function effortDescription(
  effort: ModelReasoningEffort,
  t: (key: ModelKey) => string,
): string | undefined {
  const level = knownLevel(effort.id)
  return level === undefined ? effort.description : t(LEVEL_KEYS[level].description)
}

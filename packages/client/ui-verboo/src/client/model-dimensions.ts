/** Select bounded model dimensions without exposing custom provider labels. */
import type { ProductModelDetails } from '@deepseek-ai/dsh-host-verboo-analytics/types'

const efforts = new Set<ProductModelDetails['effort']>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/**
 * Restrict observations to the Verboo, OpenAI account and official DeepSeek catalogs.
 * @param selected - Session's selected model, captured at submission time.
 * @returns bounded dimensions, with custom provider and model labels grouped as other.
 */
export function modelDimensions(
  selected: { readonly provider: string; readonly name: string; readonly effort?: string } | undefined,
): ProductModelDetails | undefined {
  if (selected === undefined) return undefined
  const provider = selected.provider === 'deepseek-account' ? 'verboo' : selected.provider === 'openai-account' ? 'openai'
    : selected.provider === 'deepseek-official' ? 'deepseek' : 'other'
  const effort = selected.effort === undefined ? 'default'
    : efforts.has(selected.effort as ProductModelDetails['effort']) ? selected.effort as ProductModelDetails['effort'] : 'other'
  const model = provider !== 'other' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(selected.name) ? selected.name : 'other'
  return { provider, model, effort }
}

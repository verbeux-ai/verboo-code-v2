/** Bind the selected Verboo route to its server-owned group identity. */
import type { HostObservable, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PlanId, Plans, StaminaStatus } from '@deepseek-ai/dsh-api-verboo-product/types'

/** The same accepted selection the composer's model control displays. */
export type StaminaModelState = Pick<ModelDirectoryState, 'current'>

/** Renderer binds the session's existing model directory without another subscription. */
export interface StaminaModelInjected {
  hooks: { staminaModel: HostObservable<StaminaModelState> }
}

/** Model selector hook shared by the liquid and its optional diagnostics. */
export type StaminaModelProps = InjectFace<StaminaModelInjected>

/** A route can be known before its group metadata or stamina is available. */
export interface SelectedStamina {
  group: { id: PlanId | null; slug: string; name: string } | null
  reading: StaminaStatus | undefined
}

/**
 * Match the exact routing slug, then join stamina by group ID; never choose another enrollment.
 * @param plans - accepted account catalog and subscriptions.
 * @param model - accepted selection from the existing model directory.
 * @param rows - public stamina belonging to the same authenticated account.
 * @returns the selected group and its reading, absent when unresolved or unavailable.
 */
export function selectStaminaForModel(
  plans: Plans | null,
  model: StaminaModelState['current'],
  rows: StaminaStatus[] | undefined,
): SelectedStamina {
  if (model?.provider !== 'deepseek-account') return { group: null, reading: undefined }
  const split = model.model.indexOf('/')
  if (split < 1 || split === model.model.length - 1) return { group: null, reading: undefined }
  const slug = model.model.slice(0, split)
  const candidates = [
    ...(plans?.subscriptions.map(plan => ({ id: plan.planId, name: plan.name, slug: plan.slug })) ?? []),
    ...(plans?.catalog ?? []),
  ].filter(plan => plan.slug === slug)
  const ids = new Set(candidates.map(plan => plan.id))
  const match = ids.size === 1 ? candidates[0] : undefined
  const group = { id: match?.id ?? null, slug, name: match?.name ?? slug }
  return { group, reading: group.id === null ? undefined : rows?.find(row => row.groupId === group.id) }
}

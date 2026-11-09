import { describe, expect, it } from 'vitest'
import type { PlanId, Plans, StaminaStatus } from '@deepseek-ai/dsh-api-verboo-product/types'
import { selectStaminaForModel } from '../src/client/stamina-selection.ts'

const max = '00000000-0000-4000-8000-000000000001' as PlanId
const tests = '00000000-0000-4000-8000-000000000002' as PlanId
const plans: Plans = {
  subscriptions: [
    { id: 'max-sub', planId: max, name: 'Max', slug: 'max', status: 'active', renewsAt: null, cancelAtEnd: false, canUpgrade: false, billing: null },
    { id: 'test-sub', planId: tests, name: 'Testes', slug: 'testes', status: 'active', renewsAt: null, cancelAtEnd: false, canUpgrade: false, billing: null },
  ], catalog: [],
}
const rows: StaminaStatus[] = [
  { groupId: tests, groupName: 'Testes', remainingPercent: 100, nextOutputTps: 200, recovering: false, fullAt: null, accountingPending: false, asOf: '2026-11-07T20:00:00Z' },
  { groupId: max, groupName: 'Max', remainingPercent: 37.125, nextOutputTps: 50, recovering: false, fullAt: null, accountingPending: false, asOf: '2026-11-07T20:00:00Z' },
]
const selected = (model: string, provider = 'deepseek-account') => ({ provider, model })

describe('stamina of the selected model group', () => {
  it('joins the server routing slug to its group ID, regardless of order or another balance', () => {
    expect(selectStaminaForModel(plans, selected('max/glm-5.3-flash'), rows)).toEqual({
      group: { id: max, slug: 'max', name: 'Max' }, reading: rows[1],
    })
    expect(selectStaminaForModel(plans, selected('max/glm-5.3-flash'), [{ ...rows[0]!, remainingPercent: 1 }, rows[1]!]).reading).toBe(rows[1])
  })
  it('moves to the accepted model group without retaining the previous percentage', () => {
    expect(selectStaminaForModel(plans, selected('testes/vendor/model'), rows).reading).toBe(rows[0])
  })
  it('shows the selected group without borrowing stamina from another enrollment', () => {
    expect(selectStaminaForModel(plans, selected('max/glm-5.3-flash'), [rows[0]!])).toEqual({
      group: { id: max, slug: 'max', name: 'Max' }, reading: undefined,
    })
  })
  it('uses public catalog identities when no owned subscription supplies the slug', () => {
    const catalog: Plans = { subscriptions: [], catalog: [{ id: max, name: 'Max', slug: 'max', description: '', priceCents: 100, currency: 'BRL', interval: 'month' }] }
    expect(selectStaminaForModel(catalog, selected('max/model'), rows).reading).toBe(rows[1])
  })
  it('does not guess a group from its name, a single reading or missing legacy metadata', () => {
    const legacy: Plans = { ...plans, subscriptions: plans.subscriptions.map(({ slug: _slug, ...plan }) => plan) }
    expect(selectStaminaForModel(legacy, selected('max/model'), rows)).toEqual({
      group: { id: null, slug: 'max', name: 'max' }, reading: undefined,
    })
    expect(selectStaminaForModel(null, selected('max/model'), [rows[0]!]).reading).toBeUndefined()
  })
  it('refuses conflicting identities for the same routing slug', () => {
    const conflicting: Plans = { ...plans, subscriptions: plans.subscriptions.map(plan => ({ ...plan, slug: 'max' })) }
    expect(selectStaminaForModel(conflicting, selected('max/model'), rows).reading).toBeUndefined()
  })
  it.each([null, selected('glm-5.3-flash'), selected('max/'), selected('max/model', 'other-provider')])('has no invented group for an unresolved or foreign route', (model) => {
    expect(selectStaminaForModel(plans, model, rows)).toEqual({ group: null, reading: undefined })
  })
})

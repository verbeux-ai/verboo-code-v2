import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import { productResponseProjection } from '../src/projection.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function fixture(subagent = false) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const handle = await ctx.sessionProjections.register(productResponseProjection)
  const session = ctx.sessions.create(SessionId(`analytics-${contexts.length}`), subagent ? { meta: { origin: 'subagent', delegationDepth: 1 } } : {})
  return { ctx, session, handle }
}

function response(
  session: Session,
  options: { human?: boolean; step?: boolean; text?: string; interrupted?: true; provider?: string; reason?: TurnEndReason } = {},
) {
  session.append('turn/start', { turn: 1 })
  if (options.step !== false) session.append('step/start', { turn: 1, step: 1 })
  if (options.human !== false) session.append('user/message', createMessage({ role: 'user', content: [{ type: 'text', text: 'Private prompt never exported' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], ...(options.interrupted ? { interrupted: true } : {}), message: createMessage({ role: 'assistant', content: [{ type: 'text', text: options.text ?? 'Private response never exported' }], source: { kind: 'model', provider: options.provider ?? 'deepseek-account', model: 'private/model-name' } }) }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: options.reason ?? { kind: 'completed' } })
}

describe('eligible human response measurement', () => {
  it('counts a completed root response without retaining prompt, answer or model', async () => {
    const { session, handle } = await fixture()
    response(session)
    const state = handle.stateOf(session)
    expect(state.completedTurn).toBe(1)
    expect(state.modality).toBe('verboo_gateway')
    expect(JSON.stringify(state)).not.toMatch(/Private|private\/model/)
  })

  it.each([
    ['automatic', { human: false }], ['empty turn', { step: false }], ['empty answer', { text: '   ' }],
    ['partial', { interrupted: true as const }], ['blocked', { reason: { kind: 'blocked' as const } }],
    ['interrupted', { reason: { kind: 'interrupted' as const } }], ['token ceiling', { reason: { kind: 'max-tokens' as const } }],
  ])('does not activate for %s', async (_label, options) => {
    const { session, handle } = await fixture()
    response(session, options)
    expect(handle.stateOf(session).completedTurn).toBeNull()
  })

  it('excludes subagent output even when its messages are labelled user', async () => {
    const { session, handle } = await fixture(true)
    response(session)
    expect(handle.stateOf(session).completedTurn).toBeNull()
  })

  it('classifies external providers and rebuilds facts after unregistering', async () => {
    const { session, handle } = await fixture()
    response(session, { provider: 'own-provider' })
    const before = handle.stateOf(session)
    expect(before.modality).toBe('external')
    await handle.dispose()
    expect(handle.stateOf(session)).toEqual(before)
  })
})

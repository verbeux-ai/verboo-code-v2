/** Constant-size response facts, reconstructed without replaying analytics effects. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const stateSchema = z.object({
  root: z.boolean(),
  inherited: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative().nullable(),
  startedAt: z.number().nonnegative(),
  human: z.boolean(),
  stepped: z.boolean(),
  response: z.boolean(),
  modality: z.enum(['verboo_gateway', 'external']),
  completedTurn: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative(),
})

/** Private per-session facts; model output never enters persisted analytics state. */
export type ProductResponseState = z.infer<typeof stateSchema>

/** Host-only fold; only live eligible turn/end observations cause delivery. */
export const productResponseProjection: ProjectionDefinition<'verbooProductResponse', ProductResponseState> = {
  key: 'verbooProductResponse',
  stateVersion: 1,
  stateSchema,
  init: (header, inherited) => ({
    root: header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0,
    inherited, turn: null, startedAt: 0, human: false, stepped: false, response: false,
    modality: 'external', completedTurn: null, durationMs: 0,
  }),
  apply: (state, event) => {
    if (!state.root || event.seq < state.inherited) return state
    switch (event.type) {
      case 'turn/start':
        return {
          ...state, turn: event.data.turn, startedAt: event.time,
          human: false, stepped: false, response: false, completedTurn: null,
        }
      case 'user/message':
        return event.data.source.kind === 'user' ? { ...state, human: true } : state
      case 'step/start':
        return event.data.turn === state.turn ? { ...state, stepped: true, response: false } : state
      case 'assistant/message':
        if (event.data.turn !== state.turn) return state
        return { ...state,
          response: event.data.interrupted !== true && event.data.message.content.some(block => block.type === 'text' && block.text.trim().length > 0),
          modality: event.data.message.source.provider === 'deepseek-account' ? 'verboo_gateway' : 'external',
        }
      case 'turn/end': {
        if (event.data.turn !== state.turn) return state
        const eligible = state.human && state.stepped && state.response && event.data.reason.kind === 'completed'
        return { ...state, completedTurn: eligible ? state.turn : null,
          durationMs: Math.min(604800000, Math.max(0, Math.trunc(event.time - state.startedAt))), turn: null }
      }
      default:
        return state
    }
  },
}

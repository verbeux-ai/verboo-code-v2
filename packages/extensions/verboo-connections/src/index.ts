/** Install Verboo connection tools through the supported, awaited Agent lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-verboo-product'
import Schema from '@deepseek-ai/schemastery'
import * as Tools from './tools.ts'
export const name = 'verboo-connections'
export const inject = ['agents', 'verbooProduct']
/** Bounded execution time for a connected service tool and its discovery surface. */
export interface Config {
  /** Maximum duration in milliseconds of one connected service tool execution. */
  timeoutMs: number
  /** Most provider tools one search makes callable. */
  discoveryMaxTools: number
  /** Most connections one search queries. */
  discoveryMaxTargets: number
  /** Largest argument schema, in bytes, declared to the model. */
  discoveryMaxSchemaBytes: number
  /** Longest tool description declared to the model. */
  discoveryMaxDescriptionChars: number
}
export const Config = Schema.object({
  timeoutMs: Schema.number().min(1000).max(120000).default(45000),
  discoveryMaxTools: Schema.number().min(1).max(40).default(12),
  discoveryMaxTargets: Schema.number().min(1).max(24).default(8),
  discoveryMaxSchemaBytes: Schema.number().min(512).max(65536).default(20000),
  discoveryMaxDescriptionChars: Schema.number().min(80).max(2000).default(400),
})
/**
 * Own each tool contribution until its Agent or this extension is disposed.
 * @param ctx - product Host.
 * @param config - validated tool and discovery budgets.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const mounted = new Map<Agent, ReturnType<Context['plugin']>>()
  const lifecycle = { disposed: false }
  const isDisposed = (): boolean => lifecycle.disposed
  const install = async (agent: Agent, signal?: AbortSignal) => {
    if (isDisposed() || signal?.aborted || mounted.has(agent)) return
    const fork = agent.ctx.plugin(Tools, config)
    mounted.set(agent, fork)
    try {
      await fork.await()
      if (isDisposed() || signal?.aborted) {
        mounted.delete(agent)
        await fork.dispose()
      }
    } catch (error) {
      mounted.delete(agent)
      await fork.dispose()
      throw error
    }
  }
  ctx.on('agent/created', async ({ agent, signal }) => {
    await install(agent, signal)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    mounted.delete(agent)
  })
  ctx.effect(
    () => async () => {
      lifecycle.disposed = true
      const forks = [...mounted.values()]
      mounted.clear()
      await Promise.all(forks.map(fork => fork.dispose()))
    },
    'Verboo: Agent tool contributions',
  )
  await Promise.all(ctx.agents.list().map(agent => install(agent)))
}

/** Tools installed in one Agent scope by the product Host extension. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-verboo-product'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Config } from './index.ts'
export const inject = ['tools', 'verbooProduct']
const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [
    {
      type: 'text' as const,
      text: typeof value === 'string' ? value : JSON.stringify(value),
    },
  ],
}
/**
 * Register through the ordinary tool/permission/logging pipeline of each Agent preset.
 * @param ctx - Agent scope.
 * @param config - validated request budget.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(function* () {
    yield ctx.tools.register(
      defineTool({
        name: 'connections_list',
        description:
          'List the current Verboo user’s connected service accounts and their labels. Use only connected accounts. If several accounts match the user’s task, ask which account to use.',
        parameters: {},
        output,
        timeoutMs: config.timeoutMs,
        execute: (_args, exec) =>
          ctx.verbooProduct.listAgentConnections(exec.signal),
      }),
    )
    yield ctx.tools.register(
      defineTool({
        name: 'connections_search',
        description:
          'Find tools and their exact input schemas for one account returned by connections_list. Preserve the returned slug and version for execution.',
        parameters: {
          connectionId: {
            type: 'string',
            required: true,
            description: 'Account ID returned by connections_list.',
          },
          query: {
            type: 'string',
            required: true,
            description: 'The capability to find, up to 200 characters.',
          },
        },
        output,
        timeoutMs: config.timeoutMs,
        execute: (args, exec) =>
          ctx.verbooProduct.searchAgentConnections(
            args.connectionId,
            args.query,
            exec.signal,
          ),
      }),
    )
    yield ctx.tools.register(
      defineTool({
        name: 'connections_execute',
        description:
          'Execute one discovered tool using its exact version and an account explicitly chosen for the user’s task. Follow the user’s instructions and permissions. Never automatically repeat a timed out or unconfirmed action; inspect the service first.',
        parameters: {
          connectionId: { type: 'string', required: true },
          slug: { type: 'string', required: true },
          version: { type: 'string', required: true },
          arguments: {
            type: 'object',
            required: true,
            additionalProperties: true,
          },
        },
        output,
        timeoutMs: config.timeoutMs,
        execute: (args, exec) =>
          ctx.verbooProduct.executeAgentConnection(args, exec.signal),
      }),
    )
  }, 'Verboo: connected service tools')
}

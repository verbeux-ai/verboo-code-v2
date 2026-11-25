/** Tools installed in one Agent scope by the product Host extension. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-verboo-product'
import type {} from '@deepseek-ai/dsh-api-verboo-mcp'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ConnectionToolRegistry, discoverConnectionTools } from './discovery.ts'
import type { DiscoveryBudgets } from './discovery.ts'
import { installMcpTools } from './mcp-tools.ts'
import type { Config } from './index.ts'
export const inject = ['tools', 'verbooProduct', 'verbooMcp']
const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [
    {
      type: 'text' as const,
      text: typeof value === 'string' ? value : JSON.stringify(value),
    },
  ],
}
/** Guidance that makes the discovery step reachable without guessing a tool name. */
const CONNECTIONS_GUIDANCE = [
  'The user has connected services (for example Gmail, GitHub, Slack, Drive, Notion) available through Composio.',
  'When a request needs one of those services, run `connections_search` with the capability in plain words before concluding you cannot do it.',
  'The search registers the matching provider tools for this conversation with their real names and argument schemas; call them on your next step to do the work.',
  'Search again when a task needs a capability you do not have a tool for yet, and prefer one search that names both the read and the write action over two separate searches.',
  'If a search returns no relevant tools, try a different capability description; call only tool names returned by discovery.',
  'Resolve required project, account, and record identifiers from the user or a read tool; never invent identifiers or use placeholder values.',
  'A failed provider action alone does not establish that the connection is unavailable; report the failure and inspect the service before retrying an action that may change data.',
].join(' ')
/**
 * Register through the ordinary tool/permission/logging pipeline of each Agent preset.
 * @param ctx - Agent scope.
 * @param config - validated request and discovery budgets.
 */
export function apply(ctx: Context, config: Config): void {
  const budgets: DiscoveryBudgets = {
    maxTools: config.discoveryMaxTools,
    maxTargets: config.discoveryMaxTargets,
    maxSchemaBytes: config.discoveryMaxSchemaBytes,
    maxDescriptionChars: config.discoveryMaxDescriptionChars,
    timeoutMs: config.timeoutMs,
  }
  // Discovery registers provider tools in this Agent scope, so each conversation
  // owns exactly the tools its own searches added.
  const registry = new ConnectionToolRegistry(ctx, ctx.verbooProduct, budgets)
  ctx.effect(function* () {
    yield ctx.systemPrompt.section({
      name: 'verboo:connections',
      order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS'),
      text: CONNECTIONS_GUIDANCE,
    })
    yield ctx.tools.register(
      defineTool({
        name: 'connections_list',
        description:
          'List the current Verboo user’s connected service accounts and public services that need no credentials. Use only connected accounts or listed public services. If several accounts match the user’s task, ask which account to use.',
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
          'Find the provider tools that perform a task and make them callable in this conversation. Search before any integration work: this is how a service such as Gmail, GitHub or Slack becomes usable. Pass the capability in plain words; omit toolkit and connectionId to search every service the user has, or name one to narrow it. The returned tools are registered immediately with their own names and argument schemas — call them on your next step, in this same request. A service with several accounts needs the user’s choice first.',
        parameters: {
          query: {
            type: 'string',
            required: true,
            description: 'The capability to find, in plain words, up to 200 characters.',
          },
          toolkit: {
            type: 'string',
            description: 'Optional service slug from connections_list, such as "gmail" or "github".',
          },
          connectionId: {
            type: 'string',
            description: 'Optional account or public service ID from connections_list.',
          },
        },
        output,
        timeoutMs: config.timeoutMs,
        execute: async (args, exec) => {
          const query = args.query.trim()
          if (query === '' || query.length > 200) {
            throw new Error('query must contain 1 to 200 characters')
          }
          const outcome = await discoverConnectionTools({
            product: ctx.verbooProduct,
            registry,
            budgets,
            request: {
              query,
              ...args.toolkit === undefined ? {} : { toolkit: args.toolkit },
              ...args.connectionId === undefined ? {} : { connectionId: args.connectionId },
            },
            signal: exec.signal,
          })
          return JSON.stringify(outcome)
        },
      }),
    )
  }, 'Verboo: connected service tools')
  ctx.effect(() => () => { registry.dispose() }, 'Verboo: discovered connection tools')
  installMcpTools(ctx, config.timeoutMs)
}

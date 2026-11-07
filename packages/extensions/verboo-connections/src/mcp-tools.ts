/**
 * Model-facing tools over the account's own MCP servers. `mcp_servers_list`
 * reports what is stored and what blocks each unusable definition;
 * `mcp_server_save` and `mcp_server_remove` change the set. Both writes ask the
 * human first: adding a server introduces code the User cannot read from the
 * transcript, and removing one withdraws tools mid-conversation.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-verboo-mcp'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Output shape shared by the MCP tools: the value is JSON text the pipeline records verbatim. */
const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [
    {
      type: 'text' as const,
      text: typeof value === 'string' ? value : JSON.stringify(value),
    },
  ],
}

/** One entry of `mcp_servers_list`, as the model reads it. */
interface ServerLine {
  name: string
  transport: string
  target: string
  enabled: boolean
  state: string
  toolCount: number
  problem: string
}

/** A refused outcome the model can act on; never a credential or an upstream body. */
function refusal(code: string, message: string): string {
  return JSON.stringify({ ok: false, code, message })
}

/** Read a plain string-to-string map from model-supplied JSON. */
function stringRecord(value: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/** Read a string list from model-supplied JSON. */
function stringList(value: readonly unknown[] | undefined): string[] {
  return (value ?? []).filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Install the MCP server tools in one Agent scope.
 * @param ctx - Agent scope carrying the tool registry and the product service.
 * @param timeoutMs - bound for one registry operation.
 */
export function installMcpTools(ctx: Context, timeoutMs: number): void {
  ctx.effect(function* () {
    yield ctx.tools.register(
      defineTool({
        name: 'mcp_servers_list',
        description:
          'List the user’s own MCP servers, the tools each currently exposes, and what blocks one that cannot connect. Check this before offering to add capabilities: an existing server may already provide them.',
        parameters: {},
        output,
        timeoutMs,
        execute: async () => {
          const servers = await ctx.verbooMcp.summaries()
          const lines: ServerLine[] = servers.map(server => ({
            name: server.name,
            transport: server.transport,
            target: server.target,
            enabled: server.enabled,
            state: server.state,
            toolCount: server.toolCount,
            problem: server.problem,
          }))
          return JSON.stringify({ servers: lines })
        },
      }),
    )
    yield ctx.tools.register(
      defineTool({
        name: 'mcp_server_save',
        description:
          'Create or replace one of the user’s MCP servers, which connects now and stays available in later conversations. Requires the user’s explicit approval: state the exact name, transport and target in the approval reason. Never invent a URL or command — use what the user supplied. Secret values go in `headers` (streamable-http) or `env` (stdio); they are stored on the Host and never returned. Leave a secret value empty to keep the one already stored.',
        parameters: {
          name: {
            type: 'string',
            required: true,
            description:
              'Server name: letters, digits, "-" and "_", at most 32 characters. It prefixes every tool name as mcp__<name>__<tool>.',
          },
          transport: {
            type: 'string',
            required: true,
            enum: ['streamable-http', 'stdio'],
            description: 'streamable-http for a remote endpoint, stdio for a local command.',
          },
          url: {
            type: 'string',
            description: 'Required for streamable-http: the MCP endpoint. https, or http on a loopback host.',
          },
          command: {
            type: 'string',
            description: 'Required for stdio: the executable to run.',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'stdio only: arguments passed to the command, in order.',
          },
          headers: {
            type: 'object',
            additionalProperties: true,
            description:
              'streamable-http only: header names to values. A value is stored as a credential and never shown again.',
          },
          env: {
            type: 'object',
            additionalProperties: true,
            description:
              'stdio only: environment variable names to values. A value is stored as a credential and never shown again.',
          },
          enabled: {
            type: 'boolean',
            description: 'Whether the server should connect now. Defaults to true.',
          },
          justification: {
            type: 'string',
            required: true,
            description:
              'One sentence, in the user’s language, explaining why this server is being added. Shown in the approval prompt.',
          },
        },
        output,
        timeoutMs,
        execute: async (args, exec) => {
          const approval = ctx.get('approval')
          if (approval === undefined || exec.agent === undefined) {
            return refusal(
              'approval_unavailable',
              'This conversation cannot add an MCP server: no approval channel is mounted. Ask the user to add it from Connections.',
            )
          }
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: 'mcp_server_save',
            callId: exec.callId,
            reason: args.justification,
            signal: exec.signal,
          })
          if (outcome !== 'allowed-once') {
            return refusal(
              outcome === 'rejected' ? 'not_approved' : outcome,
              'The user did not approve this server. Do not retry; ask what they want changed, or suggest adding it from Connections.',
            )
          }
          const result = await ctx.verbooMcp.saveFromClient({
            name: args.name,
            transport: args.transport === 'stdio' ? 'stdio' : 'streamable-http',
            url: args.url ?? '',
            headers: stringRecord(args.headers),
            command: args.command ?? '',
            args: stringList(args.args),
            env: stringRecord(args.env),
            enabled: args.enabled ?? true,
          })
          if (!result.ok) return refusal(result.code, result.message)
          return JSON.stringify({
            ok: true,
            server: {
              name: result.data.name,
              state: result.data.status.state,
              toolCount: result.data.status.toolCount,
              missing: result.data.status.missing,
              problem: result.data.status.lastError,
            },
            note:
              'Run mcp_servers_list to confirm the tools this server exposes before relying on them.',
          })
        },
      }),
    )
    yield ctx.tools.register(
      defineTool({
        name: 'mcp_server_remove',
        description:
          'Remove one of the user’s MCP servers and withdraw its tools. Requires the user’s explicit approval. Use only when the user asked to remove it.',
        parameters: {
          name: {
            type: 'string',
            required: true,
            description: 'Server name exactly as mcp_servers_list reports it.',
          },
          justification: {
            type: 'string',
            required: true,
            description:
              'One sentence, in the user’s language, explaining why this server is being removed.',
          },
        },
        output,
        timeoutMs,
        execute: async (args, exec) => {
          const approval = ctx.get('approval')
          if (approval === undefined || exec.agent === undefined) {
            return refusal(
              'approval_unavailable',
              'This conversation cannot remove an MCP server: no approval channel is mounted. Ask the user to remove it from Connections.',
            )
          }
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: 'mcp_server_remove',
            callId: exec.callId,
            reason: args.justification,
            signal: exec.signal,
          })
          if (outcome !== 'allowed-once') {
            return refusal(
              outcome === 'rejected' ? 'not_approved' : outcome,
              'The user did not approve this removal.',
            )
          }
          const result = await ctx.verbooMcp.removeFromClient(args.name)
          return result.ok
            ? JSON.stringify({ ok: true, removed: args.name })
            : refusal(result.code, result.message)
        },
      }),
    )
  }, 'Verboo: MCP server tools')
}

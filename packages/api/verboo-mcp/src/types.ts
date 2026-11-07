/**
 * Display-safe projections of a user-defined MCP server. Definitions carry
 * header and environment keys plus credential references; secret values never
 * leave the Host credential store.
 *
 * @module @deepseek-ai/dsh-api-verboo-mcp/types
 */

/** Which transport a user-defined MCP server speaks. */
export type McpTransport = 'stdio' | 'streamable-http'
/** One user definition of an MCP server the user owns, as the product stores it. */
export interface CustomMcpServer {
  /** Server key; also the tool namespace prefix in the Agent's tool registry. */
  name: string
  transport: McpTransport
  /** streamable-http endpoint; empty for a stdio server. */
  url: string
  /** Header names in definition order; values live only in the credential store. */
  headerNames: string[]
  /** stdio executable; empty for a streamable-http server. */
  command: string
  /** stdio arguments, in order; values may hold `${credential:REF}` templates. */
  args: string[]
  /** stdio environment keys; values live only in the credential store. */
  envNames: string[]
  /** Whether the user asked for a live connection. */
  enabled: boolean
  /** Credential references this definition needs stored before it can connect. */
  credentialRefs: string[]
  /** ISO instant the definition was created. */
  createdAt: string
  /** ISO instant of the last edit. */
  updatedAt: string
}
/** One definition the user is editing; secret values are written separately. */
export interface McpServerInput {
  name: string
  transport: McpTransport
  url: string
  /** Non-empty values are stored as credentials and replaced by their reference. */
  headers: Record<string, string>
  command: string
  args: string[]
  /** Non-empty values are stored as credentials and replaced by their reference. */
  env: Record<string, string>
  enabled: boolean
}
/** Live connection state of one user-defined MCP server, flattened for display. */
export interface CustomMcpStatus {
  state:
    | 'connected'
    | 'connecting'
    | 'reconnecting'
    | 'waiting-credentials'
    | 'disabled'
    | 'failed'
    | 'unknown'
  /** Registered tools in the live generation; `0` when none is registered. */
  toolCount: number
  /** Most recent diagnostic; empty when the connection is healthy. */
  lastError: string
  /** Credential references still unconfigured; empty when every value is stored. */
  missing: string[]
}
/** One user-defined MCP server with its live state. */
export interface CustomMcpServerView extends CustomMcpServer {
  status: CustomMcpStatus
}
/** Outcome of testing a definition without saving it. */
export interface McpServerProbe {
  ok: boolean
  /** Stage that failed, or `null` when the probe succeeded. */
  stage: 'connect' | 'list' | null
  /** Diagnostic text, or `null` when the probe succeeded. */
  message: string | null
  /** Server-reported identity from `initialize`, when advertised. */
  serverName: string | null
  serverVersion: string | null
  /** Advertised raw tool names, capped by the probe. */
  toolNames: string[]
  /** Whether the advertised list was longer than `toolNames`. */
  truncated: boolean
  durationMs: number
}

/** Fixed failure categories an MCP definition operation reports. */
export type McpError =
  | 'invalid_input'
  | 'name_taken'
  | 'not_found'
  | 'unavailable'
  | 'contract_error'

/** An MCP definition outcome that never carries a secret value. */
export type McpResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: McpError; message: string }

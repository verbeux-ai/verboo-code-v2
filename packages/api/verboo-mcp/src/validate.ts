/**
 * Write-time validation for a user-defined MCP server. A definition the MCP
 * manager could not mount is refused where it is submitted, naming the field,
 * so the store never holds an entry that fails at connect time.
 *
 * @module
 */
import { Buffer } from 'node:buffer'
import { assertTemplateSyntax } from '@deepseek-ai/dsh-mcp-client'
import { MCP_SERVER_NAME, referencedCredentials, splitSecrets } from './store.ts'
import type { McpError, McpServerInput, McpTransport } from './types.ts'

/** Bounds a submitted definition cannot exceed. */
export const MAX_ARGS = 64
/** Longest accepted argument or template string. */
export const MAX_ARG_BYTES = 8192
/** Bounds one definition's header and environment maps. */
export const MAX_SETTINGS = 32

/** Longest accepted server name. */
const MAX_NAME = 32

/** Header and environment key charset a transport accepts. */
const SETTING_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** Loopback hosts where cleartext HTTP is legitimate for a local MCP server. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

/** A refused definition, carrying the wire failure category and an actionable message. */
export class DefinitionError extends Error {
  /**
   * @param code - wire failure category.
   * @param message - actionable text naming the offending field.
   */
  constructor(
    readonly code: Extract<McpError, 'invalid_input' | 'name_taken' | 'not_found' | 'unavailable'>,
    message: string,
  ) {
    super(message)
  }
}

/** One normalized definition ready to store. */
export interface NormalizedDefinition {
  /** Server key. */
  name: string
  /** Selected transport. */
  transport: McpTransport
  /** streamable-http endpoint, or `''`. */
  url: string
  /** stdio executable, or `''`. */
  command: string
  /** stdio arguments. */
  args: string[]
  /** Header key to credential template. */
  headers: Record<string, string>
  /** Environment key to credential template. */
  env: Record<string, string>
  /** Whether a live connection is requested. */
  enabled: boolean
  /** Plaintext secret values to write to the credential store. */
  secrets: Array<{ ref: string; value: string }>
  /** Every reference this definition needs stored. */
  credentialRefs: string[]
}

function fail(message: string): never {
  throw new DefinitionError('invalid_input', message)
}

function checkName(name: string): string {
  if (!MCP_SERVER_NAME.test(name)) {
    fail(
      `name must match ${String(MCP_SERVER_NAME)} (letters, digits, "-" and "_", at most ${String(MAX_NAME)} characters); "${name}" is not accepted`,
    )
  }
  return name
}

function checkSettings(
  values: Readonly<Record<string, string>>,
  field: 'headers' | 'env',
): void {
  const keys = Object.keys(values)
  if (keys.length > MAX_SETTINGS) {
    fail(`${field}: at most ${String(MAX_SETTINGS)} entries are accepted, got ${String(keys.length)}`)
  }
  for (const key of keys) {
    if (!SETTING_KEY.test(key)) {
      fail(`${field}: "${key}" is not a valid key (letters, digits, "_", ".", "-")`)
    }
  }
}

function checkArgs(args: readonly string[]): void {
  if (args.length > MAX_ARGS) {
    fail(`args: at most ${String(MAX_ARGS)} entries are accepted, got ${String(args.length)}`)
  }
  args.forEach((arg, index) => {
    if (Buffer.byteLength(arg, 'utf8') > MAX_ARG_BYTES) {
      fail(`args[${String(index)}]: longer than ${String(MAX_ARG_BYTES)} bytes`)
    }
    try {
      assertTemplateSyntax(arg, `args[${String(index)}]`)
    } catch (error: unknown) {
      /* v8 ignore next -- assertTemplateSyntax always throws Error */
      fail(error instanceof Error ? error.message : 'args: malformed credential template')
    }
  })
}

/** Reject a malformed `${credential:REF}` occurrence where the value is submitted. */
function checkTemplates(values: Readonly<Record<string, string>>, field: 'headers' | 'env'): void {
  for (const [key, value] of Object.entries(values)) {
    try {
      assertTemplateSyntax(value, `${field}.${key}`)
    } catch (error: unknown) {
      /* v8 ignore next -- assertTemplateSyntax always throws Error */
      fail(error instanceof Error ? error.message : `${field}.${key}: malformed credential template`)
    }
  }
}

/** Reject an endpoint that is not https, or cleartext HTTP on a loopback host. */
function checkEndpoint(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    fail(`url: "${url}" is not an absolute URL`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    fail('url: credentials in the URL are not accepted — use a header instead')
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname))) {
    fail(
      'url: use https:// for a remote server, or http:// with a loopback host (127.0.0.1, ::1, localhost) for a local one',
    )
  }
  return parsed.href
}

/**
 * Validate one submitted definition and split its secret values from the
 * templates the store keeps.
 * @param input - definition as submitted by a management surface or an Agent tool.
 * @returns the normalized definition, its templates, and the secrets to store.
 * @throws {DefinitionError} when a field is missing, malformed, or belongs to the other transport.
 */
export function normalizeDefinition(input: McpServerInput): NormalizedDefinition {
  const name = checkName(input.name.trim())
  // The wire type admits exactly these two transports; the runtime boundary is
  // the tool/Remote JSON schema, which rejects anything else before here.
  const transport: McpTransport = input.transport
  const args = input.args.map(arg => arg.trim()).filter(arg => arg !== '')
  const url = input.url.trim()
  const command = input.command.trim()
  checkArgs(args)

  if (transport === 'stdio') {
    if (command === '') fail('command: a stdio server requires the executable to run')
    if (url !== '') fail('url: a stdio server takes no endpoint — switch the transport to streamable-http')
    if (Object.keys(input.headers).length > 0) {
      fail('headers: a stdio server takes no headers — pass secrets as environment values')
    }
    checkSettings(input.env, 'env')
    checkTemplates(input.env, 'env')
    const { templates, secrets } = splitSecrets(name, input.env)
    return {
      name,
      transport,
      url: '',
      command,
      args,
      headers: {},
      env: templates,
      enabled: input.enabled,
      secrets,
      credentialRefs: referencedCredentials(Object.values(templates).join(' ')),
    }
  }

  if (url === '') fail('url: a streamable-http server requires its endpoint')
  if (command !== '') fail('command: a streamable-http server takes no executable — switch the transport to stdio')
  if (args.length > 0) fail('args: a streamable-http server takes no arguments — switch the transport to stdio')
  if (Object.keys(input.env).length > 0) {
    fail('env: a streamable-http server takes no environment — pass secrets as headers')
  }
  checkSettings(input.headers, 'headers')
  checkTemplates(input.headers, 'headers')
  const endpoint = checkEndpoint(url)
  const { templates, secrets } = splitSecrets(name, input.headers)
  return {
    name,
    transport,
    url: endpoint,
    command: '',
    args: [],
    headers: templates,
    env: {},
    enabled: input.enabled,
    secrets,
    credentialRefs: referencedCredentials(Object.values(templates).join(' ')),
  }
}

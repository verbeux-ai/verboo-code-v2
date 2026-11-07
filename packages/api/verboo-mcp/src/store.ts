/**
 * Durable user-defined MCP server definitions and the credential-reference
 * naming that keeps their secret values out of the stored record. A definition
 * holds header and environment keys plus `${credential:REF}` templates; the
 * values themselves live only in the credential store, so a stored record is
 * safe to show in a management surface.
 *
 * @module
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Server key: the MCP manager's own `serverName` pattern, which also names the tool namespace. */
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Charset the credential seam accepts for a reference name. */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Header and environment key as a transport accepts it. */
const SETTING_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** One definition as stored: keys and templates only, never a secret value. */
export const mcpServerSchema = z
  .object({
    name: z.string().regex(MCP_SERVER_NAME),
    transport: z.enum(['stdio', 'streamable-http']),
    url: z.string().default(''),
    /** Header key to `${credential:REF}` template, in definition order. */
    headers: z.record(z.string().regex(SETTING_KEY), z.string()).default({}),
    command: z.string().default(''),
    args: z.array(z.string()).default([]),
    /** Environment key to `${credential:REF}` template. */
    env: z.record(z.string().regex(SETTING_KEY), z.string()).default({}),
    enabled: z.boolean().default(true),
    /** Every reference this definition resolves before connecting, in definition order. */
    credentialRefs: z.array(z.string().regex(CREDENTIAL_REF)).default([]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()

/** One stored definition. */
export type StoredMcpServer = z.infer<typeof mcpServerSchema>

/** Durable definitions keyed by server name; one record per definition. */
export const mcpServerDomain = defineDomain({
  name: 'verboo_mcp_servers',
  version: 1,
  layout: 'per-record',
  tables: { servers: domainTable<string, StoredMcpServer>(mcpServerSchema) },
})

/**
 * Build the credential reference one header or environment value is stored
 * under. The server name and key are folded into a stable, readable
 * reference so a later edit replaces the same secret instead of orphaning it.
 * @param server - owning server name.
 * @param key - header or environment key.
 * @returns the reference name the credential seam accepts.
 */
export function mcpCredentialRef(server: string, key: string): string {
  const fold = (value: string): string => value.replaceAll(/[^A-Za-z0-9_]/g, '_').toUpperCase()
  return `VERBOO_MCP_${fold(server)}_${fold(key)}`
}

/**
 * Render one setting value as the template a stored definition keeps.
 * @param server - owning server name.
 * @param key - header or environment key.
 * @returns the `${credential:REF}` template naming that setting.
 */
export function mcpCredentialTemplate(server: string, key: string): string {
  return `\${credential:${mcpCredentialRef(server, key)}}`
}

/**
 * Read every credential reference one template string names.
 * @param value - stored template or plain string.
 * @returns referenced names in template order.
 */
export function referencedCredentials(value: string): string[] {
  return [...value.matchAll(/\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
    token => token[1] as string,
  )
}

/**
 * Split one definition's transport strings into the templates it stores and
 * the plaintext secrets the caller supplied for them. A value that is already
 * one complete `${credential:REF}` token is kept as written; an empty value
 * keeps the reference a previous save established, because a management
 * surface shows only keys and a blank field means "leave it as it is".
 * @param server - owning server name for reference naming.
 * @param values - submitted header or environment values.
 * @returns the templates to store and the secrets to write to the credential store.
 */
export function splitSecrets(
  server: string,
  values: Readonly<Record<string, string>>,
): {
  templates: Record<string, string>
  secrets: Array<{ ref: string; value: string }>
} {
  const templates: Record<string, string> = {}
  const secrets: Array<{ ref: string; value: string }> = []
  for (const [key, raw] of Object.entries(values)) {
    const value = raw.trim()
    const named = referencedCredentials(value)
    const isWholeTemplate = named.length === 1 && value === `\${credential:${named[0] as string}}`
    if (isWholeTemplate || value === '') {
      templates[key] = isWholeTemplate ? value : mcpCredentialTemplate(server, key)
      continue
    }
    const ref = mcpCredentialRef(server, key)
    templates[key] = `\${credential:${ref}}`
    secrets.push({ ref, value })
  }
  return { templates, secrets }
}

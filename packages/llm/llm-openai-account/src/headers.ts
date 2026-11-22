/** Case-insensitive header access shared by the usage and limit readers. */

/**
 * Read one header case-insensitively from an already-collected record.
 * @param headers - collected response headers, when the caller observed them.
 * @param name - lower-case header name.
 * @returns the value as sent, or undefined when absent.
 */
export function headerOf(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

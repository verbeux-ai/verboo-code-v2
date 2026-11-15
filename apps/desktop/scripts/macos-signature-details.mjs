/** Validate public Apple signature metadata without importing packaging dependencies. */

/**
 * Reject signature metadata that does not name the company release authority and team.
 * @param {string} details - Output from `codesign --display --verbose=4`.
 * @param {{ signingIdentity: string, teamId: string }} expected - Public release identity.
 * @returns {void}
 */
export function assertMacOSSignatureDetails(details, expected) {
  const fields = new Set(details.split(/\r?\n/u).map(line => line.trim()))
  const expectedAuthority = `Authority=Developer ID Application: ${expected.signingIdentity}`
  const expectedTeam = `TeamIdentifier=${expected.teamId}`
  const missing = [expectedAuthority, expectedTeam].filter(field => !fields.has(field))
  if (missing.length > 0) {
    throw new Error(`desktop macOS signing: signature does not match the release identity; missing ${missing.join(', ')}`)
  }
}

/**
 * Require the signature properties Apple validates for executable runtime content.
 * @param {string} details - Output from `codesign --display --verbose=4`.
 * @param {{ signingIdentity: string, teamId: string }} expected - Public release identity.
 * @returns {void}
 */
export function assertMacOSRuntimeSignatureDetails(details, expected) {
  assertMacOSSignatureDetails(details, expected)
  const fields = details.split(/\r?\n/u).map(line => line.trim())
  if (!fields.some(line => /^Timestamp=.+/u.test(line))) {
    throw new Error('desktop macOS signing: runtime signature has no secure timestamp')
  }
  if (!fields.some(line => /\bflags=0x[0-9a-f]+\(runtime\)(?:\s|$)/iu.test(line))) {
    throw new Error('desktop macOS signing: runtime signature does not enable hardened runtime')
  }
}

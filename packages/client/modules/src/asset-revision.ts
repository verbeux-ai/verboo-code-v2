/**
 * Content revision of a built package asset. This is the one part of the asset
 * format that needs a Node digest, so it lives apart from the browser-safe
 * media table and reference builders the web bundle also imports.
 * @module @deepseek-ai/dsh-client-modules/src/asset-revision
 */

import { createHash } from 'node:crypto'

/** Hex digits kept from the content digest; the same length as client artifact revisions. */
export const PACKAGE_ASSET_REVISION_LENGTH = 12

/**
 * Compute the content revision of one built asset. The build writes it into
 * the emitted file name, so a URL names exactly one content and a rebuilt
 * asset gets a new URL.
 * @param bytes - exact bytes written under `lib/assets/`.
 * @returns the first 12 hexadecimal digits of the SHA-1 digest.
 */
export function packageAssetRevision(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, PACKAGE_ASSET_REVISION_LENGTH)
}

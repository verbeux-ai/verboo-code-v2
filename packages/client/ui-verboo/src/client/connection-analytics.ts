/** Observe a recovered Host connection without collecting endpoint or error details. */
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { FeatureConsent } from './feature-consent.ts'

/**
 * Capture an established connection's loss and report only if it later recovers.
 * @param capture - authorization available when the established connection was lost.
 * @param report - nonblocking sink invoked after a later connection succeeds.
 * @returns observer for connection state changes; unobserved or unfinished outages are excluded.
 */
export function createConnectionAnalytics(
  capture: () => FeatureConsent | undefined,
  report: (consent: FeatureConsent) => void,
): (state: ConnectionState | undefined) => void {
  let previous: ConnectionState | undefined
  let outage: FeatureConsent | undefined
  let established = false
  let disconnected = false
  return (state) => {
    if (state === previous) return
    if (established && state === 'disconnected' && !disconnected) {
      outage = capture()
      disconnected = true
    }
    if (state === 'connected') {
      if (outage) report(outage)
      outage = undefined
      disconnected = false
      established = true
    }
    previous = state
  }
}

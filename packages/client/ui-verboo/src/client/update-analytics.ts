/** Observes native updater phases without collecting version targets or errors. */
import type { ProductFeature } from '@deepseek-ai/dsh-host-verboo-analytics/types'
import type { FeatureConsent } from './feature-consent.ts'
import type { DesktopUpdateState } from './update-source.ts'

type UpdateFeature = Extract<ProductFeature, 'desktop_update_download' | 'desktop_update_install' | 'desktop_update_error'>
type UpdateOutcome = 'started' | 'completed' | 'failed'

/**
 * Report observed transitions once per phase change, capturing authorization at the start.
 * @param capture - evidence available at the time of observation.
 * @param report - nonblocking product observation sink.
 * @returns a phase observer; restarting the app does not imply an update succeeded.
 */
export function createUpdateAnalytics(
  capture: () => FeatureConsent | undefined,
  report: (feature: UpdateFeature, outcome: UpdateOutcome, consent: FeatureConsent) => void,
): (state: DesktopUpdateState) => void {
  let previous: DesktopUpdateState['phase'] = 'idle'
  let active: { feature: 'desktop_update_download' | 'desktop_update_install'; consent: FeatureConsent | undefined } | undefined
  return ({ phase }) => {
    if (phase === previous) return
    previous = phase
    if (phase === 'downloading' || phase === 'installing') {
      const consent = capture()
      active = {
        feature: phase === 'downloading' ? 'desktop_update_download' : 'desktop_update_install', consent,
      }
      if (consent) report(active.feature, 'started', consent)
    } else if (phase === 'ready') {
      if (active?.feature === 'desktop_update_download' && active.consent) report(active.feature, 'completed', active.consent)
      active = undefined
    } else if (phase === 'error') {
      if (active?.consent) report(active.feature, 'failed', active.consent)
      else if (!active) {
        const consent = capture()
        if (consent) report('desktop_update_error', 'failed', consent)
      }
      active = undefined
    } else {
      active = undefined
    }
  }
}

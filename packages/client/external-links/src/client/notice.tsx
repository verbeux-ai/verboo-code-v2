/** Refusal notice for a destination the service could not open. */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { NS } from './locales.ts'
import type { ExternalLinkFailure } from './links.ts'

/** One published refusal; `seq` keys the banner so a repeat restarts it. */
export interface ExternalLinkNoticeState {
  /** Why the destination never opened. */
  readonly failure: ExternalLinkFailure
  /** Publish counter for the banner's lifetime. */
  readonly seq: number
}

/** The observable notice the overlay entry reads, and its dismissal. */
export interface ExternalLinkNoticeSource {
  /** Current refusal, or null while none shows. */
  readonly hooks: { readonly notice: HostObservable<ExternalLinkNoticeState | null> }
  /** Clear the shown refusal. */
  readonly dismiss: () => void
}

/** What this entry's inject face supplies: the notice source and its dismissal. */
export type ExternalLinkNoticeInjected = ExternalLinkNoticeSource

/** Props of the `shell.overlay` entry: the notice, its dismissal, and localized copy. */
export type ExternalLinkNoticeProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<ExternalLinkNoticeInjected>

/**
 * Show the current refusal as a dismissible banner.
 * @param props - the notice hook, its dismissal, and the locale seat.
 * @returns the banner on display, or null.
 */
export function ExternalLinkNotice({ useNotice, dismiss, t }: ExternalLinkNoticeProps): ReactNode {
  const notice = useNotice(current => current)
  if (notice === null) return null
  return (
    <Toast
      key={`external-link-${String(notice.seq)}`}
      text={t(notice.failure)}
      icon={<IconWarningOutlineRegular />}
      onDone={dismiss}
    />
  )
}

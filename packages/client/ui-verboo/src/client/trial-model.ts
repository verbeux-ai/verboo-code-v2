/** Account-scoped trial presentation and durable, non-financial purchase recovery. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  PlanId,
  TrialId,
  TrialOfferId,
  TrialAttemptId,
  Result,
  TrialNotice,
  TrialStatus,
  TrialOffer,
  TrialPayment,
} from '@deepseek-ai/dsh-api-verboo-product/types'
import type { ProductSnapshot } from './model.ts'

/** Window-owned presentation; a pending handoff never grants commercial access. */
export interface TrialSnapshot {
  notices: TrialNotice[]
  allNotices?: TrialNotice[]
  paidGroupIds?: PlanId[]
  open: boolean
  loading: boolean
  stale: boolean
  offer: TrialOffer | null
  quoting: boolean
  paying: boolean
  error: 'quote' | 'payment' | 'unconfirmed' | 'navigation' | null
  payment: TrialPayment | null
}
/** Account-bound commerce adapter; external navigation remains a separate, non-financial step. */
export interface TrialApi {
  status(this: void, signal: AbortSignal): Promise<Result<TrialStatus>>
  offer(
    this: void,
    trial: TrialId,
    plan: PlanId,
    method?: 'card' | 'pix',
  ): Promise<Result<TrialOffer>>
  confirm(
    this: void,
    offer: TrialOfferId,
    method: 'card' | 'pix',
    requestId: TrialAttemptId,
  ): Promise<Result<TrialPayment>>
  payment(this: void, attempt: TrialAttemptId): Promise<Result<{ status: string }>>
  resume(
    this: void,
    attempt: TrialAttemptId,
    trial?: TrialId,
  ): Promise<Result<TrialPayment>>
  open(this: void, url: string): Promise<void>
  refreshPlans(this: void): void
}
const empty = (): TrialSnapshot => ({
  notices: [],
  open: false,
  loading: false,
  stale: false,
  offer: null,
  quoting: false,
  paying: false,
  error: null,
  payment: null,
})
type Recovery = {
  requestId: TrialAttemptId
  planId: PlanId
  attemptId: TrialAttemptId | null
  setup?: boolean
}

/** One presenter per app window; closing a modal never persists a dismissal across launches. */
export class TrialModel {
  /** Observable presentation consumed through the framework trial hook. */
  readonly state = createSnapshotStore<TrialSnapshot>(empty())
  private owner: string | null = null
  private selectedGroup: PlanId | null = null
  private latest: TrialStatus | null = null
  private accountRevision: string | null = null
  private generation = 0
  private quoteGeneration = 0
  private readonly shown = new Set<string>()
  private pending: Promise<void> | undefined
  private abort: AbortController | undefined
  private recovery: Recovery | null = null
  constructor(
    private readonly api: TrialApi,
    private readonly account: ObservableSnapshot<ProductSnapshot>,
    private readonly storage?: Pick<
      Storage,
      'getItem' | 'setItem' | 'removeItem'
    >,
  ) {}
  private patch(value: Partial<TrialSnapshot>): void {
    this.state.set({ ...this.state.getSnapshot(), ...value })
  }
  private key(): string {
    return 'verboo-trial-purchase:' + (this.owner ?? 'signed-out')
  }
  private save(): boolean {
    if (!this.storage) return false
    try {
      if (this.recovery)
        this.storage.setItem(this.key(), JSON.stringify(this.recovery))
      else this.storage.removeItem(this.key())
      return true
    } catch {
      return false
    }
  }
  /** Fence every outstanding read and quote when the authenticated profile changes. */
  adopt(): void {
    const account = this.account.getSnapshot()
    const owner =
      account.view?.status === 'credential-stored'
        ? (account.profile?.id ?? null)
        : null
    const revision = account.view?.credentialRevision ?? null
    if (owner === this.owner && revision === this.accountRevision) return
    const ownerChanged = owner !== this.owner
    const wasOpen = !ownerChanged && this.state.getSnapshot().open
    this.accountRevision = revision
    this.abort?.abort()
    this.generation++
    this.quoteGeneration++
    this.owner = owner
    this.pending = undefined
    this.recovery = null
    this.latest = null
    this.selectedGroup = null
    if (ownerChanged) this.shown.clear()
    this.state.set({ ...empty(), open: wasOpen })
    if (!owner) return
    try {
      const saved: unknown = JSON.parse(
        this.storage?.getItem(this.key()) ?? 'null',
      )
      if (
        saved &&
        typeof saved === 'object' &&
        'requestId' in saved &&
        typeof saved.requestId === 'string' &&
        /^[0-9a-f-]{36}$/i.test(saved.requestId) &&
        'planId' in saved &&
        typeof saved.planId === 'string' &&
        'attemptId' in saved &&
        (saved.attemptId === null || typeof saved.attemptId === 'string')
      )
        this.recovery = saved as Recovery
      if (this.recovery?.setup)
        this.patch({
          payment: { status: 'setup_required', attemptId: null, url: null },
        })
      else if (this.recovery?.attemptId)
        this.patch({
          payment: {
            status: 'pending',
            attemptId: this.recovery.attemptId,
            url: null,
          },
        })
      else if (this.recovery) this.patch({ error: 'unconfirmed' })
    } catch {
      /* Storage is optional for reading; never invent a successful payment. */
    }
  }
  /** One visible-window read at a time; stale data is retained and cannot authorize payment. */
  refresh(): Promise<void> {
    this.adopt()
    if (!this.owner) return Promise.resolve()
    if (this.pending) return this.pending
    const generation = this.generation
    const abort = new AbortController()
    this.abort = abort
    const owned = () => generation === this.generation && !abort.signal.aborted
    this.patch({ loading: true })
    this.pending = (async () => {
      try {
        const result = await this.api.status(abort.signal)
        if (!owned()) return
        if (!result.ok) {
          this.patch({ stale: true })
          return
        }
        this.latest = result.data
        const notices = this.relevant(result.data)
        const ended = notices.find(
          notice => notice.state === 'ended' && !this.shown.has(notice.id),
        )
        if (ended) this.shown.add(ended.id)
        this.patch({
          notices,
          allNotices: result.data.trials,
          paidGroupIds: result.data.paidGroupIds ?? [],
          stale: false,
          ...(ended ? { open: true } : {}),
          ...(notices.length === 0 ? { open: false, offer: null } : {}),
        })
        if (
          this.recovery &&
          !this.state.getSnapshot().paying &&
          this.state.getSnapshot().payment?.status !== 'setup_required'
        ) {
          const attemptId = this.recovery.attemptId ?? this.recovery.requestId
          const result = await this.api.payment(attemptId)
          if (!owned()) return
          if (
            result.ok &&
            ['pending', 'requires_action'].includes(result.data.status)
          ) {
            this.recovery.attemptId = attemptId
            this.save()
            this.patch({
              payment: this.state.getSnapshot().payment ?? {
                status: 'pending',
                attemptId,
                url: null,
              },
            })
          }
          if (
            result.ok &&
            ['failed', 'expired', 'abandoned', 'canceled'].includes(
              result.data.status,
            )
          ) {
            this.recovery = null
            this.save()
            this.patch({ offer: null, payment: null, error: 'payment' })
          }
          if (result.ok && result.data.status === 'succeeded') {
            this.recovery = null
            this.save()
            this.patch({
              open: false,
              offer: null,
              payment: { status: 'completed', attemptId: null, url: null },
              error: null,
            })
            this.api.refreshPlans()
          }
        }
        const current = this.state.getSnapshot()
        if (
          current.offer &&
          Date.parse(current.offer.expiresAt) <= Date.now() &&
          !current.paying &&
          current.payment === null
        )
          this.patch({ offer: null, error: 'quote' })
        if (
          this.recovery &&
          current.payment?.status === 'setup_required' &&
          current.notices[0]
        ) {
          const quote = await this.api.offer(
            current.notices[0].id,
            this.recovery.planId,
            'card',
          )
          if (!owned()) return
          if (quote.ok && quote.data.card !== null) {
            this.recovery = null
            this.save()
            this.patch({ offer: quote.data, payment: null, error: null })
          }
        }
      } catch {
        if (generation === this.generation && !abort.signal.aborted)
          this.patch({ stale: true })
      } finally {
        if (generation === this.generation) {
          this.pending = undefined
          this.patch({ loading: false })
        }
      }
    })()
    return this.pending
  }
  private relevant(status: TrialStatus): TrialNotice[] {
    if (this.selectedGroup !== null) {
      if (status.paidGroupIds?.includes(this.selectedGroup)) return []
      return status.trials.filter(
        notice => notice.groupId === this.selectedGroup,
      )
    }
    return status.paidGroupIds?.length ? [] : status.trials
  }
  /**
   * Select the composer's server-routed group; unrelated paid access does not borrow trial state.
   * @param group - focused group, or null when no accepted model resolves to a group.
   */
  selectGroup(group: PlanId | null): void {
    if (group === this.selectedGroup) return
    this.selectedGroup = group
    this.quoteGeneration++
    if (!this.latest) return
    const notices = this.relevant(this.latest)
    const ended = notices.find(
      notice => notice.state === 'ended' && !this.shown.has(notice.id),
    )
    if (ended) this.shown.add(ended.id)
    this.patch({
      notices,
      offer: null,
      ...(ended ? { open: true } : {}),
      ...(notices.length === 0 ? { open: false } : {}),
    })
  }
  /** Pause an in-flight read when the app is hidden or offline. */
  pause(): void {
    this.abort?.abort()
    if (this.owner) this.patch({ stale: true })
  }
  /** Explicitly reopen the offer without changing dismissal state or access. */
  show(): void {
    this.patch({ open: true })
  }
  /** Keep browsing available; no dismissal is stored across application launches. */
  close(): void {
    this.patch({ open: false })
  }
  /**
   * Select a current quote, discarding late replies from earlier plan selections.
   * @param planId - selected eligible catalog plan.
   * @param method - selected payment method; absent selects card.
   */
  async quote(planId: PlanId, method: 'card' | 'pix' = 'card'): Promise<void> {
    const notice = this.state.getSnapshot().notices[0]
    if (
      !notice ||
      this.state.getSnapshot().paying ||
      this.recovery?.attemptId ||
      this.state.getSnapshot().error === 'unconfirmed'
    )
      return
    const generation = this.generation
    const quoteGeneration = ++this.quoteGeneration
    this.patch({ offer: null, quoting: true, error: null })
    try {
      const result = await this.api.offer(notice.id, planId, method)
      if (
        generation !== this.generation ||
        quoteGeneration !== this.quoteGeneration
      )
        return
      if (result.ok) {
        this.patch({ offer: result.data })
        if (result.data.pending) {
          this.recovery = {
            requestId: randomUUID() as TrialAttemptId,
            planId,
            attemptId: result.data.pending.attemptId,
          }
          this.save()
          this.patch({ payment: result.data.pending })
        }
      } else this.patch({ error: 'quote' })
    } catch {
      if (
        generation === this.generation &&
        quoteGeneration === this.quoteGeneration
      )
        this.patch({ error: 'quote' })
    } finally {
      if (
        generation === this.generation &&
        quoteGeneration === this.quoteGeneration
      )
        this.patch({ quoting: false })
    }
  }
  /**
   * Save the original request before sending a payment; never retry automatically.
   * @param method - method displayed by the current, unexpired offer.
   */
  async confirm(method: 'card' | 'pix'): Promise<void> {
    const state = this.state.getSnapshot()
    if (!state.offer || state.paying || state.stale || state.error === 'unconfirmed' || this.recovery?.attemptId)
      return
    if (Date.parse(state.offer.expiresAt) <= Date.now()) {
      this.patch({ offer: null, error: 'quote' })
      return
    }
    const generation = this.generation
    if (this.recovery && this.recovery.planId !== state.offer.planId) {
      this.patch({ error: 'unconfirmed' })
      return
    }
    this.recovery ??= {
      requestId: randomUUID() as TrialAttemptId,
      planId: state.offer.planId,
      attemptId: state.offer.card ? (state.offer.attemptId ?? null) : null,
    }
    // A financial write is not safe if its recovery identity cannot survive a restart.
    if (!this.save()) {
      this.patch({ error: 'unconfirmed' })
      return
    }
    const recovery = this.recovery
    this.patch({ paying: true, error: null })
    try {
      const result = await this.api.confirm(
        state.offer.id,
        method,
        recovery.requestId,
      )
      if (generation !== this.generation) return
      if (!result.ok) {
        if (result.code === 'quote_changed') {
          this.recovery = null
          this.save()
          this.patch({ offer: null, payment: null, error: 'quote' })
        } else this.patch({ error: 'unconfirmed' })
        return
      }
      if (this.recovery !== recovery) return
      if (result.data.status === 'reconfirm') {
        this.recovery = null
        this.save()
        this.selectGroup(state.offer.planId)
        this.patch({ offer: null, payment: null, paying: false })
        this.api.refreshPlans()
        await this.refresh()
        await this.quote(state.offer.planId)
        return
      }
      this.recovery.attemptId = result.data.attemptId
      this.recovery.setup = result.data.status === 'setup_required'
      this.save()
      this.patch({ payment: result.data })
      if (result.data.status === 'completed') {
        this.recovery = null
        this.save()
        this.patch({ open: false, offer: null, error: null })
        this.api.refreshPlans()
      }
      if (result.data.url) {
        try {
          await this.api.open(result.data.url)
        } catch {
          if (generation === this.generation)
            this.patch({ error: 'navigation' })
        }
      }
      if (generation === this.generation) await this.refresh()
    } catch {
      if (generation === this.generation) this.patch({ error: 'unconfirmed' })
    } finally {
      if (generation === this.generation) this.patch({ paying: false })
    }
  }
  /** Reopen the original provider destination; never creates a second payment. */
  async reopen(): Promise<void> {
    const generation = this.generation
    const payment = this.state.getSnapshot().payment
    if (!payment) return
    try {
      let url = payment.url
      if (!url && payment.attemptId) {
        const result = await this.api.resume(
          payment.attemptId,
          this.state.getSnapshot().notices[0]?.id,
        )
        if (generation !== this.generation) return
        if (!result.ok) {
          this.patch({ error: 'unconfirmed' })
          return
        }
        url = result.data.url
        this.patch({ payment: result.data })
        if (result.data.status === 'completed') {
          this.recovery = null
          this.save()
          this.patch({ open: false, offer: null, error: null })
          this.api.refreshPlans()
          await this.refresh()
        }
      }
      if (url && generation === this.generation) await this.api.open(url)
    } catch {
      if (generation === this.generation) this.patch({ error: 'navigation' })
    }
  }
  /** Stop reads and invalidate late responses when the owning window closes. */
  dispose(): void {
    this.abort?.abort()
    this.generation++
    this.quoteGeneration++
  }
}

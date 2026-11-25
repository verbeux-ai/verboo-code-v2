/** Conservative process-exit admission shared by desktop work producers. */
export type ExitActivity = 'idle' | 'busy' | 'unknown'
/** Reservation outcome for a process-exit attempt. */
export type ExitReservation = { readonly kind: 'reserved'; readonly id: number } | { readonly kind: 'busy' | 'unknown' }

type Lease = { readonly id: number; readonly revision: number; readonly expiresAt: number; committed: boolean }

/** Protocol lease bound; expired native requests never leave the Host frozen. */
const LEASE_MS = 10_000

/** Atomically reserve a silent exit only while every required provider proves idle. */
export class ExitAdmission {
  private readonly required = new Map<string, () => ExitActivity>()
  private readonly optional = new Map<symbol, () => ExitActivity>()
  private revision = 0
  private pending = 0
  private nextId = 0
  private lease: Lease | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private final = false
  private readonly reopenListeners = new Set<() => void>()

  /** Whether a committed lease currently blocks new work. */
  get isFrozen(): boolean {
    this.expire()
    return this.final || this.lease?.committed === true
  }

  /** Subscribe to release of a committed lease.
   * @param listener - Called synchronously when admissions reopen.
   * @returns A disposer for this listener.
   */
  onReopen(listener: () => void): () => void {
    this.reopenListeners.add(listener)
    return () => { this.reopenListeners.delete(listener) }
  }

  private notifyReopen(): void {
    for (const listener of this.reopenListeners) {
      try { listener() } catch { /* One consumer must not prevent the others from resuming. */ }
    }
  }

  /** Register the unique provider for one required activity family.
   * @param name - Required activity family.
   * @param read - Synchronous conservative activity observation.
   * @returns A disposer for this exact provider.
   */
  registerRequired(name: 'agents' | 'jobs' | 'schedule', read: () => ExitActivity): () => void {
    this.assertAdmission()
    if (this.required.has(name)) throw new Error(`exit admission: duplicate ${name} provider`)
    this.required.set(name, read)
    return () => { if (this.required.get(name) === read) { this.required.delete(name); this.invalidate() } }
  }

  /** Register one scoped provider, such as a persistent terminal registry.
   * @param read - Synchronous conservative activity observation.
   * @returns A disposer for this provider.
   */
  registerOptional(read: () => ExitActivity): () => void {
    this.assertAdmission()
    const id = Symbol('exit provider')
    this.optional.set(id, read)
    return () => { if (this.optional.delete(id)) this.invalidate() }
  }

  /** Reject work after commit; work admitted during a reservation invalidates that reservation. */
  assertAdmission(): void {
    this.expire()
    if (this.final || this.lease?.committed === true) throw new Error('exit admission: application is shutting down')
    this.invalidate()
  }

  /** Track an asynchronous admission until it either commits or fails.
   * @returns An idempotent release function.
   */
  begin(): () => void {
    this.assertAdmission()
    this.pending += 1
    let active = true
    return () => { if (active) { active = false; this.pending -= 1; this.invalidate() } }
  }

  /** Reserve an idle observation; newly admitted work invalidates it.
   * @returns The reservation or the reason silent exit is unavailable.
   */
  tryReserve(): ExitReservation {
    this.expire()
    if (this.final || this.lease !== undefined) return { kind: 'unknown' }
    const status = this.read()
    if (status !== 'idle') return { kind: status }
    const id = ++this.nextId
    this.lease = { id, revision: this.revision, expiresAt: performance.now() + LEASE_MS, committed: false }
    this.timer = setTimeout(() => { this.cancel(id) }, LEASE_MS)
    return { kind: 'reserved', id }
  }

  /** Freeze new admissions only when the reservation remains current and idle.
   * @param id - Reservation identity.
   * @returns Whether admissions were frozen.
   */
  commit(id: number): boolean {
    this.expire()
    const lease = this.lease
    if (lease === undefined || lease.id !== id || lease.committed || lease.revision !== this.revision || this.read() !== 'idle') return false
    lease.committed = true
    return true
  }

  /** Release a matching reservation or unfinalized commit; stale requests do nothing.
   * @param id - Reservation identity.
   */
  cancel(id: number): void {
    if (this.lease?.id !== id) return
    const wasCommitted = this.lease.committed
    this.lease = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (wasCommitted && !this.final) this.notifyReopen()
  }

  /** Make a committed lease final and synchronously start the Host shutdown.
   * @param id - Committed reservation identity.
   * @param shutdown - Synchronously begin Host teardown.
   * @returns Whether teardown started successfully.
   */
  finalize(id: number, shutdown: () => void): boolean {
    this.expire()
    const lease = this.lease
    if (lease?.id !== id || !lease.committed) return false
    if (lease.revision !== this.revision || this.read() !== 'idle') { this.cancel(id); return false }
    this.final = true
    this.cancel(id)
    try { shutdown(); return true } catch { this.final = false; this.notifyReopen(); return false }
  }

  private read(): ExitActivity {
    if (this.pending > 0) return 'busy'
    if (!['agents', 'jobs', 'schedule'].every(name => this.required.has(name))) return 'unknown'
    const revision = this.revision
    let unknown = false
    try {
      for (const read of [...this.required.values(), ...this.optional.values()]) {
        const status = read()
        if (status === 'busy') return 'busy'
        if (status !== 'idle') unknown = true
      }
    } catch { return 'unknown' }
    return unknown || revision !== this.revision || this.pending > 0 ? 'unknown' : 'idle'
  }

  private invalidate(): void {
    this.revision += 1
    if (this.lease !== undefined && !this.lease.committed) this.cancel(this.lease.id)
  }

  private expire(): void {
    if (this.lease !== undefined && performance.now() >= this.lease.expiresAt) this.cancel(this.lease.id)
  }
}

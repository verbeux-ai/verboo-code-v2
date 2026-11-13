/**
 * Which catalog models this account may actually use.
 *
 * The installed catalog lists models the Codex wire protocol knows, not the ones
 * a given subscription serves: two of its entries answer "not supported when
 * using Codex with a ChatGPT account" for a plan that serves the rest. Offering
 * them costs the reader a failed request and an untranslated provider sentence,
 * so a model is only offered once the provider has accepted it.
 *
 * Discovery is bounded by the account it was made for and by a deadline, and it
 * remembers refusals as well as acceptances: a refusal costs one probe, not one
 * per menu open.
 *
 * @module @deepseek-ai/dsh-llm-openai-account/availability
 */

/** Provider wording that identifies a model this account may not use. */
const UNSUPPORTED_WORDING = /not supported when using Codex with a ChatGPT account/i

/** How long one account's discovery result stays authoritative. */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

/** What one model's probe concluded. */
export type ModelVerdict = 'supported' | 'unsupported' | 'unknown'

/** One account's remembered verdicts, keyed by model id. */
export interface AvailabilityEntry {
  /** Verdict per model id, absent when never probed. */
  readonly verdicts: ReadonlyMap<string, ModelVerdict>
  /** Epoch milliseconds after which the entry is stale. */
  readonly expiresAt: number
}

/**
 * Whether one provider failure says this account may not use the model.
 *
 * The wording is the provider's own and stable across the plans observed so
 * far; a failure that says anything else is left `unknown` so a transient error
 * never removes a model from the menu.
 * @param failure - provider text from a refused call.
 * @returns true only for a refusal that names the account as the reason.
 */
export function isUnsupportedModel(failure: string): boolean {
  return UNSUPPORTED_WORDING.test(failure)
}

/**
 * Decide which models to offer from the verdicts recorded so far.
 *
 * A model nobody probed stays offered: absence of evidence is not a refusal, and
 * hiding an unprobed model would drop the whole catalog before the first turn.
 * @param models - catalog model ids, in catalog order.
 * @param entry - remembered verdicts for this account, when any.
 * @returns the offered ids, with refused ones removed.
 */
export function offeredModels(models: readonly string[], entry: AvailabilityEntry | undefined): readonly string[] {
  if (entry === undefined) return models
  return models.filter(model => entry.verdicts.get(model) !== 'unsupported')
}

/**
 * Hold one account's discovery result and its lifetime.
 *
 * The key is the account identifier, so a second sign-in cannot inherit the
 * previous account's refusals.
 */
export class ModelAvailability {
  private entry: AvailabilityEntry | undefined
  private account: string | undefined
  private readonly ttlMs: number
  private readonly now: () => number

  /**
   * @param ttlMs - how long one result stays authoritative.
   * @param now - clock, injected so a test can advance it.
   */
  constructor(ttlMs: number = DEFAULT_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs
    this.now = now
  }

  /**
   * Read the verdicts for one account, discarding another account's.
   * @param account - identifier of the signed-in account, or undefined when signed out.
   * @returns the live entry, or undefined when none applies.
   */
  read(account: string | undefined): AvailabilityEntry | undefined {
    if (account === undefined || this.account !== account) return undefined
    if (this.entry !== undefined && this.entry.expiresAt <= this.now()) return undefined
    return this.entry
  }

  /**
   * Record one model's verdict for one account.
   * @param account - identifier of the signed-in account.
   * @param model - catalog model id.
   * @param verdict - what the probe concluded.
   */
  record(account: string, model: string, verdict: ModelVerdict): void {
    if (verdict === 'unknown') return
    const verdicts = this.account === account && this.entry !== undefined
      ? new Map(this.entry.verdicts)
      : new Map<string, ModelVerdict>()
    verdicts.set(model, verdict)
    this.account = account
    this.entry = { verdicts, expiresAt: this.now() + this.ttlMs }
  }

  /** Forget every verdict, as a new sign-in must. */
  clear(): void {
    this.entry = undefined
    this.account = undefined
  }
}

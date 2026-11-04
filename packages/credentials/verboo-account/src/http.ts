/** Bounded Verboo requests with fixed diagnostics and immutable operation identity. */
import { randomUUID } from 'node:crypto'
import type { Deployment } from './config.ts'

/** Sanitized HTTP or OAuth failure; server response text is never retained. */
export class AccountRequestError extends Error {
  /**
 * @param code - fixed failure classification.
 * @param status - optional HTTP response status.
 */
  constructor(
    readonly code:
      | 'network_error'
      | 'request_timeout'
      | 'request_cancelled'
      | 'contract_error'
      | 'authentication_invalid'
      | 'authorization_denied'
      | 'unknown',
    readonly status?: number,
  ) {
    super(`Verboo Code: ${code}`)
  }
}

/** Per-operation identity shared by retries and server observations. */
export interface Operation {
  journeyId: string
  operationId: string
  requestId: string
}

/**
 * Mint the internal correlation identity at operation start.
 * @returns opaque identifiers, unrelated to credentials or provider payment IDs.
 */
export function operation(): Operation {
  return {
    journeyId: randomUUID(),
    operationId: randomUUID(),
    requestId: randomUUID(),
  }
}

/**
 * Safe operational fallback, never an advertising event or proof of commercial access.
 * @param context - operation identity captured before I/O.
 * @param stage - supported Revenue Journey stage.
 * @param outcome - observed request or UI outcome.
 * @param error - optional sanitized request failure.
 */
export function observe(
  context: Operation,
  stage: 'login' | 'catalog',
  outcome: 'started' | 'succeeded' | 'failed',
  error?: AccountRequestError,
): void {
  console.error(
    '[verboo-journey]',
    JSON.stringify({
      schemaVersion: 2,
      ...context,
      stage,
      outcome,
      ...(error === undefined
        ? {}
        : { errorCode: error.code, httpStatus: error.status }),
    }),
  )
}

/** HTTP client that never follows credential-bearing redirects or generically retries writes. */
export class VerbooHttp {
  /**
 * @param deployment - validated account deployment and request deadline.
 */
  constructor(private readonly deployment: Deployment) {}

  /**
   * Execute a request, retrying only safe reads within the 35-second total budget.
   * @param url - endpoint constructed by this account's owning service.
   * @param init - request body, authentication and cancellation captured by the caller.
   * @param context - immutable identity retained across attempts.
   * @param emptyResponse - accept a successful response without a JSON body.
   * @returns parsed JSON, or null for a successful empty response.
   */
  async request(
    url: string,
    init: RequestInit = {},
    context: Operation = operation(),
    emptyResponse = false,
  ): Promise<unknown> {
    const safe =
      init.method === undefined || ['GET', 'HEAD'].includes(init.method)
    const budget = AbortSignal.timeout(35_000)
    const headers = new Headers(init.headers)
    headers.set('X-Verboo-Journey-Id', context.journeyId)
    headers.set('X-Verboo-Operation-Id', context.operationId)
    headers.set('X-Request-Id', context.requestId)
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.any([
        ...(init.signal === undefined || init.signal === null
          ? []
          : [init.signal]),
        budget,
        AbortSignal.timeout(this.deployment.requestTimeoutMs),
      ])
      let response: Response
      try {
        response = await fetch(url, {
          ...init,
          headers,
          signal,
          redirect: 'error',
        })
      } catch {
        const error = new AccountRequestError(
          init.signal?.aborted
            ? 'request_cancelled'
            : signal.aborted
              ? 'request_timeout'
              : 'network_error',
        )
        if (!safe || attempt === 2 || init.signal?.aborted || budget.aborted)
          throw error
        continue
      }
      if (
        safe &&
        attempt < 2 &&
        [408, 429, 500, 502, 503, 504].includes(response.status)
      ) {
        const retry = response.headers.get('retry-after')
        const delay =
          retry === null
            ? 0
            : /^\d+$/.test(retry)
              ? Number(retry) * 1000
              : Math.max(0, Date.parse(retry) - Date.now())
        await response.body?.cancel()
        if (delay > 0)
          await new Promise<void>((resolve, reject) => {
            const waitSignal = AbortSignal.any([
              budget,
              ...(init.signal ? [init.signal] : []),
            ])
            const timer = setTimeout(done, delay)
            const aborted = () => {
              clearTimeout(timer)
              waitSignal.removeEventListener('abort', aborted)
              reject(new AccountRequestError('request_cancelled'))
            }
            function done() {
              waitSignal.removeEventListener('abort', aborted)
              resolve()
            }
            if (waitSignal.aborted) aborted()
            else waitSignal.addEventListener('abort', aborted, { once: true })
          })
        if (budget.aborted) throw new AccountRequestError('request_timeout')
        continue
      }
      if (!response.ok) {
        const status = response.status
        let rejectedGrant = false
        if (
          status === 400 &&
          url === `${this.deployment.apiOrigin}/oauth/token`
        ) {
          let body: unknown
          try {
            body = await response.json()
          } catch (_error: unknown) {
            /* An invalid error body is an unknown technical failure. */
          }
          rejectedGrant =
            typeof body === 'object' &&
            body !== null &&
            'error' in body &&
            body.error === 'invalid_grant'
        } else await response.body?.cancel()
        throw new AccountRequestError(
          status === 401 || rejectedGrant
            ? 'authentication_invalid'
            : status === 403
              ? 'authorization_denied'
              : 'unknown',
          status,
        )
      }
      if (response.status === 204 || emptyResponse) {
        await response.body?.cancel()
        return null
      }
      try {
        return await response.json()
      } catch {
        throw new AccountRequestError('contract_error', response.status)
      }
    }
  }
}

/**
 * One account HTTP operation: the deadline it runs under, the abort it
 * observes, and the failure classification its caller receives.
 *
 * Every request carries a timeout because the endpoints answer an interactive
 * login, and a hung request would strand the browser attempt. Failures become
 * the fixed codes in `types.ts` rather than provider text, so no response body
 * or token can reach a log or a rendered message.
 *
 * @module @deepseek-ai/dsh-openai-account/http
 */

import type { OpenAiAccountErrorCode } from './types.ts'

/** One account request failure, carrying a fixed code and never the provider's text. */
export class AccountRequestError extends Error {
  /**
   * @param code - fixed classification the caller acts on.
   * @param options - optional underlying cause, kept off the message.
   */
  constructor(readonly code: OpenAiAccountErrorCode, options?: { cause?: unknown }) {
    super(`[OI] account: ${code}`, options)
    this.name = 'AccountRequestError'
  }
}

/** One request's timing facts, collected so a failure can be classified without the response. */
export interface Operation {
  /** Abort signal that cancels the request when the caller gives up. */
  readonly signal: AbortSignal
}

/**
 * Build the operation a single request runs under.
 * @param signal - caller's cancellation signal.
 * @returns the operation passed to the HTTP helper.
 */
export function operation(signal: AbortSignal): Operation {
  return { signal }
}

/** One JSON response and the status that carried it. */
export interface JsonResponse {
  /** HTTP status code. */
  readonly status: number
  /** Parsed body, or `undefined` when the body was empty or not JSON. */
  readonly body: unknown
}

/**
 * JSON-over-HTTP client for the account endpoints.
 *
 * A response with a body is parsed when it is JSON; a body that is not JSON is
 * reported as `invalid_response` rather than silently dropped, because the
 * token exchange depends on reading it.
 */
export class AccountHttp {
  private readonly timeoutMs: number

  /**
   * @param timeoutMs - deadline applied to every request.
   */
  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs
  }

  /**
   * Send one request and parse its JSON body.
   * @param url - absolute endpoint.
   * @param init - method, headers, and body.
   * @param operation - caller's cancellation and the request deadline.
   * @returns the status and parsed body.
   * @throws AccountRequestError when the request never produced a response, timed out, was cancelled, or answered with unparseable JSON.
   */
  async json(url: string, init: RequestInit, operation: Operation): Promise<JsonResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = AbortSignal.any([operation.signal, timeout])
    let response: Response
    try {
      response = await fetch(url, { ...init, signal, redirect: 'error' })
    } catch (cause) {
      if (operation.signal.aborted) throw new AccountRequestError('request_cancelled', { cause })
      if (timeout.aborted) throw new AccountRequestError('request_timeout', { cause })
      throw new AccountRequestError('network_error', { cause })
    }
    const text = await response.text()
    if (text.trim().length === 0) return { status: response.status, body: undefined }
    try {
      return { status: response.status, body: JSON.parse(text) as unknown }
    } catch (cause) {
      throw new AccountRequestError('invalid_response', { cause })
    }
  }
}

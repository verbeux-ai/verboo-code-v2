/**
 * Client-safe account surface: the signed-in state, the fixed failure codes,
 * and the Cordis events this plugin emits. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-openai-account/types
 */

import type {} from '@deepseek-ai/cordis'

/**
 * Fixed failure classification for an [OI] account operation. Each code names
 * what the caller can do next, and no code carries provider text, tokens, or
 * response bodies.
 *
 * - `network_error`: the request never produced a response.
 * - `request_timeout`: the request or the browser attempt exceeded its deadline.
 * - `request_cancelled`: the caller's signal aborted the operation.
 * - `invalid_response`: the provider answered with fields this client cannot use.
 * - `session_expired`: the provider rejected the stored grant; the local session was cleared.
 * - `revoked`: the provider reported the stored grant as revoked; the local session was cleared.
 * - `sign_in_required`: an operation needed a session while none is stored.
 * - `web_server_unavailable`: no loopback listener exists to receive the browser callback.
 * - `credential_store_unavailable`: the operating-system credential store could not be used.
 */
export type OpenAiAccountErrorCode =
  | 'network_error'
  | 'request_timeout'
  | 'request_cancelled'
  | 'invalid_response'
  | 'session_expired'
  | 'revoked'
  | 'sign_in_required'
  | 'web_server_unavailable'
  | 'credential_store_unavailable'

/**
 * Stored-session snapshot safe for a client. Presence is a claim about local
 * storage, not that the provider currently accepts the stored token.
 */
export interface OpenAiAccountStatus {
  /** Whether a session is stored for this installation. */
  readonly signedIn: boolean
  /** ChatGPT plan named by the stored ID token, such as `team`; absent when unknown. */
  readonly planType?: string
  /** ChatGPT account identifier from the stored ID token; absent when unknown. */
  readonly accountId?: string
  /** End of the paid subscription window from the stored ID token, as an ISO-8601 instant. */
  readonly activeUntil?: string
}

/** What a started sign-in tells the dialog. */
export interface SignInStart {
  /** Authorization URL to open in the browser. */
  readonly url: string
  /** Opaque handle the completion call must present with the code. */
  readonly handle: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The stored session was removed locally, whether by sign-out or by a rejected refresh grant.
     * @mode emit
     */
    'openai-account/signed-out'(): void
    /**
     * A provider call needs the user to sign in again; emitted once per cleared session.
     * @mode emit
     */
    'openai-account/sign-in-required'(): void
  }
}

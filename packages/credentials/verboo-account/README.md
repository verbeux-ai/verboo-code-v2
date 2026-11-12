---
description: "Sign in to Verboo with OAuth PKCE and use the models authorized for that account. Refresh grants remain encrypted in Host storage; the encryption key stays in the operating system credential store."
kind: "package-reference"
---

# @deepseek-ai/dsh-verboo-account

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Sign in to Verboo with OAuth PKCE and use the models authorized for that account. Refresh grants remain encrypted in Host storage; the encryption key stays in the operating system credential store.

<a id="table-of-contents"></a>
## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The `verboo` profile supplies the public API origin, router URL and OAuth client ID. [Config](src/config.ts) defines deployment settings. The production client uses `https://code.verboo.ai`, its `/router/v1` gateway and the registered public `verboo-code-cli` client. Loopback HTTP requires an explicit development setting. Each inference request sends a generated `X-Request-Id` and logs that id with its route; malformed tool-call diagnostics log only their category and available provider response id. The account route rejects malformed calls before dispatch and retries one malformed model request by default; `malformedResponseRetries: 0` disables that additional request.

When an inference request returns HTTP 401, the account route forces one refresh for the exact token used by the request and replays the request once if the login still matches. A repeated 401 is returned without another refresh. HTTP 403 is reported as an access denial and does not refresh or remove the login. Refresh timeouts and network failures preserve the stored grant and stop the model request without automatic replay.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

Account grants are encrypted before persistence and never returned over Remote. The public credential revision identifies the login and remains stable through token refresh, retaining the verified profile and Client state. A replacement login or rejected grant invalidates that identity; late profile responses never cross logins. Refresh and logout capture the owning installation session. Model discovery preserves exact server IDs and delegates inference to the existing pi-ai adapter. New native login observations use Revenue Journey v1; queued observations retain their original version and bytes until an exact persistence receipt arrives.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Architecture](../../../docs/architecture.md) — shared Cordis engine.
- [Desktop runtime](../../../apps/desktop/tauri/README.md) — development and builds.

<a id="model-experience"></a>
## Model Experience

### Product integration

#### What the model sees

The selected `deepseek-account` model receives the existing conversation and tool request through pi-ai; authentication adds no prompt section.

#### Token effect

Authentication and local response validation add no input tokens. A malformed response retried through the agent loop sends the model request again and may consume additional input and output tokens; direct LLM streams remain single-attempt. Model choice determines the provider tokenizer and context limits.

#### KV Cache effect

Stable tools and prompt prefixes remain unchanged; user submissions and tool results append to the existing Session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The operating system credential store must be available. Revocation failures are reported without restoring the local grant; the server session remains unconfirmed until the revocation succeeds.

<a id="dev-note"></a>
### Dev Note

None.

---
description: "The [OI] subscription provider route: ChatGPT models over the Codex responses protocol, subscription limit classification, and the usage reading the Host serves."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-openai-account

English | [中文](README.zh.md)

## Summary

Register the `openai-account` route on `ctx.llm`, serving the GPT models a ChatGPT plan includes. The plugin composes over the [pi-ai adapter](../llm-pi-ai/README.md): the installed `openai-codex` catalog supplies the endpoint, the `openai-codex-responses` wire protocol, and the model list, so this package owns only the route label, the per-request account token, the classification of a subscription refusal, and the usage reading. A stored [OI] account session comes from the optional `ctx.openaiAccount` service; without it the route serves no model instead of failing to boot.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin beside the account plugin that owns the login, and keep `openai-account` out of every configuration that has no [OI] account. The route is always registered; it lists no model and fails every request with `ACCOUNT_SIGN_IN_REQUIRED` while no session is stored, so a composition that mounts it signed-out shows an empty catalog rather than a broken one.

```yaml
- id: llm-openai-account
  name: '@deepseek-ai/dsh-llm-openai-account'
  config:
    usageTimeoutMs: 10000
```

| Field | Default | Meaning |
|---|---|---|
| `usageTimeoutMs` | `10,000` | Deadline of one usage read; a read that exceeds it yields no reading |

The route sends `POST https://chatgpt.com/backend-api/codex/responses` with `Authorization: Bearer <access token>` and `chatgpt-account-id`, which the transport derives from the token's `https://api.openai.com/auth` claim. Every request also carries the harness attribution headers. No token, account identifier, or request text reaches a log, an error message, or a Session event.

### Subscription limits

A refusal reaches the harness under one of three codes, and the code decides what the retry policy and the human do next:

| Evidence | Code | Retryable | Remedy |
|---|---|---|---|
| `x-codex-rate-limit-reached-type` naming `workspace_owner_usage_limit_reached` or `workspace_member_usage_limit_reached` | `QUOTA` | no | wait for the window to reset |
| A credits-depleted reason (`workspace_member_credits_depleted`), `x-codex-credits-has-credits: false`, or wording that names depleted credits | `ACCOUNT_QUOTA` | no | replenish the credits |
| A 429 whose rendered text names the usage limit and the reset time | `QUOTA` | no | wait for the window to reset |
| A 429 that names no terminal reason | `RATE_LIMIT` | yes, under the default policy | retry |

`QUOTA` and `ACCOUNT_QUOTA` are the codes `dsh-llm` already defines; `RATE_LIMIT` is the default retryable set's transient class. A terminal refusal is therefore never replayed, and a caller that switches to another provider on a terminal refusal needs no channel of its own.

### Usage reading

`usage(signal)` is the plugin's Remote method, exposed at endpoint `llmOpenaiAccount/usage` (the Cordis service key and wire namespace are both `llmOpenaiAccount`). It returns `{ usedPercent, windowSeconds, resetAfterSeconds, credits?, unlimited, planType?, activeUntil?, reachedType?, additionalLimits?, asOf }`, or `undefined` when no reading was obtained. `undefined` is the only failure signal: the method never throws, so a client draws nothing instead of a zeroed meter. `unlimited` is true only for an explicit `x-codex-credits-unlimited: true`; an absent header is not evidence either way and leaves it false.

<a id="understand-the-implementation"></a>
## Understand the implementation

The adapter builds one pi-ai adapter instance over a profile keyed `openai-codex`, which is the installed catalog provider for the Codex responses protocol, and registers itself — not that instance — as the owner of `openai-account`. Every call translates the route key, resolves the account access token once per request, and forwards the stream unchanged. Terminal failures are rewritten on the way out: an `error` finish reason and a thrown `LlmError` both pass through the same classifier, so a refusal is classified identically whichever way the transport delivered it.

The pi-ai collection requires a credential store and an ambient auth context; both are supplied as empty, because this route always passes the account token as the request's own key and the account plugin is the single owner of the session. The profile names a credential reference so pi-ai honours that request-level token instead of its own OAuth store, and nothing is ever read from the environment for it.

The usage read goes to `GET https://chatgpt.com/backend-api/codex/usage` with the same credential and a deadline. Its document and headers are both read: the window fields come from the document (nested `rate_limit` or a flattened spelling), while the credit and active-limit facts come from headers, which describe the limit currently governing requests. A non-success status still contributes its headers, so a client can show the refusal state.

<a id="further-exploration"></a>
## Further Exploration

[LLM streaming](../../../docs/subsystems/llm-streaming.md) · [pi-ai adapter](../llm-pi-ai/README.md) · [Request retry](../llm-retry/README.md)

<a id="model-experience"></a>
## Model Experience

None, as this route adds no model-visible text of its own and the shared pi-ai transport serializes every request.

#### KV Cache effect

Nothing here changes the request prefix: the plugin adds no prompt section, tool, or message, and the token and account headers are transport metadata the provider does not count as cacheable input. A switch between ChatGPT models starts a new prefix because the provider keys its cache per model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Codex transport collapses every 429 into its own sentence and drops the response headers, so the credits-versus-window distinction is only visible on the model path when the provider text preserves it. The authoritative reading is the usage endpoint, which carries both the headers and the structure.
- The route lists the whole installed Codex catalog; a plan that excludes a model learns so from the provider's refusal, not from the catalog.
- The usage reading is not cached. Each call performs one request, so a client that polls pays one request per poll.
- The reading has no streaming form; a client observes a new reading only by asking again.
- The package ships an English README only; the Chinese counterpart follows the routine translation pass.

<a id="dev-note"></a>
### Dev Note

The protocol implementation, transcript projection, replay state, and stream vocabulary stay in `dsh-llm-pi-ai`; this package adds classification and a credential bridge, which is why it can be tested without a network by driving the shared runtime through a fetch double.

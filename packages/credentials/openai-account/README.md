---
description: "[OI] ChatGPT account login, encrypted grant storage, and the subscription plan facts a sign-in already carries."
---

# [DSH] [OI] Account

English | [中文](README.zh.md)

## Summary

Owns one [OI] ChatGPT subscription login: the browser authorization-code flow with PKCE, the encrypted grant whose key lives in the operating system's credential store, the refresh rotation behind it, and the plan facts the ID token already names.

## Table of Contents

- [Why this package exists](#why-this-package-exists)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="why-this-package-exists"></a>

## Why this package exists

A reader who already pays for a ChatGPT plan should be able to use those models without paying again per token. The subscription has no public API, so the login mirrors the flow the Codex client performs: an authorization code with PKCE, a rotating refresh grant, and an ID token that states the plan and the end of its paid window. Keeping that flow behind one package means the rest of the product depends on a token and a few plan facts, not on how they were obtained.

<a id="use-this-package"></a>

## Use this package

```yaml
- id: openai-account
  name: '@deepseek-ai/dsh-openai-account'
- id: openai-account-login
  name: '@deepseek-ai/dsh-openai-account/remote'
```

`ctx.openaiAccount` is the service; the `openaiAccountLogin` Remote surface is what a sign-in dialog addresses. Both stay dormant until a session is stored, so a build without a sign-in behaves exactly as before.

<a id="understand-the-implementation"></a>

## Understand the implementation

`begin()` builds the authorization URL and returns the PKCE verifier the callback must present. `complete(code)` exchanges it and persists the grant before returning, because the exchange rotates the refresh token: a crash between the two would otherwise store a token the provider has already spent. `accessToken()` renews an expired token and reports `undefined` when no session exists, which is the only claim this package makes about being signed in — it never asserts that the provider currently accepts the stored token.

A rejected refresh clears the session, since the stored grant can no longer produce a token. A network failure keeps it: only the provider can say a grant is dead. The grant is sealed with AES-256-GCM under a key held by the operating system's credential store, bound as associated data to the token endpoint, and written with an owner-only mode. No token and no provider response body reaches a log or an error message.

Plan facts come from the ID token payload: `chatgpt_plan_type`, `chatgpt_account_id`, and `chatgpt_subscription_active_until`. A payload this build cannot decode reports no facts rather than failing a login that otherwise succeeded, because the plan is display data while the tokens are what the route needs.

<a id="dev-note"></a>

## Dev Note

The grant vault mirrors the Verboo account's: authenticated encryption with the key in the credential store, issuer binding, and no plaintext on disk.


<a id="model-experience"></a>

## Model Experience

None, as this package produces no model-visible text and instead stores a credential and reports plan facts to the surfaces that show them.

#### KV Cache effect

None. This package adds no prefix to any request and changes no message content, so it does not affect the cacheable prefix the route sends.


## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The endpoints and client identity mirror the Codex client rather than a published API. A provider change breaks the login without notice, which is why the flow lives alone in this package.
- The callback is not served locally: the dialog asks for the code the provider's page leaves in the address bar. A listener would need a port this build does not open.
- One session per installation. Multiple accounts would need a record per identity, which no current consumer asks for.

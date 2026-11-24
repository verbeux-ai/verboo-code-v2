# Agent Note: Dynamic connection tools from a capability search

Status: implemented

English | [中文](2026-11-24-dynamic-connection-tools.zh.md)

## Problem

A connected service such as Gmail exposes hundreds of provider actions whose argument schemas change with every provider release. Declaring all of them up front would spend the request budget on definitions the conversation never calls, and a hand-written tool per provider action cannot keep up with the catalog.

The previous arrangement hid that cost behind one generic `connections_execute` tool taking a `connectionId`, `slug`, `version` and a free-form `arguments` object. The model could run an action but never saw the action's real schema, so it had to guess field names and read a refusal to learn them. Nothing tied a discovered definition to the call that used it, and the model could pass any account to any slug.

## Decision

`connections_search` is the discovery step. It reads the account's connections, asks the provider for the tools that match a capability, and registers each match in the calling Agent's own tool registry as `connection__<toolkit>__<slug>`. The model then calls that tool directly on its next step, in the same request.

Registration is a normal `ctx.tools.register()` contribution in the Agent scope. The next prompt assembly therefore declares the new tools, the loop records the addition as a `tool-registry` developer message, and the model sees a real name, description and argument schema instead of an opaque execute call. Disposal rides the Agent scope, so a later conversation starts with only the base tools.

The provider schema is projected onto the enforced tool-schema subset before registration. Unsupported keywords, malformed nodes and `required` keys that the property map does not declare are dropped rather than forwarded, because a forwarded schema would let an upstream provider change how the harness validates arguments. A projection larger than `discoveryMaxSchemaBytes` keeps an open argument schema: the tool stays callable and the model learns the fields from the provider's own refusal, which is still better than dropping the action.

Each registered tool closes over the connection and version its own search resolved, so a later search cannot redirect an earlier call to another account. A name already serving a different account is never reused: the second account's copy gains a hash suffix. Repeating a search for the same account and slug with a newer provider version replaces the registration instead of duplicating it.

Account choice stays explicit. A toolkit with several connected accounts is reported as ambiguous with the account labels, and the Agent asks the user which one to use before searching again with that `connectionId`. Searching every service by default is deliberate: the user's request rarely names a toolkit, and a capability query is a better filter than a guess.

A prompt section states that connected services exist and that `connections_search` is how to reach them, because a tool the model never considers is indistinguishable from one that is absent.

## Alternatives considered

**Keep one generic execute tool and add a separate describe tool.** Two round trips before any work, and the model still has to copy a slug, version and connection into a second call, which is exactly the pairing that produced wrong-account calls.

**Declare every provider action up front.** The catalog is large, most actions are irrelevant to a conversation, and a definition the request never calls still costs declaration tokens on every step.

**Register discovered tools globally instead of per Agent.** A global registration would leak one conversation's discovery into every other conversation and make disposal ambiguous; the Agent scope already owns per-conversation tools.

**Forward the provider schema unchanged.** The harness only enforces its documented subset. Forwarding keywords it ignores would present a constraint that is never checked, and a `required` key outside `properties` would make every call fail validation.

**Let the model pick an account implicitly by picking the first match.** Silently choosing between two personal and work accounts of the same service risks acting on the wrong mailbox.

## Consequences

An integration task now costs one search step before the action, and the discovered declarations stay in the conversation, so a long session accumulates the tools it actually used instead of a fixed catalog. `connections_execute` is gone; the tool name disappears from the product surface, and a stored session that called it replays as an unknown tool.

A provider action that exceeds the schema byte budget is callable but undeclared, which trades a first-call refusal for the tokens a large definition would spend on every step. Discovery is per conversation: work that resumes in a new conversation searches again.

Coverage lives with the package. `discovery.spec.ts` pins schema projection, naming, ambiguity, account isolation, version replacement, budget bounds and disposal; `discovery-loop.spec.ts` drives a real Agent through search, then calls the two discovered tools in the same turn and asserts the second request declares them; `tool-wiring.spec.ts` asserts the base surface and the absence of the removed execute tool.

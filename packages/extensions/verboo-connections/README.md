---
description: "Let an Agent discover and execute tools using the signed-in user’s connected accounts. Connections are selected by opaque account ID, and every execution uses the discovered tool version."
kind: "package-reference"
---

# @deepseek-ai/dsh-verboo-connections

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Let an Agent discover and execute tools using the signed-in user’s connected accounts. Connections are selected by opaque account ID, and every execution uses the discovered tool version.

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

The `verboo` profile mounts this extension. It attaches its [tool contribution](src/tools.ts) to each Agent through the existing lifecycle, including Agents already present when the plugin loads.

`connections_list` returns owned accounts and public services that require no credentials. Public service IDs use `public_<toolkit>`; the backend checks the toolkit’s no-auth declaration and discovered tool version for each execution. OAuth and user-supplied credentials remain in Composio’s hosted authorization flow.

`connections_search` is the entry point for integration work. It reads the account’s connections, asks the provider for the tools that match a capability, and registers each match in the calling Agent’s own tool registry as `connection__<toolkit>__<slug>`, with the provider’s own description and argument schema projected onto the enforced subset. The model calls those tools directly on its next step, so one request can search an inbox and then reply through the same conversation. Connected accounts are searched before public services; a public service does not make its connected account ambiguous. A service with several connected accounts is reported as ambiguous instead of being guessed: the Agent asks which account to use and searches again with that `connectionId`. Repeating a search replaces an older provider version instead of duplicating the tool, and a name already serving another account is never reused. The registry is disposed with its Agent scope, so a later conversation starts with only the base tools.

A replacement is validated before the old registration is withdrawn. If the new provider schema is unavailable, the search reports the error and the previous version remains callable for that conversation. The Agent is also guided to inspect any provider dispatcher’s own help and nested action schemas before calling them.

Provider search results may be imperfect. The Agent is instructed to inspect each tool's description and argument schema and search again when the returned actions do not match the request.

The same contribution installs the [MCP server tools](src/mcp-tools.ts) over `ctx.verbooMcp`. `mcp_servers_list` reads the account’s own servers with the tools each exposes and what blocks one that cannot connect. `mcp_server_save` and `mcp_server_remove` change that set, and both ask the human through `ctx.approval` first: a stdio server runs a command on the Host, and a removal withdraws tools mid-conversation. With no composed answerer, or with a session that answers anything but `allowed-once`, the write is refused and reports why so the Agent stops rather than retrying.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The Agent contribution is disposed with its owning fiber. The backend derives the actor from authenticated identity, verifies connection ownership and toolkit membership, and pins the tool version before executing once. Provider keys never become tool arguments. Ambiguous write failures instruct the Agent to inspect the service before retrying.

Each discovered tool validates its arguments against the projected schema before executing through the product API with the connection and version its own search resolved, so a later search cannot redirect an earlier call. Local schema references and unions of distinct JSON types are projected onto the enforced tool-schema subset: unsupported keywords and undeclared `required` keys are dropped rather than forwarded. A definition larger than `discoveryMaxSchemaBytes` first shortens annotations, then removes them; if its schema still exceeds the budget, the tool is not registered and discovery reports `schema_unavailable`. One search registers at most `discoveryMaxTools` tools across at most `discoveryMaxTargets` connections, so a broad query cannot flood the request with declarations.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Architecture](../../../docs/architecture.md) — shared Cordis engine.
- [Desktop runtime](../../../apps/desktop/tauri/README.md) — development and builds.

<a id="model-experience"></a>
## Model Experience

### Product integration

#### What the model sees

`connections_list` lists accounts and credential-free public services; `connections_search` turns a capability into callable tools. Each match becomes a `connection__<toolkit>__<slug>` declaration on the next request, carrying the provider’s name, description, and projected argument schema, and its result returns the provider’s JSON. `mcp_servers_list`, `mcp_server_save` and `mcp_server_remove` read and change the account’s own MCP servers. A save or removal reaches the model only after the human approves it; a refusal returns an actionable code instead of the change. A prompt section tells the model that connected services exist and that `connections_search` is how to reach them. Tool schemas and results are recorded by the existing tool pipeline.

#### Token effect

Five stable tool schemas enter every request: `connections_list`, `connections_search`, `mcp_servers_list`, and the two MCP write tools when their service is mounted. Each search adds the declarations it registered — at most twelve, each bounded by its description and schema budgets — and those declarations stay for the rest of the conversation. Discovered results append to the transcript. Each enabled MCP server adds the tool schemas it advertises.

#### KV Cache effect

The base tools and prompt prefixes remain unchanged. A search that registers new tools changes the declaration prefix once, at the step that discovers them; every later request in the conversation reuses it until another search adds more. User submissions and tool results append to the existing Session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- OAuth providers without managed authorization need a product auth config on the server. A provider action can commit before a network failure; writes are never retried automatically.
- Discovered tools are scoped to the conversation that searched for them, so a provider action the model needs later costs another search step.
- A provider tool whose compacted arguments exceed `discoveryMaxSchemaBytes` cannot be registered until its definition fits the configured budget.
- An MCP server added from a conversation is stored for the Host, not for that conversation, and stays enabled until the user switches it off or removes it.

<a id="dev-note"></a>
### Dev Note

None.

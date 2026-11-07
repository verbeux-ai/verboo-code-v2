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

The same contribution installs the [MCP server tools](src/mcp-tools.ts) over `ctx.verbooMcp`. `mcp_servers_list` reads the account’s own servers with the tools each exposes and what blocks one that cannot connect. `mcp_server_save` and `mcp_server_remove` change that set, and both ask the human through `ctx.approval` first: a stdio server runs a command on the Host, and a removal withdraws tools mid-conversation. With no composed answerer, or with a session that answers anything but `allowed-once`, the write is refused and reports why so the Agent stops rather than retrying.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The Agent contribution is disposed with its owning fiber. The backend derives the actor from authenticated identity, verifies connection ownership and toolkit membership, and pins the tool version before executing once. Provider keys never become tool arguments. Ambiguous write failures instruct the Agent to inspect the service before retrying.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Architecture](../../../docs/architecture.md) — shared Cordis engine.
- [Desktop runtime](../../../apps/desktop/tauri/README.md) — development and builds.

<a id="model-experience"></a>
## Model Experience

### Product integration

#### What the model sees

`connections_list`, `connections_search` and `connections_execute` list accounts, discover tool definitions and execute one selected action. `mcp_servers_list`, `mcp_server_save` and `mcp_server_remove` read and change the account’s own MCP servers. A save or removal reaches the model only after the human approves it; a refusal returns an actionable code instead of the change. Tool schemas and results are recorded by the existing tool pipeline.

#### Token effect

Six stable tool schemas enter requests. Searches return up to six definitions; execution results append to the transcript. Each enabled MCP server adds the tool schemas it advertises.

#### KV Cache effect

Stable tools and prompt prefixes remain unchanged; user submissions and tool results append to the existing Session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- OAuth providers without managed authorization need a product auth config on the server. A provider action can commit before a network failure; writes are never retried automatically.
- An MCP server added from a conversation is stored for the Host, not for that conversation, and stays enabled until the user switches it off or removes it.

<a id="dev-note"></a>
### Dev Note

None.

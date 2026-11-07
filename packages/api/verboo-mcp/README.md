---
description: "Store, validate and connect user-defined MCP servers for Verboo Code: durable definitions, credential references, live status and a keyless connection test."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-verboo-mcp

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Store, validate and connect user-defined MCP servers for Verboo Code: durable definitions, credential references, live status and a keyless connection test.

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

The `verboo` profile mounts this service beside `dsh-mcp-manager`. A definition is validated when it is written, stored durably, and registered on the shared MCP fleet, so the Agent's tool registry gains `mcp__<name>__<tool>` entries for exactly the servers the user switched on. [Config](src/index.ts) bounds one connection attempt, one tool call, one connection test, the tool names a test reports, and how many definitions one account may store.

Every write refuses a definition the manager could not mount, naming the offending field: a name outside `[A-Za-z0-9_-]{1,32}`, a `stdio` server without a command, a `streamable-http` server without an endpoint, a field belonging to the other transport, a credential template that is not a whole `${credential:REF}` token, or an endpoint that is neither `https` nor `http` on a loopback host. A refused write leaves the stored set unchanged.

Header and environment **values** are secrets. The surface submits them, the Host writes them to the credential store, and the definition keeps only the key and its reference. A blank value keeps the secret a previous save established, which is what makes an edit form that shows keys only and no values usable. No read path returns a value.

`probe` tests a definition without saving it: it resolves templates, connects, lists tools and closes, reporting the failing stage (`connect` or `list`) separately from closure. Nothing registers on `ctx.tools` and no namespace is reserved.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

Definitions live in a `per-record` [storage domain](../../storage/storage-domain/README.md) named `verboo_mcp_servers`, so a definition edit rewrites one document instead of the whole set. Each enabled definition owns one `ctx.mcpManager.register()` disposer; reconciliation is serialized on one chain, so two writes never mount the same server twice, and a withdrawn definition unregisters its tools before the write resolves. A name the deployment already configured as a manager entry keeps that deployment's server; the stored definition stays listed with its blocking condition.

Rollback is by registration ownership: the record is written first, then the live set is reconciled, and a failed mount leaves a stored definition that reports why it is idle rather than a half-mounted server. Teardown withdraws every registration this service owns and closes the domain.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [MCP manager](../../mcp/mcp-manager/README.md) — the shared server fleet this service registers on.
- [MCP client](../../mcp/mcp-client/README.md) — transport, templates and probe semantics.
- [Storage domain](../../storage/storage-domain/README.md) — durable records with schema validation.
- [Architecture](../../../docs/architecture.md) — shared Cordis engine.

<a id="model-experience"></a>
## Model Experience

### Product integration

#### What the model sees

The service registers no prompt or tool schema itself. The connections extension adds `mcp_servers_list`, `mcp_server_save` and `mcp_server_remove`; both writes ask the human through `ctx.approval` first and fail closed when no answerer is composed. Every server the user enabled contributes its own `mcp__<name>__<tool>` schemas to prompt assembly.

#### Token effect

Each enabled definition adds its server's advertised tool schemas to every request plus its identity line. A definition that never connects contributes nothing. The three management tools add fixed compact schemas.

#### KV Cache effect

Enabling, disabling, editing or removing a definition changes the admitted tool set, so the request prefix changes at that boundary. Unchanged definitions keep a stable prefix; user submissions and tool results append to the existing Session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A definition belongs to the Host, not to one Session: switching accounts in place does not partition the stored set, and removal is the only way to withdraw a definition from another account.
- A stdio definition runs an executable on the Host with the Host's permissions. The approval prompt is the only review step; the product does not sandbox a server process.

<a id="dev-note"></a>
### Dev Note

None.

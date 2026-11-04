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

`connections_list`, `connections_search` and `connections_execute` list accounts, discover tool definitions and execute one selected action. Tool schemas and results are recorded by the existing tool pipeline.

#### Token effect

Three stable tool schemas enter requests. Searches return up to six definitions; execution results append to the transcript.

#### KV Cache effect

Stable tools and prompt prefixes remain unchanged; user submissions and tool results append to the existing Session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The service catalog is restricted to backend-configured OAuth toolkits. A provider action can commit before a network failure; writes are never retried automatically.

<a id="dev-note"></a>
### Dev Note

None.

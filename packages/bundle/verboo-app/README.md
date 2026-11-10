---
description: "Run the Verboo Code product on the upstream Harness engine with Verboo login, a neutral editor with restrained purple accents, plans and per-user connections. The upstream Web and base bundle files remain reusable."
kind: "package-bundle"
---

# @deepseek-ai/dsh-verboo-app

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Run the Verboo Code product on the upstream Harness engine with Verboo login, a neutral editor with restrained purple accents, plans and per-user connections. The upstream Web and base bundle files remain reusable.

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

After building the checkout, launch `pnpm dsh --profile verboo --no-open` for a browser preview or `pnpm run dev:desktop` for Tauri development. The profile layers base, Web and this product bundle in that order.

The product uses compact Chat details and omits the diagnostic Trajectory view. Its UI shadows the activity and token-statistic dock cells and replaces the context meter through typed slots. Permissions, model selection, running feedback and account stamina retain their own controls. The bundle also mounts the Chrome extension provider, which adds browser tools to each conversation and connects them to the user's existing Chrome profile.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The [product patch](cordis.patch.yml) replaces account and interface providers through stable entry IDs and mounts the connections and Chrome browser extensions. Upstream internal package names and saved model provider routes remain technical identifiers. For an upstream update, merge its engine and Web composition, review the small shared extension changes, rebuild, and run product browser QA plus shared GUI checks.

The product sets `system-prompt.identity` without rewriting preset tool lists, so upstream personas retain the selected model introduction.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Architecture](../../../docs/architecture.md) — shared Cordis engine.
- [Desktop runtime](../../../apps/desktop/tauri/README.md) — development and builds.

<a id="model-experience"></a>
## Model Experience

### Product integration

#### What the model sees

The selected upstream `Agent` preset owns conversation context. The `system-prompt` configuration identifies the assistant as Verboo Code and keeps the selected model; the connections extension adds its three tools.

#### Token effect

The short product identity replaces the default opener. Enabled plugins own their remaining prompt and tool costs.

#### KV Cache effect

The product identity changes the system prefix for this profile. It remains stable for the same configuration and model; user submissions and tool results append to the existing Session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This is a source-checkout product profile. User-facing plugin installation is hidden, while Cordis remains the internal composition mechanism.

<a id="dev-note"></a>
### Dev Note

None.

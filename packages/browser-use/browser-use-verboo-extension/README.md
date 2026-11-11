---
description: "The Verboo Code Chrome extension provider, with one local Native Messaging bridge and conversation-scoped browser tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-browser-use-verboo-extension

English | [中文](README.zh.md)

## Summary

Connects Chrome's Verboo Code extension to the existing Verboo Host. The Host owns a loopback TCP server and gives each live conversation its own typed browser tools; Chrome owns tabs, groups, page interaction, history, and downloads.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-browser-use` and this provider in the Verboo profile. The Verboo product bundle does this automatically. The Native Messaging host connects to the Host's random loopback port after authenticating with a per-user bootstrap file under the operating system's application configuration directory.

The desktop bundle includes the Native Messaging executable and installs Chrome's per-user host manifest when Verboo Code starts. Set `VERBOO_CHROME_EXTENSION_ID` before building so Cargo embeds the same extension ID in the app and native host. Release builds require the published Chrome Web Store ID; the launcher rejects a release build without a valid ID. Development builds can use the ID assigned to the unpacked extension.

The provider registers browser tools in each Agent's own scope. Starting a task creates a background Chrome tab in a new purple group; pages opened by that task join its group. Existing tabs can be observed without moving them. Finishing a task leaves the group open. A login, MFA, or CAPTCHA observation brings the matching tab forward and waits until the challenge clears.

The provider waits up to 45 seconds for Chrome to attach and resends a command up to two times after a Native Messaging disconnect. Resends retain the request ID so the extension returns a cached result or reports an unknown outcome instead of repeating a page action. `connectionTimeoutMs` and `recoveryRetries` control these limits.

## Configuration

| Field | Default | Range | Effect |
| --- | ---: | ---: | --- |
| `connectionTimeoutMs` | `45000` | `1000`–`120000` | Maximum wait for Chrome to connect or reconnect. |
| `recoveryRetries` | `2` | `0`–`2` | Extra resends after Native Messaging disconnects. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The bridge binds only to `127.0.0.1`, authenticates the Native Messaging host with a random 256-bit token, and uses newline-delimited versioned JSON over the local socket. The Chrome extension uses Chrome's length-prefixed Native Messaging protocol on its other side. The extension instance identifier keeps task commands routed to the Chrome profile that created the task. Each command carries one request ID across connection retries. Chrome caches up to 4 MiB of recent responses in session storage and keeps durable request markers in local storage; the Host acknowledges received responses so the extension can clear both. After an extension reload, a marker without a session response produces an unknown-outcome error instead of repeating a page action.

The provider exposes `browser_task_start`, `browser_task_recover`, `browser_task_finish`, `browser_tabs_list`, `browser_tab_group_update`, `browser_tab_open`, `browser_tab_navigate`, `browser_page_observe`, `browser_page_act`, `browser_history_search`, `browser_download_start`, `browser_downloads_search`, and `browser_attention_raise`. Existing tabs can be navigated in place without changing their group or focus state; groups can be renamed, recolored, or collapsed without moving their tabs or focusing their window. Requested downloads use Chrome's configured download folder without opening a save dialog. If Chrome disconnects after creating a task but before returning its result, `browser_task_recover` resumes the same task ID while the extension's task session is available. If an extension or browser restart clears that session, a durable marker prevents duplicate creation and recovery stops for inspection. After a successful task, the agent asks whether to create a reusable site skill and asks for its destination before writing one. Tools use the standard DSH execution pipeline and Session log. Task identifiers are scoped to the conversation that created them.

The Chrome Manifest V3 source and Chrome Web Store packaging workflow live in the standalone [verboo-code-browser-extension repository](https://github.com/verbeux-ai/verboo-code-browser-extension). This provider remains the Host-side integration. The model-facing tool schemas are registered from the typed definitions in [`src/index.ts`](src/index.ts).

-----

<a id="model-experience"></a>
## Model Experience

### Product integration

#### What the model sees

Each conversation receives the typed Chrome tool catalog. Page results include visible text and controls; password and verification values are excluded. A verified login, MFA, or CAPTCHA challenge pauses the observation tool while the user completes it in Chrome.

#### Token effect

Tool schemas enter the prompt only for the conversation scope that owns the tools. Browser snapshots and operation results are ordinary tool results and may add model context.

#### KV Cache effect

The tool definitions remain stable while the provider is loaded. Page contents and tool results are request-specific additions.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Development runs need the unpacked extension's ID in `VERBOO_CHROME_EXTENSION_ID`; release builds need the published Chrome Web Store ID. The launcher rejects release builds without a valid ID, and Chrome's Native Messaging manifest embeds the configured ID in its allowed origins.
- The extension is versioned in [its standalone repository](https://github.com/verbeux-ai/verboo-code-browser-extension) and uploaded to Chrome Web Store as its own package.
- Chrome clears its session storage when the browser restarts or the extension reloads. Those events invalidate active task references; the Host reports an unknown outcome after a bridge disconnect.
- Cancellation cannot undo a browser action already delivered to Chrome.

<a id="dev-note"></a>
### Dev Note

None.

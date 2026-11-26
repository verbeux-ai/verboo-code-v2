---
description: "让 Agent 使用已登录用户连接的账号发现并执行工具。连接以不透明账号 ID 选择，每次执行均使用发现阶段返回的工具版本。"
kind: "package-reference"
---

# @deepseek-ai/dsh-verboo-connections

[English](README.md) | 中文

<a id="summary"></a>
## 概述

让 Agent 使用已登录用户连接的账号发现并执行工具。连接以不透明账号 ID 选择，每次执行均使用发现阶段返回的工具版本。

<a id="table-of-contents"></a>
## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

`verboo` 配置会加载此扩展。它通过现有生命周期将[工具贡献](src/tools.ts)附加到每个 Agent，包括插件加载时已存在的 Agent。

`connections_list` 返回用户拥有的账号和无需凭据的公共服务。公共服务 ID 使用 `public_<toolkit>`；每次执行时，后端会检查工具集无需认证的声明以及发现的工具版本。OAuth 和用户提供的凭据始终由 Composio 托管的授权流程处理。

`connections_search` 是集成工作的入口。它读取账号的连接，向提供方查询匹配某项能力的工具，并把每个匹配项以 `connection__<toolkit>__<slug>` 注册到调用方 Agent 自己的工具注册表中，同时带上提供方自己的描述，以及投影到受支持子集的参数 schema。模型在下一步直接调用这些工具，因此同一个请求可以先搜索收件箱再回复。已连接账号优先于公共服务搜索；同一工具集的公共服务不会使已连接账号产生歧义。某个服务有多个已连接账号时会报告为歧义而不是猜测：Agent 先询问使用哪个账号，再用该 `connectionId` 重新搜索。重复搜索会替换较旧的提供方版本而不是复制工具，已经在服务另一个账号的名称也绝不会被复用。注册表随其 Agent 作用域释放，因此后续对话只从基础工具开始。

替代版本会在撤销旧注册之前先经过验证。如果新的提供方 schema 不可用，搜索会报告错误，而先前版本在本次对话中仍可调用。Agent 也会收到指引，在调用提供方的分发工具时先查看其帮助信息和嵌套操作的 schema。

提供方的搜索结果可能并不完全匹配。Agent 会收到指引，在调用前检查工具描述和参数 schema，并在返回的操作不符合请求时重新搜索。

同一贡献还通过 `ctx.verbooMcp` 安装 [MCP 服务器工具](src/mcp-tools.ts)。`mcp_servers_list` 读取账号自己的服务器、各自暴露的工具，以及无法连接时的阻塞原因。`mcp_server_save` 与 `mcp_server_remove` 修改该集合，二者都会先通过 `ctx.approval` 询问人类：stdio 服务器会在 Host 上运行命令，移除则会在对话中途撤回工具。未组合应答器，或会话的回答不是 `allowed-once` 时，写入会被拒绝并说明原因，使 Agent 停止而不是重试。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

Agent 贡献随所属 fiber 释放。后端从认证身份确定用户，检查连接所有权与工具包归属，并在单次执行前固定工具版本。提供方密钥不会成为工具参数。写入结果不明时，会提示 Agent 先检查服务再重试。

每个被发现的工具在通过产品 API 执行前，根据投影后的 schema 验证参数，并使用它自己那次搜索解析出的连接和版本，因此后续搜索无法把先前的调用重定向到别处。本地 schema 引用和不同 JSON 类型的联合会投影到受支持的工具 schema 子集：不受支持的关键字与未在属性中声明的 `required` 键会被丢弃而不是转发。超过 `discoveryMaxSchemaBytes` 的定义首先缩短注释，再移除注释；如果仍超出预算，则不会注册该工具，发现结果会报告 `schema_unavailable`。一次搜索最多在 `discoveryMaxTargets` 个连接上注册 `discoveryMaxTools` 个工具，因此宽泛查询不会用大量声明淹没请求。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [架构](../../../docs/architecture.zh.md) — 共享的 Cordis 引擎。
- [桌面运行](../../../apps/desktop/tauri/README.zh.md) — 开发与构建。

<a id="model-experience"></a>
## 模型体验

### 产品集成

#### 模型看到什么

`connections_list` 列出账号和无需凭据的公共服务；`connections_search` 把一项能力转换为可调用的工具。每个匹配项都会在下一个请求中成为 `connection__<toolkit>__<slug>` 声明，携带提供方的名称、描述和投影后的参数 schema，其结果返回提供方的 JSON。`mcp_servers_list`、`mcp_server_save` 与 `mcp_server_remove` 用于读取和修改账号自己的 MCP 服务器。保存或移除只有经人类批准后才会到达模型；被拒绝时返回可操作的代码而不是改动结果。一段提示词章节会告知模型存在已连接的服务，并说明 `connections_search` 是到达它们的途径。工具定义与结果由现有工具管道记录。

#### Token 影响

每个请求包含五个稳定的工具定义：`connections_list`、`connections_search`、`mcp_servers_list`，以及在其服务已挂载时的两个 MCP 写入工具。每次搜索会添加它注册的声明——最多十二个，每个都受其描述与 schema 预算约束——这些声明在本次对话余下部分保留。发现结果追加到对话记录。每个已启用的 MCP 服务器会增加它公布的工具定义。

#### KV Cache 影响

基础工具与提示词前缀保持不变。注册新工具的搜索会在发现它们的那一步改动一次声明前缀；对话中后续每个请求都复用它，直到另一次搜索添加更多工具。用户提交和工具结果追加到现有会话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 未提供托管授权的 OAuth 服务需要在服务器配置产品认证。提供方操作可能在网络故障前已提交，因此绝不自动重试写入。
- 被发现的工具只属于搜索它的那次对话，因此模型之后需要的提供方操作会再花一个搜索步骤。
- 提供方工具的参数压缩后仍超过 `discoveryMaxSchemaBytes` 时，只有其定义符合配置预算后才能注册。
- 从对话中添加的 MCP 服务器属于 Host 而非该对话，并会保持启用，直到使用者将其停用或移除。

<a id="dev-note"></a>
### 开发备注

无。

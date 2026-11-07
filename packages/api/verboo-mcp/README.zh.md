---
description: "为 Verboo Code 存储、校验并连接用户自定义的 MCP 服务器：持久定义、凭据引用、实时状态与无需密钥的连接测试。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-verboo-mcp

[English](README.md) | 中文

<a id="summary"></a>
## 概述

为 Verboo Code 存储、校验并连接用户自定义的 MCP 服务器：持久定义、凭据引用、实时状态与无需密钥的连接测试。

<a id="table-of-contents"></a>
## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

<a id="use-this-package"></a>
## 使用此包

`verboo` 配置在 `dsh-mcp-manager` 旁边挂载此服务。定义在写入时校验、持久保存，并注册到共享的 MCP 服务器集合，因此 Agent 的工具注册表只会为使用者启用的服务器增加 `mcp__<name>__<tool>` 条目。[Config](src/index.ts) 限定一次连接尝试、一次工具调用、一次连接测试、测试返回的工具名数量，以及一个账号可保存的定义数量。

每次写入都会拒绝管理器无法挂载的定义，并指出出错字段：名称超出 `[A-Za-z0-9_-]{1,32}`、`stdio` 服务器缺少命令、`streamable-http` 服务器缺少端点、字段属于另一传输方式、凭据模板不是完整的 `${credential:REF}` 令牌，或端点既不是 `https` 也不是回环主机上的 `http`。被拒绝的写入不会改变已保存的集合。

请求头和环境的**值**属于机密。界面提交值，Host 将其写入凭据存储，定义只保留键与其引用。空值保留上一次保存建立的机密，这正是“只显示键、不显示值”的编辑表单可用的原因。任何读取路径都不会返回值。

`probe` 在不保存的情况下测试定义：解析模板、连接、列出工具并关闭，分别报告失败阶段（`connect` 或 `list`）与关闭结果。它不在 `ctx.tools` 注册任何内容，也不占用命名空间。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

定义存放在名为 `verboo_mcp_servers` 的 `per-record` [存储域](../../storage/storage-domain/README.zh.md)中，因此编辑一个定义只重写一个文档而不是整个集合。每个启用的定义拥有一个 `ctx.mcpManager.register()` 释放器；协调在单条链上串行执行，所以两次写入不会重复挂载同一服务器，撤销的定义会在写入完成前注销其工具。若名称已被部署配置为管理器条目，该部署的服务器保持有效；已保存的定义仍会列出，并显示其阻塞原因。

回滚依据注册所有权：先写入记录，再协调实时集合；挂载失败会留下一个已保存、并报告为何空闲的定义，而不是半挂载的服务器。销毁时会撤销此服务拥有的每个注册并关闭域。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [MCP 管理器](../../mcp/mcp-manager/README.zh.md)——此服务注册所用的共享服务器集合。
- [MCP 客户端](../../mcp/mcp-client/README.zh.md)——传输、模板与探测语义。
- [存储域](../../storage/storage-domain/README.zh.md)——带 schema 校验的持久记录。
- [架构](../../../docs/architecture.zh.md)——共享的 Cordis 引擎。

<a id="model-experience"></a>
## 模型体验

### 产品集成

#### 模型看到什么

此服务本身不注册提示词或工具 schema。连接扩展增加了 `mcp_servers_list`、`mcp_server_save` 与 `mcp_server_remove`；两个写入工具都会先通过 `ctx.approval` 询问人类，未组合应答器时按失败关闭处理。使用者启用的每个服务器都会贡献自身的 `mcp__<name>__<tool>` schema 到提示词组装。

#### Token 影响

每个启用的定义在每次请求中增加该服务器公布的 schema 及其身份行。从未连接的定义不贡献任何内容。三个管理工具增加固定的紧凑 schema。

#### KV 缓存影响

启用、停用、编辑或删除定义会改变被接纳的工具集合，因此请求前缀在该边界发生变化。未变化的定义保持稳定前缀；用户提交与工具结果追加到既有 Session。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 定义属于 Host 而非单个 Session：就地切换账号不会分隔已保存的集合，移除是让其他账号不再看到某定义的唯一方式。
- `stdio` 定义以 Host 的权限在 Host 上运行可执行文件。审批提示是唯一的审查步骤；产品不会沙箱化服务器进程。

<a id="dev-note"></a>
### 开发备注

无。

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

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

Agent 贡献随所属 fiber 释放。后端从认证身份确定用户，检查连接所有权与工具包归属，并在单次执行前固定工具版本。提供方密钥不会成为工具参数。写入结果不明时，会提示 Agent 先检查服务再重试。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [架构](../../../docs/architecture.zh.md) — 共享的 Cordis 引擎。
- [桌面运行](../../../apps/desktop/tauri/README.zh.md) — 开发与构建。

<a id="model-experience"></a>
## 模型体验

### 产品集成

#### 模型看到什么

`connections_list`、`connections_search` 与 `connections_execute` 用于列出账号、发现工具定义并执行所选操作。工具定义与结果由现有工具管道记录。

#### Token 影响

请求包含三个稳定的工具定义。搜索最多返回六个定义，执行结果追加到对话记录。

#### KV Cache 影响

稳定的工具与提示词前缀保持不变；用户提交和工具结果追加到现有会话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 服务目录仅包含后端配置的 OAuth 工具包。提供方操作可能在网络故障前已提交，因此绝不自动重试写入。

<a id="dev-note"></a>
### 开发备注

无。

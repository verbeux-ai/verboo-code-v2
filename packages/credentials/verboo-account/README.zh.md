---
description: "通过 OAuth PKCE 登录 Verboo，并使用该账号获准访问的模型。刷新凭据以加密形式存储在 Host 中，加密密钥保留在操作系统凭据库。"
kind: "package-reference"
---

# @deepseek-ai/dsh-verboo-account

[English](README.md) | 中文

<a id="summary"></a>
## 概述

通过 OAuth PKCE 登录 Verboo，并使用该账号获准访问的模型。刷新凭据以加密形式存储在 Host 中，加密密钥保留在操作系统凭据库。

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

`verboo` 配置提供公开 API 地址、路由地址与 OAuth 客户端 ID。[Config](src/config.ts) 定义部署设置。生产客户端使用 `https://code.verboo.ai`、其 `/router/v1` 网关与已注册的公开客户端 `verboo-code-cli`。本地 HTTP 必须显式启用开发设置。每次推理请求都会发送生成的 `X-Request-Id`，并记录该 id 与路由；格式错误的工具调用诊断只记录故障类别和可用的提供方响应 id。账户路由会在分派工具前拒绝格式错误的调用，并默认对格式错误的模型响应重试一次；`malformedResponseRetries: 0` 会禁用这次额外请求。

推理请求收到 HTTP 401 时，账户路由会针对该请求使用的精确 token 强制刷新一次；只有登录身份未变时才会重放一次请求。再次收到 401 后会直接返回错误，不再刷新。HTTP 403 会报告为访问被拒绝，不会刷新或删除登录凭据。刷新超时或网络失败会保留已存储的授权记录，并停止模型请求，不会自动重放。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

账号凭据在持久化前加密，绝不通过 Remote 返回。公开的凭据修订号标识一次登录，在令牌刷新期间保持不变，从而保留已验证的用户资料与 Client 状态。替换登录或凭据遭拒会使该身份失效；迟到的用户资料响应不会跨登录使用。刷新与退出操作捕获所属安装会话。模型发现保留服务器的完整模型 ID，并委托已有 pi-ai 适配器执行推理。新的原生登录观察使用 Revenue Journey v1；排队的观察在收到精确持久化回执前保留原始版本与字节。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [架构](../../../docs/architecture.zh.md) — 共享的 Cordis 引擎。
- [桌面运行](../../../apps/desktop/tauri/README.zh.md) — 开发与构建。

<a id="model-experience"></a>
## 模型体验

### 产品集成

#### 模型看到什么

所选 `deepseek-account` 模型通过 pi-ai 接收现有对话和工具请求；身份认证不增加提示词段落。

#### Token 影响

身份认证和本地响应校验不增加输入 token。通过 agent loop 重试格式错误的响应会再次发送模型请求，可能消耗额外的输入和输出 token；直接调用 LLM 流仍只尝试一次。模型选择决定提供方的分词器与上下文限制。

#### KV Cache 影响

稳定的工具与提示词前缀保持不变；用户提交和工具结果追加到现有会话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 操作系统凭据库必须可用。撤销失败会被报告，但不会恢复本地凭据；服务器会话在撤销成功前仍未确认。

<a id="dev-note"></a>
### 开发备注

无。

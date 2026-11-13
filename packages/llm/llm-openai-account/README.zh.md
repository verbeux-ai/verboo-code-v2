---
description: "[OI] 订阅 provider 路由：通过 Codex responses 协议提供 ChatGPT 模型、订阅限额分类，以及 Host 提供给客户端的用量读取。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-openai-account

[English](README.md) | 中文

## 概述

在 `ctx.llm` 上注册 `openai-account` 路由，提供 ChatGPT 套餐包含的 GPT 模型。本插件组合在 [pi-ai 适配器](../llm-pi-ai/README.zh.md)之上：已安装的 `openai-codex` 目录提供端点、`openai-codex-responses` 协议和模型列表，因此本包只负责路由名称、每次请求的账号令牌、订阅拒绝的分类以及用量读取。已存储的 [OI] 账号会话来自可选的 `ctx.openaiAccount` 服务；缺少该服务时本路由不提供任何模型，而不是让启动失败。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在负责登录的账号插件旁挂载本插件，并让每个没有 [OI] 账号的组合都不挂载 `openai-account`。路由始终注册；在未存储会话时它不列出任何模型，并让每个请求以 `ACCOUNT_SIGN_IN_REQUIRED` 失败，因此未登录时挂载它的组合显示空目录，而不是损坏的目录。

```yaml
- id: llm-openai-account
  name: '@deepseek-ai/dsh-llm-openai-account'
  config:
    usageTimeoutMs: 10000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `usageTimeoutMs` | `10,000` | 一次用量读取的期限；超过期限的读取不产生读数 |

路由以 `Authorization: Bearer <access token>` 和 `chatgpt-account-id` 发送 `POST https://chatgpt.com/backend-api/codex/responses`，其中账号标识由传输层从令牌的 `https://api.openai.com/auth` 声明中读取。每个请求同时携带 Harness 归属请求头。任何令牌、账号标识或请求文本都不会进入日志、错误消息或 Session 事件。

### 订阅限额

拒绝以下列三种代码之一到达 Harness，代码决定重试策略和用户接下来做什么：

| 证据 | 代码 | 可重试 | 处理方式 |
|---|---|---|---|
| `x-codex-rate-limit-reached-type` 指明 `workspace_owner_usage_limit_reached` 或 `workspace_member_usage_limit_reached` | `QUOTA` | 否 | 等待窗口重置 |
| 指明额度耗尽的理由（`workspace_member_credits_depleted`）、`x-codex-credits-has-credits: false`，或点名额度耗尽的措辞 | `ACCOUNT_QUOTA` | 否 | 补充额度 |
| 渲染文本点名用量限额与重置时间的 429 | `QUOTA` | 否 | 等待窗口重置 |
| 未点名任何终止理由的 429 | `RATE_LIMIT` | 是，按默认策略 | 重试 |

`QUOTA` 和 `ACCOUNT_QUOTA` 是 `dsh-llm` 已定义的代码；`RATE_LIMIT` 是默认可重试集合中的瞬时类别。因此终止性拒绝永远不会被重放，调用方在终止性拒绝时切换 provider 也不需要自有通道。

### 用量读取

`usage(signal)` 是本插件的 Remote 方法，暴露在端点 `llmOpenaiAccount/usage`（Cordis 服务键与 wire 命名空间都是 `llmOpenaiAccount`）。它返回 `{ usedPercent, windowSeconds, resetAfterSeconds, credits?, unlimited, planType?, activeUntil?, reachedType?, additionalLimits?, asOf }`，未取得读数时返回 `undefined`。`undefined` 是唯一的失败信号：该方法从不抛错，因此客户端什么都不绘制，而不是绘制归零的计量条。仅当显式 `x-codex-credits-unlimited: true` 时 `unlimited` 为 true；缺失的请求头不构成任何一侧的证据，字段保持 false。

<a id="understand-the-implementation"></a>
## 理解实现

适配器在键为 `openai-codex` 的配置之上构建一个 pi-ai 适配器实例，该键是 Codex responses 协议的已安装目录 provider，而注册为 `openai-account` 所有者的是本类——不是那个实例。每次调用转换路由键、每个请求解析一次账号令牌，并原样转发流。终止性失败在出口处被重写：`error` 结束原因和抛出的 `LlmError` 都经过同一分类器，因此无论传输层以哪种方式交付拒绝，分类结果都相同。

pi-ai 集合需要凭据存储与 ambient 鉴权上下文；两者都以空实现提供，因为本路由总是把账号令牌作为请求自身的键，账号插件是会话的唯一所有者。配置中命名一个凭据引用，使 pi-ai 采信该请求级令牌而不是它自己的 OAuth 存储，且从环境中读取该引用的情况从不发生。

用量读取以相同凭据和期限请求 `GET https://chatgpt.com/backend-api/codex/usage`。它的文档和请求头都会被读取：窗口字段来自文档（嵌套的 `rate_limit` 或扁平写法），而额度和当前生效限额的事实来自请求头，后者描述当前支配请求的限额。非成功状态仍会贡献它的请求头，因此客户端可以显示拒绝状态。

<a id="further-exploration"></a>
## 进一步探索

[LLM 流式传输](../../../docs/subsystems/llm-streaming.zh.md) · [pi-ai 适配器](../llm-pi-ai/README.zh.md) · [请求重试](../llm-retry/README.zh.md)

<a id="model-experience"></a>
## 模型体验

None, as this route adds no model-visible text of its own and the shared pi-ai transport serializes every request.

#### KV Cache effect

这里没有任何东西改变请求前缀：本插件不添加 prompt 段落、工具或消息，令牌与账号请求头是 provider 不计入可缓存输入的传输元数据。在 ChatGPT 模型之间切换会开始新的前缀，因为 provider 按模型维护缓存键。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Codex 传输层把每个 429 折叠成它自己的句子并丢弃响应头，因此在模型路径上，额度耗尽与窗口用尽的区别只在 provider 文本保留了该区别时可见。权威读数来自用量端点，它同时携带请求头和结构。
- 路由列出整个已安装的 Codex 目录；套餐不包含某模型时，由 provider 的拒绝告知，而不是目录。
- 用量读数不做缓存。每次调用执行一次请求，因此轮询的客户端每次轮询都付出一次请求。
- 读数没有流式形式；客户端只能再次询问才能观察到新读数。
- 本包只提供英文 README；中文对应版本随后续常规翻译补上。

<a id="dev-note"></a>
### 开发说明

协议实现、转录投影、重放状态和流词汇都留在 `dsh-llm-pi-ai`；本包只增加分类和凭据桥接，因此可以用 fetch 替身驱动共享运行时来无网络测试。

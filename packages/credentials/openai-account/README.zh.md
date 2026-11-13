---
description: "[OI] ChatGPT 账户登录、加密授权存储，以及登录时已携带的订阅方案信息。"
---

# [DSH] [OI] 账户

[English](README.md) | 中文

## 概述

负责一次 [OI] ChatGPT 订阅登录：带 PKCE 的浏览器授权码流程、密钥保存在操作系统凭据库中的加密授权、其后的刷新轮换，以及 ID 令牌已声明的方案信息。

## 目录

- [为何存在此包](#why-this-package-exists)
- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

<a id="why-this-package-exists"></a>

## 为何存在此包

已付费订阅 ChatGPT 的读者应当能使用这些模型，而无需按令牌再付一次。订阅没有公开 API，因此登录复刻 Codex 客户端所执行的流程：带 PKCE 的授权码、可轮换的刷新授权，以及声明方案与其付费窗口终点的 ID 令牌。将该流程收敛在一个包内，意味着产品其余部分只依赖一个令牌和少量方案信息，而不是获取它们的方式。

<a id="use-this-package"></a>

## 使用此包

```yaml
- id: openai-account
  name: '@deepseek-ai/dsh-openai-account'
- id: openai-account-login
  name: '@deepseek-ai/dsh-openai-account/remote'
```

`ctx.openaiAccount` 是服务；`openaiAccountLogin` Remote 界面是登录对话框所访问的对象。二者在存储会话之前均处于休眠状态，因此未登录的构建行为与从前完全一致。

<a id="understand-the-implementation"></a>

## 理解实现

`begin()` 构建授权 URL 并返回回调必须出示的 PKCE verifier。`complete(code)` 交换它并在返回前持久化授权，因为交换会轮换刷新令牌：两者之间的崩溃否则会存下提供方已消费的令牌。`accessToken()` 续期过期令牌，在无会话时报告 `undefined`，这是本包对"已登录"的唯一声明——它从不断言提供方当前接受该存储令牌。

被拒绝的刷新会清除会话，因为存储的授权已无法产出令牌。网络故障则保留它：只有提供方能判定授权已失效。授权以 AES-256-GCM 封存，密钥保存在操作系统凭据库，并作为关联数据绑定到令牌端点，以仅属主可读的模式写入。任何令牌与提供方响应体都不会进入日志或错误消息。

方案信息取自 ID 令牌载荷：`chatgpt_plan_type`、`chatgpt_account_id` 与 `chatgpt_subscription_active_until`。本构建无法解码的载荷报告无信息，而不是让本已成功的登录失败，因为方案是展示数据，而令牌才是路由所需的。

<a id="dev-note"></a>

## 开发说明

授权保险库与 Verboo 账户一致：认证加密、密钥存于凭据库、issuer 绑定，磁盘上无明文。


<a id="model-experience"></a>

## 模型体验

None, as this package produces no model-visible text; it stores a credential and reports plan facts to the surfaces that show them. 订阅自身的模型是否应答由消费该令牌的路由决定。

#### KV Cache effect

None. 本包不为任何请求添加前缀，也不更改消息内容，因此不影响路由发送的可缓存前缀。


## 已知限制与后续工作

- 端点与客户端标识复刻 Codex 客户端，而非公开 API。提供方变更会在无通知下破坏登录，这正是该流程单独成包的原因。
- 回调不在本地提供：对话框要求粘贴提供方页面留在地址栏中的代码。监听器需要本构建未开放的端口。
- 每个安装一个会话。多账户需要按身份区分的记录，当前没有消费者要求。

# Agent Note: DeepSeek 请求错误与桌面可观测性

Status: implemented

[English](2026-11-16-deepseek-request-errors-and-observability.md) | 中文

## 问题

桌面端用户报告了重复出现的 HTTP 400 `INVALID_REQUEST`、工具调用格式错误、认证错误、超时和一般网络错误。DeepSeek 账户路由启用了 provider 的思考格式，却没有在重放之前的 assistant 工具调用消息时保留 `reasoning_content`。DeepSeek 要求后续带工具请求中包含此字段；缺失时可能拒绝请求。

桌面端也只显示通用错误，无法按错误类别、状态码、模型、provider 和版本查询统计。

## 决定

Verboo 账户路由现在声明 `requiresReasoningContentOnAssistantMessages: true`。因此 pi-ai adapter 会在之前的 assistant 消息缺少 reasoning 时序列化空的 `reasoning_content` 字段，满足 DeepSeek 请求契约。

每次模型尝试终止失败时，桌面端可以向第一方可观测性路由发送一条有界的 `desktop_model_error` 事件。事件分类包括无效请求、格式错误的响应、超时、传输失败、认证、速率限制、用量结算等待、上游故障和未知错误。端点验证严格 schema，记录 Prometheus 计数器，并将受限字段转发到现有 PostHog 项目。

## 数据和影响

事件仅包含受限的错误类别/代码、是否可重试、可用时的 HTTP 状态，以及经过校验的 provider/model/应用版本标识。事件不包含账户、用户、设备、会话、提示词、回答、工具名称、工具参数或 provider 原始消息。PostHog 禁用用户画像与地理定位；Prometheus 标签不包含 provider、model 或版本。

采集采用尽力而为方式，遵循现有 product-analytics 策略，并受短时限约束。采集失败不会改变模型轮次。额外请求只在终止错误后发生；它不会调用模型 provider，也不会增加模型 token。不会引入自动模型切换。

## 验证

针对 adapter、账户 profile、桌面事件、schema、metrics 和路由的测试覆盖了修正后的请求格式、隐私边界、PostHog 转发和采集失败处理。前端部署流程已将现有 PostHog 项目配置传入运行时构建。

## 考虑过的替代方案

不转发 provider 原始响应，因为其中可能包含提示词、工具数据或账户详情。也不加入自动重试或模型回退，以免改变成本或掩盖发生故障的路由。

## 后果

DeepSeek 路由现在会保留继续工具调用所需的 reasoning 字段。PostHog 和 Prometheus 可以按受限的错误及模型维度统计终止失败，而不收集聊天内容。其他 provider 故障和用量结算故障仍分别显示；此次变更不会绕过用量结算保护。

## 已知限制

若埋点关闭、应用在尽力而为发送完成前退出，或第一方端点不可用，遥测可能缺失。PostHog 配置可选；Prometheus 会在缺少配置或端点拒收事件时记录转发失败。

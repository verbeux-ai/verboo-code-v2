---
kind: upgrade-guide
description: 桌面产品使用专属 Verboo 配置并替换账号、导航与账单界面。
---

# Verboo Code 产品配置

[English](guide.md) | 中文

## 变更

Tauri 桌面启动叠加在上游 `web` 组合之上的 `verboo` 配置。Verboo OAuth 替代 DeepSeek 登录，方案界面替代余额和充值控件，用户所属的连接替代插件管理界面。内部包名与 `deepseek-account` 模型路由仍作为已有 Session 的技术标识。

## 迁移

1. 在仓库中运行 `pnpm install` 与 `pnpm run build:artifacts`。使用 `pnpm run start:desktop` 启动原生应用，或通过 `pnpm dsh --profile verboo --no-open` 预览。
2. 使用 Verboo 登录。不要复制 CLI 凭据或其他配置的存储。操作系统凭据库必须可用。
3. 仅在中央后端配置 Composio。每个已认证 Verboo 用户授权自己的账号，应用不会接收 Composio 项目密钥。
4. 确认 Verboo 引导与导航正常加载、账号模型出现，且连接和我的方案显示服务器数据。产品界面在客户端启动时为必需条目，激活失败将阻止启动成功。

上游更新见[产品 bundle](../../../../packages/bundle/verboo-app/README.zh.md)。

---
kind: upgrade-guide
description: "桌面开发命令改为启动 Tauri，而不再启动 Electron。"
---
# Tauri 桌面开发

[English](guide.md) | 中文

## 变更

`pnpm run dev:desktop` 和 `pnpm run start:desktop` 打开 Verboo Code Tauri 应用。共享 Node 配置仍负责代理、会话、凭据、工具、插件以及经过认证的本地 API。Tauri 使用操作系统的 WebView，不再附带 Electron 的 Chromium 运行时。

开发应用使用 `apps/desktop/.desktop-build/tauri/home`，不会覆盖原来的 Electron 开发目录。显式设置 `DSH_HOME` 可选择已有目录；复用前请检查其配置。Electron 专有的 preload API、安装包格式和更新服务地址不适用于 Tauri。

## 迁移

1. 安装当前操作系统所需的 [Tauri 开发依赖](https://v2.tauri.app/start/prerequisites/)，包括 Rust 和原生开发工具。
2. 在仓库根目录运行 `pnpm install`。
3. 运行 `pnpm run dev:desktop`。仓库构建成功后，`pnpm run start:desktop` 可复用已有产物。
4. 确认 Verboo Code 原生窗口打开、能够选择工作区，并且退出应用会停止其 Node Host。构建和开发命令参见[桌面参考](../../../../apps/desktop/tauri/README.zh.md)。

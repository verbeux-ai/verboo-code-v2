# Agent Note: 使用 Node 配置 Host 的 Tauri 桌面载体

Status: implemented

[English](2026-11-04-tauri-desktop-carrier.md) | 中文

## Problem

Verboo Code 需要 Tauri 桌面应用，同时保留现有代理、插件、会话和认证 Web 应用。若同时替换 Node 引擎与原生窗口，就会重复这些服务并改变插件执行方式。

## Decision

Tauri 负责原生窗口与操作系统 WebView。私有独立 Node 进程运行叠加在共享 Web 与 base bundle 上的产品 `verboo` 配置。带版本的 stdout 通道报告就绪状态，不把启动凭据打印到原生日志；stdin 负责正常关闭。Rust 在导航前验证本地启动来源，只授予应用窗口在该来源使用原生目录选择的权限。初始 Host 文档在令牌交换前建立同站上下文，使打包后的 WebKit 保持现有 Strict Cookie 策略。客户端沿用 Web 键盘与账号适配器，不设置 Electron 专有文档标记。

产品层提供 Verboo OAuth、中性编辑器界面、订阅和按用户隔离的服务连接。它通过组合 ID 替换提供方与界面入口；可选的开场与运行指示器 Slot，以及可移除的主题和图标覆盖，使共享 Chat 引擎保持可复用。Composio 凭据只保存在中央后端，后端从已认证账号确定各连接的所有者。

原生打包遍历工作区依赖及 peer 依赖，打包构建产物，保留经过审核的依赖补丁与构建脚本决策，并在发布到本地构建目录前，使用校验过的官方 Node 二进制测试安装结果。开发状态位于运行时负载之外。

本文部分取代[共享 Web 应用决策](2026-09-10-desktop-web-wrapper.zh.md)中的载体机制；复用后端仍然有效。Electron 源码、安装器测试及 [Electron 打包依据](2026-08-25-electron-desktop-packaging-and-updates.zh.md)仍属于旧工具，因此保留相关记录而不归档。它们的 Electron preload、更新器和后台窗口行为不定义 Tauri 行为。

## Alternatives considered

**继续默认使用 Electron。** 这不能实现要求的框架切换。

**把代理引擎移植到 Rust。** 这会不必要地替换插件运行时和持久化消费者；共享 Node 配置可保留其职责。

**只部署 dependency 边。** 这样会遗漏仅通过工作区 peer 引用的提供者。独立运行时必须包含并测试完整 peer 闭包。

## Consequences

默认桌面命令启动 Tauri。退出应用会释放 Host，不采用 Electron 托盘生命周期。原生发布凭据和更新服务需要 Tauri 专有配置；旧 Electron 发布工具保持独立。真实配置 Node 集成测试、Rust 生命周期测试和原生客户端就绪信号可在无需模型凭据的情况下验证启动与关闭。

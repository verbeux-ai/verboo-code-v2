# Agent Note: Desktop 布局恢复

Status: implemented

[English](2026-11-26-desktop-layout-recovery.md) | 中文

## 问题

桌面 Host 每次启动使用新的回环端口，因此浏览器来源存储无法在应用重启后保留侧栏布局和终端绑定。保留的终端标签不能声称之前的 Host 进程仍然存在。

## 决策

受控的 Tauri 窗口将有大小限制的侧栏偏好、右侧栏 Session 布局、终端绑定及 shell 偏好白名单镜像到原生应用数据。客户端模块初始化前先恢复这些键。原生写入通过进程锁串行化，并原子替换保存的快照。Web 存储行为保持独立。侧栏使用之前的身份恢复终端标签；Host 报告进程不存在时，已有的不可用视图提供新终端，但不自动启动。

## 考虑过的替代方案

**仅使用回环来源。** 每次启动选择新端口，浏览器存储无法恢复之前的布局；固定端口也会与并发窗口冲突。

## 后果

仅镜像布局和终端簿记数据，不包括凭据与对话内容。每个 Session 保留自己的右侧栏布局，框架宽度则是窗口级偏好。进程和终端输出无法在 Host 关闭后保留。存储无效或不可用时回退到内存布局。

## 相关

- [Desktop 运行时](../../../../apps/desktop/tauri/README.zh.md)
- [右侧栏](../../../../packages/client/ui-sidebar-right/README.zh.md)
- [终端](../../../../packages/client/ui-sidebar-terminal/README.zh.md)

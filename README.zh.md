# Verboo Code

[English](README.md) | 中文

Verboo Code 是基于 Tauri 的桌面编程应用，提供 Verboo 登录、账号模型、项目与工具连接。它使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 引擎及其 Cordis 插件架构。

<a id="run"></a>

<a id="run-from-source"></a>

## 开发

安装 Node.js 24.9 或更高版本、pnpm、Rust 以及 [Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)，然后运行：

```sh
git clone https://github.com/verbeux-ai/verboo-code-v2.git
cd verboo-code-v2
pnpm install
pnpm run dev:desktop
```

在系统浏览器使用 Verboo 账号登录。模型访问权限与订阅状态来自 Verboo API。Composio 服务凭据仅属于中央后端，桌面客户端不会接收这些凭据。

执行 `pnpm run build:artifacts` 后，可运行浏览器预览：

```sh
pnpm dsh --profile verboo --no-open
```

原始上游 Web 组合仍可通过 `pnpm dsh --profile web --no-open` 运行。各配置使用独立的组合文件。上游更新见[产品 bundle](packages/bundle/verboo-app/README.zh.md)，原生构建见[桌面运行](apps/desktop/tauri/README.zh.md)。

## 产品包

- [界面](packages/client/ui-verboo/README.zh.md)：引导、紫色配色、项目导航、方案与连接。
- [账号](packages/credentials/verboo-account/README.zh.md)：OAuth PKCE、加密凭据与账号授权推理。
- [产品 API](packages/api/verboo-product/README.zh.md)：可安全展示的账号数据与受信任的浏览器流程。
- [连接](packages/extensions/verboo-connections/README.zh.md)：供 Agent 使用的用户所属外部工具。

## 贡献

阅读 [AGENTS.md](AGENTS.md)、[架构](docs/architecture.zh.md)、[开发指南](docs/development.zh.md)和[安全说明](SAFETY.zh.md)。内部 `@deepseek-ai` 包名标识上游组件，并为更新及已保存的 Session 保持稳定。

## 许可证

[MIT](LICENSE)。保留上游版权声明。字体与图标许可证记录在[产品素材许可证](packages/client/ui-verboo/LICENSES.md)。

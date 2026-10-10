# 原桌面 API 历史文档 / Legacy desktop API archive

本目录只保留原 `dsh-plugin-desktop` 的插件 service 文档，供维护旧插件和追溯接口使用；不包含旧工程源码，也不是当前 SuperDsh 的开发入口。

- [中文历史 API](plugin-services.zh.md) · [English historical API](plugin-services.md)
- 当前产品开发：根 [README](../../README.md)。
- 当前产品内部契约：[Core contracts](../../apps/desktop/core/src/contracts/)；浏览器业务模型：[Core client](../../apps/desktop/core/src/client/)。UI 只导入公开的 `@superdsh/core/contracts/*` 与 `@superdsh/core/client/*`，这些内部入口不是自动授予第三方插件的新 API。

历史示例中的 `dsh-plugin-desktop/*` import、Electron main 内 Host 和旧呈现模式描述仅适用于原桌面。旧包已经退出当前工作区，不能将这些示例直接作为 SuperDsh 依赖。当前产品由应用外壳调度必需的 Harness 插件，旧第三方界面通过独立兼容文档运行；具体边界以根 README 和实现为准。

This directory preserves only the former `dsh-plugin-desktop` service documentation for legacy plugin maintenance and API history. It contains no retired implementation. Use the root [README](../../README.en.md) for SuperDsh development.

The archived `dsh-plugin-desktop/*` imports, in-main-process Host model and presentation modes describe the former product. They are not direct dependencies or supported new integration instructions for SuperDsh. Product UI uses the public Core `client/*` and `contracts/*` exports; these internal product exports do not automatically constitute a third-party plugin API. SuperDsh owns the application shell, starts the required Harness plugin and runs legacy third-party UI in an isolated compatibility document.

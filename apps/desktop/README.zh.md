# SuperDsh 桌面产品

产品源码集中在本目录，只有 UI 和 Core 两个业务包，Harness 是内置必需引擎插件。

| 开发内容                                         | 入口                                        |
| ------------------------------------------------ | ------------------------------------------- |
| 应用根、导航、聊天、工作流、设置、插件和辅助窗口 | [ui/src](ui/src/)                           |
| 产品状态、服务、Electron、Preload 与生命周期     | [core/src](core/src/)                       |
| DSH 启动、Profile 和运行时协议                   | [plugins/harness/src](plugins/harness/src/) |
| 构建、回归与平台打包                             | [scripts](scripts/)                         |

环境准备与开发命令统一见根 [README](../../README.md#日常开发)，验证和打包见[检查与打包](../../README.md#检查与打包)，具体界面入口见 [UI 组件索引](ui/README.md)。产品就绪门槛、兼容容器和分层约束见[架构](../../docs/architecture.md)。

旧桌面、原工作空间目录、未使用的 `shared` 副本和旧构建配置已于 2026-09-28 物理移除。源码快照和清理记录保存在仓库 `.superdsh-work`，详见[迁移记录](../../docs/superdsh-migration-validation.md)。开发和发布仅使用当前产品。

[English](README.md) · [Anywhere Labs MIT](LICENSE) · [DeepSeek MIT](LICENSE.upstream)

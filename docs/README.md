# SuperDsh 文档

[English documentation](README.en.md)

开发从根目录的 [README](../README.md) 开始：[上游来源](../README.md#基于哪些项目改造)、[设计理念](../README.md#设计理念)、[当前进度](../README.md#目前完成进度)，以及项目结构、启动、联调和检查命令统一在那里维护。贡献流程见 [CONTRIBUTING](../CONTRIBUTING.md)。

## 开发专题

| 文档                                         | 内容                                    |
| -------------------------------------------- | --------------------------------------- |
| [桌面 UI 索引](../apps/desktop/ui/README.md) | 界面组件、功能目录与修改入口            |
| [服务端说明](../apps/server/README.md)       | API、开发配置、数据库迁移与 Docker 部署 |
| [安卓本地开发](android-local-development.md) | SDK、Gradle、AVD、启动参数与模拟器联通  |

## 使用说明

[用户指南](user-guide.md) · [常见问题](faq.md) · [隐私政策](../PRIVACY.zh.md)

## 设计参考与历史 RFC

设计资料保留各自说明的范围；历史 import、API 示例与 RFC 草案不是当前产品依赖或已完成能力。

- 桌面参考：[架构](architecture.md)、[设计取舍](why-desktop.md)、[Desktop service 归档](legacy-desktop/README.md)。
- 插件参考：[生态倡议](plugin-ecosystem.md)、[插件开发](plugin-development.md)。
- Fabric：[社区 Draft](../dsh-community-fabric/README.zh.md)、[意见处置](../dsh-community-fabric/docs/research/community-issue-23-review.zh.md)、[框架与插件需求调研](../dsh-community-fabric/docs/research/mature-plugin-frameworks.zh.md)、[VS Code 扩展模型调研](../dsh-community-fabric/docs/research/vscode-extension-model.zh.md)。
- 市场：[设计](../dsh-community-market/README.zh.md)、[目录提供方合同](../dsh-community-market/docs/catalog-provider-contract.zh.md)。

## 验收记录

- 工程迁移：[桌面迁移](superdsh-migration-validation.md)、[管理端／服务端／安卓迁移](apps-migration-validation.md)。
- 平台能力：[身份与 RBAC](platform-identity-validation.md)、[桌面原位登录](desktop-inline-login-validation.md)、[服务端 Agent](server-agent-validation.md)。
- Windows 安装：[NSIS A/B 方法](evidence/windows-nsis-ab-methodology.md)、[升级验证](evidence/windows-installer-upgrade-2026-08-25.md)。

验收记录只说明当时的环境、结果与限制，原路径和结论保留。当前启动方式与验证边界以 [README](../README.md#排障与验证边界) 为准；固定上游子模块的文档属于各自项目。

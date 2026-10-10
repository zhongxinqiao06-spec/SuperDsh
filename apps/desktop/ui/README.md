# SuperDsh UI 代码索引

自有界面在本包 `@superdsh/ui`，平台登录和设备交互也由产品组件管理。本地空间的旧 AA 手机绑定及第三方界面仍使用兼容插件产物。运行命令统一见根 [README](../../../README.md#日常开发)，检查见[检查与打包](../../../README.md#检查与打包)，跨层约束见[开发约定与数据](../../../README.md#开发约定与数据)。

## 按功能找组件

| 修改内容                  | 入口                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| React 根、启动与错误状态  | [main.tsx](src/app/main.tsx) → [ProductApp.tsx](src/app/ProductApp.tsx)                                                                     |
| 导航、布局                | [navigation.ts](src/app/navigation.ts) / [AppFrame.tsx](src/app/layout/AppFrame.tsx)                                                        |
| 输入框外壳、文字编辑器    | [InputBar.tsx](src/features/conversation/skeleton/InputBar.tsx) / [DraftEditor.tsx](src/features/conversation/input/editor/DraftEditor.tsx) |
| 消息列表、历史会话        | [ChatView.tsx](src/features/chat/chat/ChatView.tsx) / [WorkspaceBrowser.tsx](src/features/workspace/rows/WorkspaceBrowser.tsx)              |
| 工具卡片、工作流运行展示  | [ToolCallTree.tsx](src/features/tools/tool/ToolCallTree.tsx) / [WorkflowRunPanel.tsx](src/features/workflows/WorkflowRunPanel.tsx)          |
| 通用设置、模型配置        | [SettingsRoot.tsx](src/features/settings/general/SettingsRoot.tsx) / [models](src/features/settings/models/)                                |
| 平台登录、设备、远程交互  | [platform](src/features/platform/)：`PlatformAccountDialog`、`DeviceSelector`、`DeviceSidebar`、`PlatformConversation`                      |
| 桌面设置、手机开关与入口  | [settings.tsx](src/features/desktop/settings.tsx) / [plugin-controls.tsx](src/features/desktop/plugin-controls.tsx)                         |
| 插件管理、社区市场        | [PluginManagerPage.tsx](src/features/plugins/PluginManagerPage.tsx) / [MarketSurface.tsx](src/features/community-market/MarketSurface.tsx)  |
| 引导、Profile、导入与恢复 | [app/native](src/app/native/) + [profiles](src/features/profiles/) / [import](src/features/import/) / [recovery](src/features/recovery/)    |
| 公共组件、主题            | [components](src/components/) / [theme](src/theme/)                                                                                         |

工作流目前是运行展示，不含 DAG 编辑器。完整手机绑定面板见 [AA 插件源码](../../../agents-anywhere/dsh-bridge-next/src/client/features/onboarding/mobile-connection.tsx)，日常产品开发不直接修改上游子模块。

平台账号在当前主窗口的小对话框内登录。默认目标为“本机”，继续使用原主会话和输入框；侧栏切换其他设备后，API v2 会话进入同一主聊天区域，文件与终端始终绑定该设备。切换账号保留当前本地 Home；远程会话不保存为离线缓存。

## 开发边界

- 组件保留局部交互；复用业务状态通过 Core 的 `client/*`，跨进程类型通过 `contracts/*` 引入。桌面设置示例：[settings.tsx](src/features/desktop/settings.tsx) → [desktop-settings-model.ts](../core/src/client/desktop-settings-model.ts)。
- [compatibility/harness](src/compatibility/harness/) 保留 RPC、Remote、Slots 与模块加载。功能目录中的 `shared/` 是协议/模型声明，不是独立工作区。
- 第三方旧界面由 [ExtensionViewHost.tsx](src/compatibility/ExtensionViewHost.tsx) 控制，独立文档 [main.ts](src/compatibility/main.ts) 启动；不能接管产品根。隔离和认证细节见[架构](../../../docs/architecture.md)。

## 构建来源

[source-manifest.json](source-manifest.json) 指定自有模块 → [scripts/build.ts](scripts/build.ts) 构建 → `client-manifest.json` 记录实际资源。缺少自有产物直接报错，不回退上游 UI。

生成目录：`dist/`（产品与兼容页）、`native-ui/`（辅助窗口）、`client/`（动态模块）。不要编辑生成文件；新增模块需更新源码清单。UI 联调使用根 `dev`，重建后会重启后台并刷新；单独静态页面缺少 Host 认证和模块图，无法替代完整联调。

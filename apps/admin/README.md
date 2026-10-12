# SuperDsh 管理端

`apps/admin` 是自有 Next.js + React 统一管理后台，登录默认进入总览；管理员和普通用户使用同一布局，按权限显示用户与权限、模型、设备运维、Agent 工作台、系统管理和个人中心。源码来源见仓库的 AA 导入记录；运行时连接 `apps/server`，桌面 Harness 接入仍由内置 Bridge 负责。

环境准备和启动命令统一见根 [README](../../README.md#日常开发)，三端连接见[三端联调](../../README.md#三端联调)，验证与构建见[检查与打包](../../README.md#检查与打包)。数据库、服务端 Agent 和部署配置见 [Server](../server/README.md)。

## 模块与权限

`features/console/modules.ts` 定义页面、路由、权限与懒加载入口，与 Server `core/navigation.py` 的目录一致。新模块通过两处注册接入，无需修改聊天根组件。`#/access/menus` 支持两级分组、名称、图标、排序、显示和角色范围；接口版本冲突返回 409，隐藏不授予或撤销页面权限。权限不足显示 403，未知页面显示 404；旧管理、设置、设备和会话 Hash 链接继续映射。

管理页不依赖 `WorkspaceProvider`、设备查询或会话 WebSocket。工作台草稿、File 附件、目标和模型选择及发送结果只保留在当前账号的文档内存中；切模块可恢复，换账号清理，整页刷新不持久化附件。升级服务端需执行 `v2_39`，该迁移保留原账号数据并为管理员补齐 `menus.read/manage`。

## 页面交互约定

聊天之外的管理页面使用“筛选工具栏 + 表格或卡片 + 分页”。新增、编辑和需要提交的配置放入 `ManagementDialog`；保存失败保留草稿，取消不提交，删除、阻断、撤销等操作先确认。外观选项保持即时生效。通用弹窗、分页及完整目录的本地分页 Hook 位于 `components/management/presentation.tsx`。

用户、设备运维、审计和登录记录使用 API 的 `page/pageSize/search` 查询，响应包含 `total/page/pageSize`；筛选作用于完整数据，审计可查看超过原先最近 200 条的记录。角色、菜单和供应商完整目录在前端分页，手机登录先筛选手机记录再分页。默认每页 25 条，可切换 10/25/50/100 条。此分页升级无需新数据库迁移，发布时同步更新管理网页与 API；原客户端无分页参数的调用保持兼容。

## 管理端配置

开发网页默认将 `/api/v2` 代理到本机 API；更换目标时，在启动网页前设置 `AGENTS_ANYWHERE_API`。`AGENTS_ANYWHERE_API_NAMESPACE` 默认 `/api/v2`，保持三端一致。`NEXT_DIST_DIR` 可指定独立构建缓存，默认 `.next`；不要把测试缓存或真实凭据提交到源码。

默认本地 `superdsh-dev` 开发库由 `server:deps:up` 初始化管理员 `admin` / `admin123`，`server:dev` 也会补充创建；已有 `admin` 的密码、角色和状态保持不变。显式配置 `AGENT_SERVER_DB_URL`、完整 Docker 和生产部署不自动创建此账号；首次空库仍显示管理员初始化页，使用 API 输出的 setup token 自行设置用户名和密码。

## 功能与部署

“手机连接”直接显示当前账号的手机登录会话，支持刷新和撤销；手机已通过用户名密码登录后无需再次扫码。列表每 15 秒及回到窗口时刷新，扫码入口仅用于添加另一部手机。这里管理登录记录，聊天及历史在 Agent 工作台中。

新会话支持“服务端 Agent / 我的电脑”。网页登录、刷新和读取账号均发送 `X-SuperDsh-Agent-Preparation: deferred`，只在进入工作台后查询并准备 Agent；已有实例复用，失败显式重试。离开工作台清理订阅，不终止已提交任务。原生客户端未发送该标记时仍保持登录后准备。就绪后使用所属 `/workspace`，没有电脑也能聊天；真实执行实例同时出现在设备与会话列表。设置里的“个人模型”支持三种协议、供应商验证与默认模型，Key 只写入。手机、网页和桌面使用同一账号可继续同一服务端会话，复用原消息、附件、审批、文件和终端界面。

本机托管开发库下，默认 `server:dev` 自动准备 Supervisor、API relay 与所需运行镜像；`server:deps:up` 本身仍只启动 PostgreSQL / Redis。前后端各自在本机手动启动；仅开发电脑连接可设置 `SUPERDSH_DEV_AGENT_ENABLED=0`。配置与停止顺序见 [Server](../server/README.md#本机开发)。

完整 Docker 部署由 Python 服务提供静态页面和 API，采用同一地址。首次服务器部署按[从 Git 拉取到 Docker 启动](../server/docker/README.md#服务器首次部署)操作；修改页面后需要手动重建并更新服务，保留原数据卷和密钥文件。

| 开发内容                      | 目录                                                |
| ----------------------------- | --------------------------------------------------- |
| 页面入口、主题与字体          | `src/app`                                           |
| 后台框架、总览、菜单编辑      | `src/components/console`                            |
| 模块注册、Hash 路由、导航 API | `src/features/console`                              |
| 管理页面和权限面板            | `src/components/pages`、`src/components/management` |
| 工作台组装与账号内存状态      | `src/components/demo.tsx`、`src/features/workbench` |
| 登录和 OAuth                  | `src/components/auth`、`src/features/auth`          |
| 会话、设备、实时协议模型      | `src/features`                                      |
| 中文与英文                    | `messages`                                          |
| 协议生成类型                  | `src/generated/protocol/v1`，禁止手改               |

部署到 Python 服务端时设置 `NEXT_OUTPUT=export` 后执行 `build`，产物在 `apps/admin/out`。常规 Next.js 构建后可执行 `start`。包脚本直接调用工具的 Node 入口，避免 Windows 中文路径经过命令包装脚本时乱码。

协议基线读取固定子模块的 `agents-anywhere/contracts/protocol/1.0`；`protocol:generate` 只重建本包类型，不写回子模块。字体文件、固定来源与许可证保存在 `src/app/fonts`，生产构建无需联网下载字体。

本包继承根 Yarn 4.18、格式与 lint 规则，不维护独立锁文件。历史参考和废弃页面保存在 `.superdsh-work/apps-migration-20260928` 的退役快照中，不参与产品构建。生成文件和第三方许可证不做机械格式改写。

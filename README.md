# SuperDsh

SuperDsh 包含桌面 Agent 应用、Next.js + Node.js 全栈管理后台和安卓应用。后台以总览、权限、模型、设备和系统管理为主体，聊天是 Agent 工作台模块；DeepSeek Harness 是由产品调度的必需引擎插件。

**服务器部署：** 拉取代码后在仓库根执行 `docker compose up -d --build`，默认配置自动初始化，访问 `http://服务器IP:5174`。初始账号为 **`admin` / `admin123`**，登录后请修改密码。旧 Compose 部署仍使用原始随机初始密码时，首次升级启动会自动对齐；已经自行修改的密码保留。完整步骤见[Compose 部署与更新](apps/admin/deployment/README.md)。

**日常开发以本页为准。** [English](README.en.md) · [来源](#基于哪些项目改造) · [理念](#设计理念) · [进度](#目前完成进度) · [代码位置](#项目结构) · [启动](#日常开发) · [联调](#三端联调) · [检查](#检查与打包)

## 基于哪些项目改造

| 上游项目                                                                            | 复用基础                                           | SuperDsh 的改造                                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Anywhere Labs / dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)         | Desktop / Next 的 Electron 壳、桌面能力和交互      | 以 Next 为基础整合为唯一桌面产品，收拢 UI / Core，接管应用根、导航和引擎生命周期             |
| [DeepSeek / deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)      | 完整 Host、Agent、工具、工作流、持久化及客户端组件 | 界面迁入自有 UI；`@superdsh/harness` 封装引擎，桌面与服务端共用 Host                         |
| [Anywhere Labs / Agents-Anywhere](https://github.com/anywhere-labs/Agents-Anywhere) | Connector、Bridge、API v2、管理网页和移动客户端    | 导入管理端和安卓；将服务端接口、鉴权、数据库与 Connector 迁入 Node，扩展 RBAC 和服务端 Agent |

Harness 固定版本为 `0.1.7-alpha.2`，见 [upstream.json](upstream.json)；AA 应用导入自 `f9129757c3ee`，见[来源清单](vendor/agents-anywhere/apps-source.json)。固定上游子模块不直接修改，兼容改动通过自有适配层和受控补丁实现。

## 设计理念

- **桌面优先，产品掌握控制权。** SuperDsh 管窗口、导航、账号和状态，Harness 管执行与会话队列，不新增第二套引擎。
- **按职责找代码。** 桌面界面进 UI，业务与原生能力进 Core，Harness 接入进插件；管理网页与 Node 服务统一在 `apps/admin`。
- **后台与工作台分离。** 一级菜单「智能体管理」下设「智能体列表、知识库、技能管理、工具管理」四个二级菜单，各自配置后由智能体关联；发布到同一主聊天，创建会话时固定知识、技能和工具配置版本。
- **同一会话，两类执行目标。** 三端通过 API v2 访问自己的电脑或服务端 Agent；手机不内置 Harness，服务端模式无需电脑在线。
- **身份与模型授权分离。** 平台账号管理资源和远程访问；DeepSeek / 个人 Key 提供模型能力。桌面保留本地 Home，平台登录不重启应用。
- **资源归属优先。** 内置管理员、普通用户并支持自定义角色。管理员不能读取他人内容；原生 Agent 按用户分目录与鉴权，但同一系统用户下的进程不构成操作系统沙箱。

当前面向**单企业试用，不是完整企业多租户系统**。已发布智能体及其绑定资料在本平台共享；个人会话与成果仍按用户鉴权。公司租户、员工邀请、企业独立知识库、任意脚本直接执行、钉钉/企微接入尚未实现；不新增设备共享、多引擎、第二套队列或 DAG 编辑器。

## 目前完成进度

**2026-11-07 技能底座更新：** 技能管理支持自动匹配规则、阶段草稿与发布、独立运行记录和按真实工具结果校验。PPT／Word 共用可配置流程，仍由 DSH 执行；旧智能体与会话不被改写，可选择新流程技能并重新绑定。真实 Agent Plan 模型在隔离环境生成了 6 页 PPT 和 5 页 Word，网页、桌面同一会话的记录、预览、下载及文件摘要一致，Microsoft Office 实际打开并逐页检查；原数据和 DeepSeek 配置未改动。启用方式见[技能开发说明](docs/agent-extension-development.md#自动匹配阶段与运行记录)，范围与限制见[验收记录](docs/office-assistants-validation.md#2026-11-07通用分阶段技能与真实双端验收)。

**2026-11-03 底座进展：** 已接入聊天／多模态独立配置、火山适配器、冻结能力绑定、统一文件服务和源码固定的 MinIO。管理端生产构建、安卓静态检查与 Debug APK 构建通过；真实 DeepSeek 返回 HTTP 200。火山 401 已定位为 Agent Plan Key 与按量地址混用；套餐地址聊天实测 HTTP 200，真实生图／编辑／视觉及完整三端实机链路仍未验收；本轮没有更新现有部署。MinIO 固定源码镜像与隔离文件测试通过；完整平台 Linux 镜像因基础镜像下载停滞未完成，见[本轮验证记录](docs/office-assistants-validation.md#2026-11-03-模型与文件底座验证)。

**2026-10-31 开发进展：** 已加入可配置扩展／MCP 工具、技能包导入、Word、PPT 结构化版式及 JSON 可靠配图。DeepSeek 通过工具调用提交 JSON，程序绘图并作为会话素材写入 PPT／Word，无需另配生图模型。真实 Host 已完成确认、绘图、嵌图、预览与下载回归；PPT／Word 40 项确定性任务通过。真实 DeepSeek、安卓设备交互与本轮 Linux 镜像验收尚未完成，不替代下述历史验收。

**2026-10-19：三个通用办公助手的代码及确定性链路已落地，支持输入检查、确认方案、成果版本和混合知识检索。** Excel 34、PPT 23、真实 ONNX/Qdrant 检索 20 个脱敏场景通过，网页及真实 Host／Connector 回归通过；Linux 镜像构建、断网模型/中文 PPT 渲染、42 项容器内检查及部署启动登录已通过。真实商业聊天模型、Office 客户端和客户生产环境仍未验收，见[完整记录与限制](docs/office-assistants-validation.md)。旧 Python 后端 `apps/server` 已物理删除，由 `apps/admin/server` 替代。

| 范围            | 当前状态与边界                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面产品        | UI / Core / Harness 已拆分；原位登录、固定 Home、主聊天设备切换已有[阶段记录](docs/desktop-inline-login-validation.md)                  |
| 管理后台        | 独立总览、权限菜单、弹窗编辑与分页；Agent 工作台按需加载，不依赖聊天才能进入管理页面                                                    |
| Node API 与数据 | 身份、RBAC、菜单、设备、会话、文件、终端、模型和数据库访问迁入 `apps/admin/server`，保留 API v2；支持空库及 `v2_35` 至 `v2_46` 增量迁移 |
| 办公智能体      | Excel 多表处理与受控计算、PPT 结构化方案、来源证据、可修订成果及发布前检查已接入；真实模型与 Office 客户端结果需单独验收                |
| 身份与管理验证  | 临时 PostgreSQL 上完成登录轮换、归属、最后管理员、菜单并发和迁移回滚测试；不操作现有用户库                                              |
| 服务端 Agent    | Node Connector + 完整 Harness 本机进程，按用户保存 Home 与运行租约；原生及 Compose 部署均保留受管子进程，不单独创建每用户 Agent 容器    |
| 模型与跨端      | 三种协议、个人/平台模型及默认选择已接入；真实付费模型、当前安卓界面和三端完整交互仍需对应环境复验                                       |
| 发布            | 当前源码检查与临时环境测试不等于 Windows 安装包、CentOS、macOS/Linux、签名或更新验收                                                    |

**2026-10-15 历史验证：** Next 无头浏览器 + 真实 API/Host、桌面无头界面 + 真实 Host + 受控平台 API，以及管理端构建、Node 服务和布局检查通过。使用**本地测试模型**的销售案例收入分别为 260 / 777，重启后会话仍绑定 v2，知识回答带出处。临时环境已清理；该记录不覆盖本轮通用办公能力、真实付费模型、桌面真实 GUI 或安卓新增入口。

**模型中心后续工作：** 统一连接、聊天／多模态配置和能力授权已落地；桌面快捷配置及 9router / Codex 授权接入仍是后续工作，当前启动不会安装这些服务。历史证据见[文档索引](docs/README.md#验收记录)。

## 项目结构

| 修改内容                               | 位置                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 桌面根、导航、聊天、设置与主题         | [apps/desktop/ui](apps/desktop/ui/)：`src/app`、`features`、`components`、`theme`                                                 |
| 桌面业务、窗口、IPC、权限与更新        | [apps/desktop/core](apps/desktop/core/)：`src/main`、`preload`、`client`、`services`、`contracts`                                 |
| Harness 启动、Profile、协议适配        | [apps/desktop/plugins/harness](apps/desktop/plugins/harness/)：`src/host`、`host-runtime.ts`、`server-profile.ts`                 |
| 管理网页、总览与工作台                 | [apps/admin/src](apps/admin/src/)：`components/console`、`features/console`、`features/workbench`                                 |
| API、鉴权、RBAC、设备与数据库          | [apps/admin/server](apps/admin/server/)：`identity`、`management`、`devices`、`conversations`、`files`、`infrastructure`          |
| 平台/个人模型、服务端 Agent            | Server 的 `models`、`runtime`；Node Connector、模型网关与完整 Host 生命周期                                                       |
| 业务智能体、知识与 Office 成果         | `apps/admin/server/agents`；网页 `src/features/agents`、`components/management/agents-panel.tsx`；桌面 `ui/src/features/platform` |
| PG / Redis / Qdrant / MinIO 与部署说明 | [apps/admin/deployment](apps/admin/deployment/)；根 Compose 可一键部署完整平台                                                    |
| 安卓页面、网络与中文                   | [apps/android](apps/android/)：`app/src/main/java/com/agentsanywhere/app`；文案在 `app/src/main/res/values-zh-rCN`                |

`apps/desktop` 负责桌面组装与发布。管理网页模块注册在 `src/features/console/modules.ts`，服务端权限目录在 `server/management/navigation.ts`；管理模块不依赖聊天 `WorkspaceProvider`。固定上游在 `deepseek-harness`、`agents-anywhere`，iOS 仅保留上游参考。

## 环境准备

以下为源码开发环境；只部署服务器使用 [Docker Compose](apps/admin/deployment/README.md)，宿主机无需 Node、Yarn 或子模块初始化。开发命令均在**仓库根目录**执行；Windows 使用 `corepack.cmd`，macOS/Linux 换成 `corepack`。

| 内容       | 环境                                                                                 |
| ---------- | ------------------------------------------------------------------------------------ |
| 桌面与平台 | Git、Node 24.x、Corepack、Yarn 4.18                                                  |
| 本地数据库 | Docker Linux 引擎运行开发 PG / Redis / Qdrant / MinIO；已有数据库可显式配置地址      |
| 安卓       | JDK 17、Android SDK 36、Build Tools 34.0.0；模拟器另需 Emulator、Platform Tools、AVD |

```powershell
git submodule update --init --recursive
node scripts/prepare-aa-source.mjs
corepack.cmd yarn install --immutable
```

源码准备应用 AA 稀疏检出，排除已迁出的旧应用，不要恢复旧路径。Node 平台与服务端 Agent 不依赖 Python；桌面旧 Connector 或特定 Agent 工具仍可按自身需求使用 Python。

## 日常开发

### 桌面

```powershell
corepack.cmd yarn dev
```

先构建，再启动 Electron 与 UI 监听。**UI 重建会重启后台并中断运行中的任务**；Core、Preload、Harness 修改后退出再启动。只运行已有产物用 `start`，源码变动先 `build`。这与平台账号原位登录的行为不同。

### 管理网页、Node API 与服务端 Agent

首次准备依赖和 Harness，然后一条命令启动整个平台：

```powershell
corepack.cmd yarn server:sync
corepack.cmd yarn server:deps:up
corepack.cmd yarn server:knowledge:prepare
corepack.cmd yarn server:dev
```

`server:deps:up` **只启动 PostgreSQL / Redis / Qdrant / MinIO 容器**；`server:dev` 在本机启动 Next.js、Node API 和 Agent 生命周期管理。用户需要服务端 Agent 时自动启动完整 Harness 子进程，无需 Supervisor、Python API 或额外 Agent 命令。`admin:dev` 是同一入口的别名，不要同时启动。

`server:knowledge:prepare` 提前下载并校验固定版 `bge-small-zh-v1.5` ONNX，已有正确文件直接复用；只使用聊天可暂不准备。模型保存在 Agent 数据目录的 `models` 下，可用 `SUPERDSH_EMBEDDING_MODEL_DIR` 指定目录。首次提问不会临时联网下载；Compose 镜像在构建时准备该模型。

| 服务                                  | 默认地址                                                  |
| ------------------------------------- | --------------------------------------------------------- |
| 管理网页与 API                        | [http://127.0.0.1:5174](http://127.0.0.1:5174)            |
| 兼容 API 监听（同一后端、同一数据库） | `http://127.0.0.1:8000`                                   |
| 就绪检查                              | `http://127.0.0.1:5174/api/v2/health/ready`               |
| PostgreSQL / Redis / Qdrant（仅本机） | `127.0.0.1:15432` / `127.0.0.1:16379` / `127.0.0.1:16333` |

默认 `superdsh-dev` 开发空库和默认 Compose 全新部署均创建 **`admin` / `admin123`**。Compose 可覆盖首次账号密码，并将首次凭据保存在配置卷；旧 Compose 初始密码首次升级时自动兼容，已经自行改过的密码与账号状态保留，登录后请修改默认密码。原生模式的显式数据库和生产空库使用启动日志的 **setup token** 初始化管理员。登录进入总览，进入 Agent 工作台才准备网页 Agent；桌面、安卓沿用登录后准备。

开发配置在被 Git 忽略的 `.superdsh-work/server-dev/aa-dev.env`。重复 `server:deps:up` 跳过健康依赖；其他程序占用默认端口时选择空闲端口并写回配置，显式指定的端口不自动修改，以输出为准。Qdrant 默认 `http://127.0.0.1:16333`，可通过 `SUPERDSH_DEV_QDRANT_PORT` 改端口，或用 `SUPERDSH_QDRANT_URL` / `SUPERDSH_QDRANT_API_KEY` 连接现有实例。已有数据卷而配置丢失时必须恢复原文件，不能生成新密钥覆盖。

对 `server:dev` 按 `Ctrl+C` 停止网页、API 和所属本机 Agent；再运行 `corepack.cmd yarn server:deps:down` 只停止 PG / Redis / Qdrant / MinIO，保留卷。`server:dev:agents` 仅是兼容别名；`server:down` 提示停止终端或系统服务，不再操作应用容器。

已有数据库需同时设置 `AGENT_SERVER_DB_URL`、`AGENT_SERVER_REDIS_URL` 及原鉴权/模型加密密钥，不自动创建开发账号。默认网页端口由 `SUPERDSH_SERVER_PORT` 控制，兼容 API 用 `AGENT_SERVER_PORT`。统一入口无需 `AGENTS_ANYWHERE_API` 代理配置；清除遗留 `NEXT_OUTPUT=export`。详细配置见[服务端说明](apps/admin/server/README.md)。

### 新管理端 Vue 与 Python

新实现位于 `apps/web-admin/fronted` 和 `apps/web-admin/backend`，与旧管理端独立运行。后端遵循若依 `controller → service → dao` 分层，DSH 保持固定执行引擎。启动、独立 Docker 部署、初始化和测试清理见 [Web Admin 开发说明](apps/web-admin/README.md)，实施状态见[第一份计划](docs/plans/web-admin-01-foundation.md)。

```powershell
corepack.cmd yarn web-admin:sync
corepack.cmd yarn web-admin:deps:up
corepack.cmd yarn web-admin:dev
```

### 安卓

Android Studio 打开 `apps/android`；准备 SDK / AVD 后：

```powershell
corepack.cmd yarn android:build
corepack.cmd yarn android:start --server http://127.0.0.1:8000
```

启动脚本安装已有 Debug APK 并打开 App，不构建或启动服务。`--server` 只做健康检查和模拟器映射，**不改写 App 保存的地址**；登录页填写同一地址。覆盖安装沿用原签名以保留账号和中文设置，环境说明见[安卓专题](docs/android-local-development.md)。

## 三端联调

```text
桌面本地：Core → 后端子进程 → Harness → 本机会话
电脑执行：网页 / 安卓 / 桌面 → Node API v2 → 电脑 Connector → Harness
服务端执行：三端 → 同一 Node API v2 → Node Connector → 本机 Harness 子进程
```

**电脑模式：** 启动平台和桌面，在桌面账号菜单填写平台地址与账号；自动连接本机并同步会话，安卓和网页用同一账号选择该电脑。手机登录记录不是执行设备，无需额外扫码。远程文件和终端始终绑定所选电脑。

**服务端模式：** `server:dev` 已包含运行能力；网页进入工作台后准备，复用已就绪实例，失败显示诊断与重试。个人中心 → 个人模型 → 添加供应商默认预填 DeepSeek，配置 Key 和默认模型后发送；已有会话保留原模型选择，失效时需主动更换。Agent 在线或模型验证成功不等于已收到回复。

桌面可独立使用本机 DeepSeek / API Key。平台登录、退出或切换不重启 Harness；运行任务中的切换需要确认。服务端任务不依赖手机登录令牌，关闭手机或离开网页工作台不终止任务；停止整个平台进程会回收其 Agent。

| 客户端              | 平台地址与网络                                                                          |
| ------------------- | --------------------------------------------------------------------------------------- |
| 本机桌面 / 网页     | `http://127.0.0.1:5174`；原客户端 `8000` 仍访问同一后端                                 |
| 安卓模拟器          | `http://127.0.0.1:8000`，对应 `adb reverse tcp:8000 tcp:8000`；使用 `5174` 时映射该端口 |
| 真实手机 / 其他电脑 | 可达的局域网或 HTTPS 平台地址；不能使用另一台电脑的 `127.0.0.1`                         |

网页切模块保留当前账号内存草稿、待上传附件和发送结果，释放工作台订阅；刷新或换账号清理临时状态。手机离线可查看已缓存历史、保存草稿，恢复后手动发送。

生产部署从 Git 获取源码后，在仓库根运行 `docker compose up -d --build`，默认网页、桌面和安卓统一连接 `5174`。数据库连接、鉴权 / 加密密钥和首次管理员自动初始化并保存在独立持久卷；日常更新执行 `git pull --ff-only origin main` 后再次运行同一 Compose 命令。完整步骤与备份见[服务器部署](apps/admin/deployment/README.md#服务器首次部署)。原有 `SUPERDSH_SERVER_ENV` + `server:start` / systemd 方式继续见[原生部署](apps/admin/deployment/native.md)。

## 智能体演示与开发入口

1. 按上文启动平台；先在「个人中心 → 个人模型」配置可用 Key 和默认模型，或使用管理员配置的平台默认模型。模型必须支持工具调用；演示初始化不提供模型额度，也不替你配置 Key。
2. 有 `agents.manage` 权限的账号首次进入资源管理页，保存 Excel、PPT、知识、Word 四个可编辑助手及脱敏资料。未修改的旧示例按版本原位升级；已编辑或删除的内容保留其状态。「复制新版示例」另外创建四个待发布副本，不覆盖原记录。只有用户明确选择演示资料时才使用它们。
3. 在「智能体管理」的知识库、技能、工具三个独立二级页面配置资源；再在「智能体列表」关联用途、推荐指令、输入要求及输出示例。「配置检查」列出缺失资源和警告；「试用」打开主工作台并准备草稿，不自动发送，也不覆盖已有草稿。支持范围见[服务端说明](apps/admin/server/README.md#智能体资料与-office-模板)。
4. 网页、桌面或安卓主聊天选择服务端目标和助手，上传或明确选择自己的资料。Excel/PPT/Word 和 JSON 配图先展示来源、口径、字段或页面安排，用户通过同一方案确认卡确认后生成；修改方案须重新确认。知识问答直接返回可打开的证据。聊天内预览、下载或请求修改成果，新版本保留原文件；已有会话保留冻结配置。

| 脱敏示例       | 可直接发送的请求                                   | 依据与产物                                                |
| -------------- | -------------------------------------------------- | --------------------------------------------------------- |
| Excel 办公助手 | 汇总我上传的费用表，按部门分组，保留明细及计算口径 | 多文件/工作表、清洗关联、精确计算、受控公式与可编辑图表   |
| PPT 演示助手   | 根据我上传的公司资料，先给出客户介绍演示提纲       | 确认受众、页数、提纲及模板区域，生成可编辑 PPT 和逐页预览 |
| 企业知识助手   | 根据公司制度说明报销要求，标明原文；没有依据请直说 | 混合检索，证据关联标题、段落、PDF 页或表格行号            |
| Word 文档助手  | 用我提供的公司资料编写正式方案书                   | A4 章节、目录、可编辑表格、配图、引用与修订记录           |

三端均已接入助手选择、方案、成果及下载入口；安卓新增预览和系统分享，实机结果另记。产品智能体只在服务端执行；单份输入不超过 4 MiB，必须属于当前会话可访问的资料、附件或历史成果，不接受任意路径。Excel 由程序计算，不虚构成本或合计不同币种；模板支持范围和不兼容对象须在执行前确认，不保证任意 Office 文件无损编辑。

知识支持文本、Markdown、DOCX、CSV、XLSX、文字型 PDF；不支持扫描件 OCR。PostgreSQL 保存原文及位置，Qdrant 用稠密向量与关键词经 RRF 合并检索。默认本地固定 Embedding，也可单独配置外部兼容接口；外发地址须由部署侧信任名单批准，配置者须同时具有模型与智能体管理权限，详见[部署说明](apps/admin/deployment/README.md)。不自动换供应商。知识库显示每份资料索引状态与重试；未准备模型或 Qdrant 不可用会明确报错。技能可导入 SKILL.md、参考文件和模板；可执行脚本必须单独安装并授权为工具，不能靠提示词绕过执行权限。

## 模型与文件底座

- **模型管理 → 聊天模型／多模态模型**：先配置供应商连接，再填写模型 ID、能力、参数及默认值。方舟与语音凭据分开；新增能力服务中的语音／视频／向量化明确不可用，已有知识 Embedding 仍独立工作。
- 在工具管理给 `image_generate`、`vision_analyze` 选择模型配置，再授权给助手。密钥只保存在服务器；会话冻结配置版本，改默认仅影响新绑定。`illustration_render` 继续支持 JSON 确定性配图；已受理结果可恢复转存，不重发收费生成。
- **个人中心 → 我的文件**支持上传、版本、鉴权下载及回收站；**系统管理 → 文件存储**管理连接与策略，不能借运维权限读他人内容。默认上传 32 MiB、暂存 24 小时、回收站 30 天；Office 解析器另有输入限制。
- 开发 MinIO API／控制台：`http://127.0.0.1:19000`／`http://127.0.0.1:19001`。新环境默认私有桶，已有环境保留原存储，切换前按[存储升级与恢复](apps/admin/deployment/README.md#minio-与文件存储升级)迁移验证。
- `server:files` 检查旧附件及数据库知识原文，`--apply` 建立映射并保留源；执行前停止平台。`server:models:init` 检查本机私有初始化 JSON，`--apply` 仅补缺失连接，不覆盖凭据或默认值。文件放被忽略的 `.superdsh-work/server-dev/model-initialization.json`，不进入源码或镜像。

## 检查与打包

以下命令接在 `corepack.cmd yarn` 后，仍在仓库根执行：

| 范围               | 命令                                                   | 用途                                                    |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------- |
| 桌面               | `build` / `start` / `workspace @superdsh/ui build`     | 完整构建 / 启动产物 / 单独 UI                           |
| 代码质量           | `typecheck` / `lint` / `format:check` / `test`         | 桌面类型、统一规范与测试                                |
| 桌面集成           | `check` / `check:ui`                                   | 工程与 Host / 无头界面                                  |
| 管理网页           | `admin:check` / `admin:build`                          | 网页类型、测试、协议 / 网页构建                         |
| Node 服务          | `server:check` / `server:test`                         | 类型、测试、lint / 测试                                 |
| 数据库与 Host 集成 | `server:test:integration`                              | 临时 PG / Redis / Qdrant、API 和原生运行链路，需 Docker |
| 平台发布           | `server:build` / `server:start`                        | 构建 Harness 与 Next / 本机生产启动                     |
| 安卓               | `android:check` / `android:test` / `android:build`     | 静态约束 / JVM / Debug APK                              |
| 桌面发布           | `package:dir` / `dist:win` / `dist:mac` / `dist:linux` | 解包应用 / 对应系统产物                                 |
| 布局               | `sources:check` / `check:layout`                       | 固定上游与产品边界                                      |

根 `dev/build/start/check` 默认仍是桌面，不能替代其他应用检查。没有临时数据库时，数据库测试明确跳过，不能当作集成通过。首次无头 UI 检查需安装 Chromium 并先构建。桌面包在 `apps/desktop/dist`，安卓 APK 在 `apps/android/app/build/outputs/apk/debug/app-debug.apk`。

## 开发约定与数据

- UI 只导入 Core 的公开 `client/*`、`contracts/*`；网页组件不导入 `server` 的凭据、数据库和进程实现。第三方旧界面使用独立兼容容器。
- 两空格、单引号、无普通行尾分号；组件 PascalCase，普通模块 kebab-case，以 Prettier 为准。自有工程用根 Yarn；不改生成类型或固定上游。
- 桌面开发 Home 默认 `.superdsh/home`，安装版为系统应用数据目录 `SuperDsh/home`；账号切换不换 Home，平台凭据/绑定/检查点按稳定账号分别保存。
- 平台开发 Agent 数据在 `.superdsh-work/server-dev/native`；Compose 使用 `platform-data` 卷的 `/data/runtime`，原生生产默认 `.superdsh-work/server-native`，可设 `SUPERDSH_SERVER_DATA_DIR`；文件存储沿用 `AGENT_SERVER_FILES_LOCAL_ROOT`。旧容器 Home 不自动合并。
- 数据库迁移保留账号 ID、密码、归属和密文。支持本产品 `v2_35` 至 `v2_46`；`v2_40–42` 增加资源、定义、会话绑定、成果及四个管理菜单，`v2_43` 增加办公方案和会话证据、资料位置元数据；`v2_44` 增加扩展／资源版本、受保护凭据和会话绑定历史；`v2_46` 增加技能执行与阶段事件记录；更早数据库需先用原版本升级，不能直接标记为新版本。
- 数据导入只写空目标、保留源和备份；授权、Key、环境变量、`.credentials.yaml`、设备绑定不复制。数据库卷和配套鉴权/加密密钥必须一同备份。
- 原生 Agent 共享宿主系统权限，不提供容器沙箱；模型密钥不下发客户端，管理员运维权限不能绕过账号内容隔离。细则见 [AGENTS.md](AGENTS.md)。

## 排障与验证边界

| 现象                  | 检查                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Docker 管道不存在     | Compose 部署、开发数据库和临时集成测试需 Docker；用 `docker info` 确认 Linux 引擎                                    |
| 网页不可达 / 端口冲突 | 只运行一份 `server:dev`；`5174` 网页/API、`8000` 兼容 API，不再等待 `15174` 容器                                     |
| 登录失败              | 核对数据库和环境地址；默认账号不覆盖已有密码；Compose 查看初始密码文件或按部署文档显式重置，原生空库使用 setup token |
| Agent 无法准备        | 先 `server:sync` 构建 Harness，查看诊断与目录权限；不要启动旧 Python/Supervisor                                      |
| 在线却无回复          | 核对个人/平台模型、会话选择和执行错误；内置模型名称不等于已有授权                                                    |
| 模型地址非公网        | 按[服务端配置](apps/admin/server/README.md#模型与网络)核对精确 origin，避免宽泛放行                                  |
| 中文路径工具报错      | 用工作区脚本的 Node 入口，避免批处理包装器破坏编码                                                                   |
| 安卓还连接旧地址      | 检查 App 保存的地址、签名和对应 `adb reverse`，启动参数不会自动改地址                                                |

源码检查、临时数据库、测试模型、真实 Host、无头界面与手机实机分别记录。历史验收文档保留原路径和结果；当前版本的签名、干净系统和真实多端回归须另外验收。

## 专题与许可

- [桌面组件索引](apps/desktop/ui/README.md)：聊天、设置、设备组件。
- [服务端部署与配置](apps/admin/server/README.md)：Node 模块、数据迁移、模型与部署入口。
- [安卓环境与模拟器](docs/android-local-development.md)：SDK、AVD、Gradle 与设备连接。

保留 [MIT 许可证](LICENSE) 及上游和第三方许可、署名。SuperDsh 为独立社区开发，与 DeepSeek 不存在官方隶属或背书关系。

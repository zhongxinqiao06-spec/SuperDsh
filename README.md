# SuperDsh

SuperDsh 包含桌面 Agent 应用、Next.js + Node.js 全栈管理后台和安卓应用。后台以总览、权限、模型、设备和系统管理为主体，聊天是 Agent 工作台模块；DeepSeek Harness 是由产品调度的必需引擎插件。

**服务器部署：** 拉取代码后在仓库根执行 `docker compose up -d --build`，默认配置自动初始化，访问 `http://服务器IP:5174`。首次管理员密码用 `docker compose exec platform cat /data/config/initial-admin.txt` 查看；完整步骤见[Compose 部署与更新](apps/admin/deployment/README.md)。

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

当前是**单平台演示版，不是完整企业多租户系统**。已发布智能体及其绑定资料在本平台共享；个人会话与成果仍按用户鉴权。公司租户、员工邀请、企业独立知识库、任意技能上传、钉钉/企微接入尚未实现；不新增设备共享、多引擎、第二套队列或 DAG 编辑器。

## 目前完成进度

**截至 2026-10-15：智能体管理、真实资料上传、主聊天与 Office 成果链路已完成临时环境验证。** 旧 Python 后端 `apps/server` 已物理删除，由 `apps/admin/server` 替代；正式发布仍需对应系统检查。

| 范围            | 当前状态与边界                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面产品        | UI / Core / Harness 已拆分；原位登录、固定 Home、主聊天设备切换已有[阶段记录](docs/desktop-inline-login-validation.md)                  |
| 管理后台        | 独立总览、权限菜单、弹窗编辑与分页；Agent 工作台按需加载，不依赖聊天才能进入管理页面                                                    |
| Node API 与数据 | 身份、RBAC、菜单、设备、会话、文件、终端、模型和数据库访问迁入 `apps/admin/server`，保留 API v2；支持空库及 `v2_35` 至 `v2_42` 增量迁移 |
| 业务智能体      | 真实 Node API、PG/Redis、Connector、完整 Host 与本地工具调用测试模型完成上传、生成、下载、知识出处和重启后版本保留验证                  |
| 身份与管理验证  | 临时 PostgreSQL 上完成登录轮换、归属、最后管理员、菜单并发和迁移回滚测试；不操作现有用户库                                              |
| 服务端 Agent    | Node Connector + 完整 Harness 本机进程，按用户保存 Home 与运行租约；原生及 Compose 部署均保留受管子进程，不单独创建每用户 Agent 容器    |
| 模型与跨端      | 三种协议、个人/平台模型及默认选择已接入；真实付费模型、当前安卓界面和三端完整交互仍需对应环境复验                                       |
| 发布            | 当前源码检查与临时环境测试不等于 Windows 安装包、CentOS、macOS/Linux、签名或更新验收                                                    |

本轮分别验证：Next 无头浏览器 + 真实 API/Host 的管理操作与主聊天；桌面无头界面 + 真实 Host + 受控平台 API 的选择、固定版本及成果下载；管理端生产构建、Node 服务检查和布局检查均通过。运行链路使用**本地测试模型**：管理上传 CSV 的 Excel/PPT 收入为 260，重启后旧会话仍绑定 v2，聊天新附件收入为 777，未误用绑定台账；知识回答带原文出处。临时环境已清理，未验证真实付费模型、桌面真实 GUI 或安卓新增入口。

**模型中心规划（尚未实现）：** 统一供应商连接、模型目录和使用授权，提供桌面快捷配置；9router / Codex 授权接入仍是后续工作，当前启动不会安装这些服务。历史证据见[文档索引](docs/README.md#验收记录)。

## 项目结构

| 修改内容                        | 位置                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 桌面根、导航、聊天、设置与主题  | [apps/desktop/ui](apps/desktop/ui/)：`src/app`、`features`、`components`、`theme`                                                 |
| 桌面业务、窗口、IPC、权限与更新 | [apps/desktop/core](apps/desktop/core/)：`src/main`、`preload`、`client`、`services`、`contracts`                                 |
| Harness 启动、Profile、协议适配 | [apps/desktop/plugins/harness](apps/desktop/plugins/harness/)：`src/host`、`host-runtime.ts`、`server-profile.ts`                 |
| 管理网页、总览与工作台          | [apps/admin/src](apps/admin/src/)：`components/console`、`features/console`、`features/workbench`                                 |
| API、鉴权、RBAC、设备与数据库   | [apps/admin/server](apps/admin/server/)：`identity`、`management`、`devices`、`conversations`、`files`、`infrastructure`          |
| 平台/个人模型、服务端 Agent     | Server 的 `models`、`runtime`；Node Connector、模型网关与完整 Host 生命周期                                                       |
| 业务智能体、知识与 Office 成果  | `apps/admin/server/agents`；网页 `src/features/agents`、`components/management/agents-panel.tsx`；桌面 `ui/src/features/platform` |
| PG / Redis / Qdrant 与部署说明  | [apps/admin/deployment](apps/admin/deployment/)；根 Compose 可一键部署完整平台                                                    |
| 安卓页面、网络与中文            | [apps/android](apps/android/)：`app/src/main/java/com/agentsanywhere/app`；文案在 `app/src/main/res/values-zh-rCN`                |

`apps/desktop` 负责桌面组装与发布。管理网页模块注册在 `src/features/console/modules.ts`，服务端权限目录在 `server/management/navigation.ts`；管理模块不依赖聊天 `WorkspaceProvider`。固定上游在 `deepseek-harness`、`agents-anywhere`，iOS 仅保留上游参考。

## 环境准备

以下为源码开发环境；只部署服务器使用 [Docker Compose](apps/admin/deployment/README.md)，宿主机无需 Node、Yarn 或子模块初始化。开发命令均在**仓库根目录**执行；Windows 使用 `corepack.cmd`，macOS/Linux 换成 `corepack`。

| 内容       | 环境                                                                                 |
| ---------- | ------------------------------------------------------------------------------------ |
| 桌面与平台 | Git、Node 24.x、Corepack、Yarn 4.18                                                  |
| 本地数据库 | Docker Linux 引擎运行开发 PG / Redis / Qdrant；已有数据库可显式配置地址              |
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
corepack.cmd yarn server:dev
```

`server:deps:up` **只启动 PostgreSQL / Redis / Qdrant 容器**；`server:dev` 在本机启动 Next.js、Node API 和 Agent 生命周期管理。用户需要服务端 Agent 时自动启动完整 Harness 子进程，无需 Supervisor、Python API 或额外 Agent 命令。`admin:dev` 是同一入口的别名，不要同时启动。

| 服务                                  | 默认地址                                                  |
| ------------------------------------- | --------------------------------------------------------- |
| 管理网页与 API                        | [http://127.0.0.1:5174](http://127.0.0.1:5174)            |
| 兼容 API 监听（同一后端、同一数据库） | `http://127.0.0.1:8000`                                   |
| 就绪检查                              | `http://127.0.0.1:5174/api/v2/health/ready`               |
| PostgreSQL / Redis / Qdrant（仅本机） | `127.0.0.1:15432` / `127.0.0.1:16379` / `127.0.0.1:16333` |

默认 `superdsh-dev` 开发空库创建 **`admin` / `admin123`**；已有账号密码与状态不改。原生模式的显式数据库和生产空库使用启动日志的 **setup token** 初始化管理员；默认 Compose 空库则自动创建 `admin` 并持久保存随机密码，无通用生产默认密码。登录进入总览，进入 Agent 工作台才准备网页 Agent；桌面、安卓沿用登录后准备。

开发配置在被 Git 忽略的 `.superdsh-work/server-dev/aa-dev.env`。重复 `server:deps:up` 跳过健康依赖；其他程序占用默认端口时选择空闲端口并写回配置，显式指定的端口不自动修改，以输出为准。Qdrant 默认 `http://127.0.0.1:16333`，可通过 `SUPERDSH_DEV_QDRANT_PORT` 改端口，或用 `SUPERDSH_QDRANT_URL` / `SUPERDSH_QDRANT_API_KEY` 连接现有实例。已有数据卷而配置丢失时必须恢复原文件，不能生成新密钥覆盖。

对 `server:dev` 按 `Ctrl+C` 停止网页、API 和所属本机 Agent；再运行 `corepack.cmd yarn server:deps:down` 只停止 PG / Redis / Qdrant，保留卷。`server:dev:agents` 仅是兼容别名；`server:down` 提示停止终端或系统服务，不再操作应用容器。

已有数据库需同时设置 `AGENT_SERVER_DB_URL`、`AGENT_SERVER_REDIS_URL` 及原鉴权/模型加密密钥，不自动创建开发账号。默认网页端口由 `SUPERDSH_SERVER_PORT` 控制，兼容 API 用 `AGENT_SERVER_PORT`。统一入口无需 `AGENTS_ANYWHERE_API` 代理配置；清除遗留 `NEXT_OUTPUT=export`。详细配置见[服务端说明](apps/admin/server/README.md)。

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
2. 有 `agents.manage` 权限的账号首次进入任一资源管理页，自动保存虚构的“星河商贸”示例：三个智能体、三个知识库、三个技能和三个工具。后续访问复用记录，不覆盖编辑，也不复活已删除的示例。
3. 展开一级菜单「智能体管理」，进入「知识库」（`#/knowledge`）上传资料与模板、「技能管理」（`#/skills`）编辑执行规则及依赖工具、「工具管理」（`#/tools`）设置启用状态与执行参数；再到「智能体列表」（`#/agents`）关联资源并发布。四个二级页面均支持独立列表、搜索、分页和弹窗配置。可先下载演示模板修改，支持范围见[服务端说明](apps/admin/server/README.md#智能体资料与-office-模板)。
4. 网页进入「Agent 工作台」新会话，选择「服务端 Agent」及已发布智能体；桌面登录同一平台，在**原主聊天**选择服务端目标和智能体。发送后从聊天内「生成成果」下载实际 `.xlsx` / `.pptx` 文件；同账号切换客户端可继续原会话。已有会话保留绑定版本，更新配置后需新建会话。

| 脱敏示例          | 可直接发送的请求                                   | 依据与产物                                                        |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| 经营分析助手      | 按销售台账生成经营分析 Excel，比较区域收入和毛利   | 绑定的销售数据与 Excel 模板；程序计算汇总及公式，下载可编辑工作簿 |
| 企业汇报 PPT 助手 | 结合公司介绍与销售数据，按公司模板生成经营汇报 PPT | 绑定知识、台账与受控 PPT 模板；生成可编辑演示文稿                 |
| 企业资料助手      | 公司有哪些服务，售后政策是什么？请标明出处         | 检索绑定资料并返回文件/段落来源；无依据不编造                     |

本轮新增选择与成果入口覆盖网页、桌面；安卓专用智能体选择入口尚未接入。产品智能体只在服务端执行，本机与其他电脑沿用原能力。聊天销售附件支持不超过 4 MiB 的 CSV/XLSX，按已接收的文件名选择，同名不同内容须用哈希消歧；指定附件失败不会退回示例台账。销售计算由工具完成，不把模型直接写出的数字当作核算结果。

知识原文保存在 PostgreSQL，Qdrant 保存可重建的分块索引，采用英文词项与中文双字词项的稀疏检索，无需另配 Embedding Key；当前不提供稠密语义向量召回。知识库页面可检查索引状态并重建；Qdrant 未启动不阻塞管理页面，实际知识检索会明确报错。技能是可维护的执行指令，工具使用已登记实现；不会把上传的任意脚本当作可信工具执行。

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
- 数据库迁移保留账号 ID、密码、归属和密文。支持本产品 `v2_35` 至 `v2_42`；`v2_40` 增加智能体资料、定义、会话绑定与成果记录，`v2_41` 增加独立知识库、技能和工具配置，`v2_42` 将已有相关菜单收拢到「智能体管理」分组；更早数据库需先用原版本升级，不能直接标记为新版本。
- 数据导入只写空目标、保留源和备份；授权、Key、环境变量、`.credentials.yaml`、设备绑定不复制。数据库卷和配套鉴权/加密密钥必须一同备份。
- 原生 Agent 共享宿主系统权限，不提供容器沙箱；模型密钥不下发客户端，管理员运维权限不能绕过账号内容隔离。细则见 [AGENTS.md](AGENTS.md)。

## 排障与验证边界

| 现象                  | 检查                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Docker 管道不存在     | Compose 部署、开发数据库和临时集成测试需 Docker；用 `docker info` 确认 Linux 引擎                    |
| 网页不可达 / 端口冲突 | 只运行一份 `server:dev`；`5174` 网页/API、`8000` 兼容 API，不再等待 `15174` 容器                     |
| 登录失败              | 核对数据库和环境地址；开发默认账号不覆盖已有密码；Compose 查看初始密码文件，原生空库使用 setup token |
| Agent 无法准备        | 先 `server:sync` 构建 Harness，查看诊断与目录权限；不要启动旧 Python/Supervisor                      |
| 在线却无回复          | 核对个人/平台模型、会话选择和执行错误；内置模型名称不等于已有授权                                    |
| 模型地址非公网        | 按[服务端配置](apps/admin/server/README.md#模型与网络)核对精确 origin，避免宽泛放行                  |
| 中文路径工具报错      | 用工作区脚本的 Node 入口，避免批处理包装器破坏编码                                                   |
| 安卓还连接旧地址      | 检查 App 保存的地址、签名和对应 `adb reverse`，启动参数不会自动改地址                                |

源码检查、临时数据库、测试模型、真实 Host、无头界面与手机实机分别记录。历史验收文档保留原路径和结果；当前版本的签名、干净系统和真实多端回归须另外验收。

## 专题与许可

- [桌面组件索引](apps/desktop/ui/README.md)：聊天、设置、设备组件。
- [服务端部署与配置](apps/admin/server/README.md)：Node 模块、数据迁移、模型与部署入口。
- [安卓环境与模拟器](docs/android-local-development.md)：SDK、AVD、Gradle 与设备连接。

保留 [MIT 许可证](LICENSE) 及上游和第三方许可、署名。SuperDsh 为独立社区开发，与 DeepSeek 不存在官方隶属或背书关系。

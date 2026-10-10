# SuperDsh

以桌面为主的 Agent 开发工程，包含桌面、管理网页、Python 服务端和安卓应用。SuperDsh 管产品界面、账号与设备调度，DeepSeek Harness 作为必需引擎插件执行任务。

**日常开发以本页为准。** [English](README.en.md) · [来源](#基于哪些项目改造) · [设计理念](#设计理念) · [进度](#目前完成进度) · [开发入口](#项目结构) · [启动](#日常开发) · [联调](#三端联调) · [检查](#检查与打包)

## 基于哪些项目改造

| 上游项目                                                                            | 复用的基础                                             | SuperDsh 的改造                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [Anywhere Labs / dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)         | Desktop / Next 的 Electron 壳、桌面能力和交互          | 以 Next 为基础整合为唯一桌面产品，收拢 UI / Core，接管应用根、导航和引擎生命周期      |
| [DeepSeek / deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)      | 完整 Host、Agent、工具、工作流、会话持久化及客户端组件 | 界面源码迁入自有 UI；引擎由 `@superdsh/harness` 封装，桌面与服务端共用 Host 启动能力  |
| [Anywhere Labs / Agents-Anywhere](https://github.com/anywhere-labs/Agents-Anywhere) | Connector、Bridge、API v2、管理网页和移动客户端        | 管理端、服务端、安卓迁入 `apps`；扩展统一登录、RBAC、设备控制、个人模型和服务端 Agent |

Harness 固定版本为 `0.1.7-alpha.2`，见 [upstream.json](upstream.json)；AA 应用导入自 `f9129757c3ee`，见[应用来源清单](vendor/agents-anywhere/apps-source.json)。两个上游子模块保持固定，协议兼容修改通过自有适配层和受控补丁完成。旧桌面目录已退出开发与构建。

## 设计理念

- **桌面优先，产品外壳掌握控制权。** SuperDsh 管窗口、导航、账号、设备和状态；DSH 是内部必需插件，负责执行。沿用 Harness 队列，不再造执行引擎。
- **按职责找代码。** 桌面界面进 UI，业务与原生能力进 Core，Harness 接入进插件；管理端、服务端、安卓各自独立开发和构建。
- **一个主聊天，两类执行目标。** 用户选择自己的电脑或服务端 Agent；手机、网页、桌面复用 API v2 和同一所属会话。服务端模式无需电脑在线，Android 不内置 Harness。
- **平台身份与模型授权分离。** 平台账号管理资源和远程访问；DeepSeek / 个人 Key 提供模型能力。桌面保留本地 Home 与模型配置，平台登录不重启应用、不另开聊天窗口。
- **归属隔离与兼容并重。** 内置管理员、普通用户，支持自定义角色；管理权限不授予访问他人内容。服务端实例按用户隔离，保留固定协议和第三方插件兼容入口。

本期不扩展组织租户、设备共享、多引擎、第二套任务队列或新的工作流 DAG 编辑器；先打通现有能力、统一体验和开发入口。

## 目前完成进度

**截至 2026-10-10：核心架构已落地，处于功能联调与稳定性完善阶段，尚未完成正式发布验收。** 下表区分代码实现和实际验证，不用历史测试代替当前版本验收。

| 范围             | 当前进度               | 已有依据与剩余边界                                                                                                                                        |
| ---------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工程与桌面外壳   | 已迁移、已拆分         | 四个应用集中 `apps`，桌面 UI / Core / Harness 分工，旧桌面源码已清理；见[迁移记录](docs/superdsh-migration-validation.md)                                 |
| 桌面登录与主聊天 | 已实现、阶段验证       | 原位密码登录、固定本地 Home、自动连接本机、主聊天设备切换；真实 Host / Connector 与无头 UI 分别验证，见[记录](docs/desktop-inline-login-validation.md)    |
| 平台身份与 RBAC  | 已实现、阶段验证       | 多角色权限、刷新/撤销登录、资源归属、设备封锁及审计；见[身份记录](docs/platform-identity-validation.md)，其中旧账号空间方案已被原位登录替代               |
| 服务端 Agent     | 已实现、持续联调       | 每用户隔离运行，登录后自动准备，真实 Host / Connector 在线已核验；[历史联调](docs/server-agent-validation.md)使用本地测试模型，不代表真实三端界面全部通过 |
| 个人与平台模型   | 已实现、部分验证       | 三种协议、密钥加密、默认模型、DeepSeek 预填已接入；近期真实 Key 连接验证通过，完整聊天回复与错误反馈仍需收尾                                              |
| 安卓与跨端会话   | 已实现、待当前版本复验 | 中文、登录、服务端入口及离线缓存/草稿已有源码和构建记录；[旧版模拟器联通](docs/apps-migration-validation.md)不等于新版本手机实机验收                      |
| 打包与发布       | 有阶段构建，未正式发布 | Windows 中文路径、Docker、桌面目录包、Debug APK 有记录；最新完整安装包、干净系统、macOS/Linux、签名及更新仍需验收                                         |

**下一步优先：** 排查服务端聊天无回复与错误不显示，完善无模型时的提示和可选模型校验；再完成真实 DeepSeek、手机/网页/桌面同会话操作、断线重连与目标切换回归。完整历史证据见[文档索引](docs/README.md#验收记录)。

## 项目结构

| 修改内容                          | 位置与入口                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面应用根、导航、界面与主题      | [apps/desktop/ui](apps/desktop/ui/)：`src/app`、`src/features`、`src/components`、`src/theme`                                                                    |
| 桌面聊天、历史、输入框、工作流    | UI 的 `features/chat`、`conversation`、`workspace`、`workflows`                                                                                                  |
| 桌面平台登录、设备选择、远程聊天  | UI 的 `features/platform`；复用主侧栏、消息组件和输入区                                                                                                          |
| 桌面业务、窗口、IPC、权限与更新   | [apps/desktop/core](apps/desktop/core/)：`src/main`、`preload`、`client`、`services`                                                                             |
| 后端生命周期、导入与跨进程类型    | Core 的 `src/backend`、`application`、`contracts`                                                                                                                |
| Harness 启动、Profile、协议适配   | [apps/desktop/plugins/harness](apps/desktop/plugins/harness/)：`src/host`、`host-runtime.ts`、`profiles.ts`                                                      |
| 管理网页、用户、角色和设备页面    | [apps/admin](apps/admin/)：`src/app`、`src/features`、`src/components`；Next.js / React / TypeScript                                                             |
| API、鉴权、RBAC、消息中转和数据库 | [apps/server](apps/server/)：`agent_server/api`、`services`、`infra`、`migrations`；Python 3.12 / FastAPI                                                        |
| 服务端 Agent 与容器调度           | Server 的 `agent-runtime`、`agent-supervisor`；每用户独立 Harness / Connector                                                                                    |
| 安卓页面、业务、网络与中文        | [apps/android](apps/android/)：`app/src/main/java/com/agentsanywhere/app` 下的 `ui`、`feature`、`api`；文案在 `app/src/main/res/values-zh-rCN`；Kotlin / Compose |

`apps/desktop` 负责产品组装和发布，UI、Core 是两个主要业务包。固定上游在 `deepseek-harness`、`agents-anywhere`；AA 中保留 Connector、Bridge、共享协议和 iOS 参考，本期不迁移 iOS。

## 环境准备

所有命令均在**仓库根目录**执行，示例使用 Windows PowerShell；macOS/Linux 将 `corepack.cmd` 换成 `corepack`。

| 开发内容             | 环境                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| 桌面、管理网页       | Git、Node 24.x、Corepack、Yarn 4.18                                                        |
| Python API           | `server:sync` 使用 uv 准备 Python 3.12 和锁定依赖；可用 `UV_PATH` 指定 uv                  |
| 本地数据库、完整部署 | Docker Desktop 的 Linux 引擎；使用已有 PostgreSQL / Redis 时，本机 API 可不用 Docker       |
| 安卓                 | JDK 17、Android SDK 36、Build Tools 34.0.0；模拟器另需 Emulator、Platform Tools 和已有 AVD |

首次取得源码后：

```powershell
git submodule update --init --recursive
node scripts/prepare-aa-source.mjs
corepack.cmd yarn install --immutable
```

源码准备会对 AA 子模块应用稀疏检出，排除已迁入 `apps` 的旧应用目录。不要恢复旧路径或创建转发链接。

## 日常开发

### 桌面

```powershell
corepack.cmd yarn dev
```

先构建，再启动 Electron 和 UI 监听。**UI 重建成功会重启后台并刷新页面，中断正在运行的任务**；Core、Preload、Harness 接入修改后，退出再运行 `dev`。只启动已有产物用 `corepack.cmd yarn start`，修改源码后先 `build`。

### 管理网页与 Python API（推荐开发方式）

前后端在本机手动运行。`server:deps:up` **只启动 PostgreSQL 和 Redis**；随后 `server:dev` 自动补齐服务端 Agent 所需的 Supervisor、API 转发容器与运行镜像。先打开 Docker Desktop，首次准备：

```powershell
corepack.cmd yarn server:sync
corepack.cmd yarn server:deps:up
```

终端一启动 API，执行增量迁移、补充开发管理员并准备 Agent 依赖，然后热重载；首次缺少 Harness 运行镜像时会自动构建：

```powershell
corepack.cmd yarn server:dev
```

终端二启动网页：

```powershell
corepack.cmd yarn admin:dev
```

| 服务                              | 默认地址                                         |
| --------------------------------- | ------------------------------------------------ |
| 管理网页                          | [http://127.0.0.1:5174](http://127.0.0.1:5174)   |
| API                               | `http://127.0.0.1:8000`                          |
| API 就绪检查                      | `http://127.0.0.1:8000/api/v2/health/ready`      |
| PostgreSQL / Redis（仅本机）      | `127.0.0.1:15432` / `127.0.0.1:16379`            |
| 开发 Agent Supervisor（内部认证） | `127.0.0.1:18090`                                |
| 完整 Docker 部署（另选模式）      | [http://127.0.0.1:15174](http://127.0.0.1:15174) |

本地 `superdsh-dev` 开发库自动创建管理员 **`admin` / `admin123`**；已有 `admin` 的密码、角色和状态保持不变。开发库与原部署账号不互通；完整 Docker 和生产部署首次空库仍使用 **setup token** 自行初始化管理员，不提供默认账号。

开发依赖属于独立的 `superdsh-dev` 项目。凭据和模型加密密钥在被 Git 忽略的 `.superdsh-work/server-dev/aa-dev.env`，必须与数据卷一起保留。先对本机 API、网页分别按 `Ctrl+C`，再用 `corepack.cmd yarn server:deps:down` 停止数据库、控制服务和所属 Agent，保留全部卷；API 未停止时可能重新调度 Agent。

只开发电脑连接时，在 API 终端设置 `$env:SUPERDSH_DEV_AGENT_ENABLED='0'`。Supervisor 端口可用 `SUPERDSH_DEV_AGENT_PORT` 修改；API 端口用 `AGENT_SERVER_PORT`。开发 Agent 使用 Docker Desktop 的 `host.docker.internal` 访问本机 API；纯 Linux 主机此路径尚未验证，可使用完整 Docker 部署。

网页默认通过 `/api/v2` 代理到本机 `8000`。如终端之前设置过 `NEXT_OUTPUT=export`，先清除该变量再开发；更换 API 设置 `AGENTS_ANYWHERE_API`。使用已有数据库时，在 API 终端同时设置 `AGENT_SERVER_DB_URL` 和 `AGENT_SERVER_REDIS_URL`，无需运行 `server:deps:up`。显式指定数据库时不自动创建开发账号，空库使用 setup token 初始化。完整配置见[服务端专题](apps/server/README.md)。

### 安卓

在 Android Studio 打开 `apps/android`。已有 SDK 和 AVD 后：

```powershell
corepack.cmd yarn android:build
corepack.cmd yarn android:start --server http://127.0.0.1:8000
```

`android:start` 安装已有 Debug APK 并打开 App，不负责构建或启动服务；也可双击 `start-android.cmd` 使用本机配置。覆盖安装保留账号和中文设置，必须沿用原签名。

`--server` 用于健康检查和模拟器端口映射，**不会改写 App 已保存的服务地址**。在 App 登录页填写 `http://127.0.0.1:8000`。SDK、AVD 和构建参数见[安卓专题](docs/android-local-development.md)。

## 三端联调

```text
桌面本地：SuperDsh Core → 后端子进程 → Harness 插件 → 本机会话
跨端访问：网页 / 安卓 / 桌面 → Python API v2 → 目标 Connector → Harness
执行目标：自己的电脑，或自己的服务端 Agent 容器
```

**电脑执行模式：** 启动上述开发服务和桌面，在桌面账户菜单填写 API 地址、用户名或邮箱及密码。平台登录成功后自动连接本机并同步会话；安卓与网页登录同一账号，选择该电脑及会话。只有 Connector 和 Harness 就绪才算设备在线，已登录手机不需要再次扫码。

桌面可独立使用 DeepSeek / 个人 API Key。平台登录、退出和换账号不重启应用或 Harness，继续使用原本地 Home 和主聊天；远程文件、终端始终操作所选设备。账号切换如有运行任务，需要确认停止，取消则保留原状态。登录原位切换与开发时 UI 重建是两回事。

**服务端 Agent 模式：** `server:dev` 准备运行依赖，登录后后台自动准备自己的 Agent，不阻塞登录、不切走聊天；失败可重试。账户设置 → 个人模型 → 添加供应商默认预填 DeepSeek，填 Key 保存；无已有默认时会勾选设为默认，也可自定义供应商。**Agent 在线、验证连接成功均不等于模型已生成回复**；已有会话须明确选择新配置的模型后再发送。

需要管理网页与 API 都在容器中运行时，改用完整部署：

```powershell
corepack.cmd yarn server:build
corepack.cmd yarn server:up --no-build
```

访问 `15174`，三端均登录这一部署，Agent 同样后台自动准备。停止完整部署用 `corepack.cmd yarn server:down`，保留卷及配套环境文件。此部署与 `8000` 的开发库、账号和 Agent 独立。

| 联调对象         | 平台登录地址             | 模拟器映射                        |
| ---------------- | ------------------------ | --------------------------------- |
| 本机开发 API     | `http://127.0.0.1:8000`  | `adb reverse tcp:8000 tcp:8000`   |
| 完整 Docker 服务 | `http://127.0.0.1:15174` | `adb reverse tcp:15174 tcp:15174` |

启动脚本指定 `--server` 时会为回环地址设置对应映射；手动连接可运行表中命令。真实手机需可访问的局域网或 HTTPS 地址，不能使用电脑的 `127.0.0.1`。

内置角色只有管理员和普通用户，允许自定义角色；管理员运维权限不授予读取他人聊天、文件或终端的能力。平台供应商 Key 和服务端个人 Key 加密保存、只写入；服务端新会话优先个人默认，否则采用平台默认，已有会话不自动更换模型或费用来源。桌面个人模型留在本机。

手机离线可查看已加载的缓存历史、保存草稿，重连后手动发送。退出手机不会停止服务端任务；账号和目标切换不能混用历史、订阅或凭据。

## 检查与打包

以下命令接在 `corepack.cmd yarn` 后，仍在仓库根执行：

| 范围          | 命令                                                   | 用途                                    |
| ------------- | ------------------------------------------------------ | --------------------------------------- |
| 桌面          | `build` / `start`                                      | 构建产品 / 启动已有产物                 |
| 单独 UI       | `workspace @superdsh/ui build`                         | 只重建 UI；首次先完整构建               |
| 桌面质量      | `typecheck` / `lint` / `format:check` / `test`         | 类型、代码规范、格式和测试              |
| 桌面完整检查  | `check` / `check:ui`                                   | 工程与真实 Host 检查 / 另跑无头界面检查 |
| 管理网页      | `admin:check` / `admin:build` / `admin:start`          | 类型、测试、协议 / 构建 / 启动已有构建  |
| Python 服务端 | `server:check` / `server:test`                         | 协议与分层 / 隔离测试                   |
| 安卓          | `android:check` / `android:test` / `android:build`     | 静态约束 / JVM 单测 / Debug APK         |
| 桌面发布      | `package:dir` / `dist:win` / `dist:mac` / `dist:linux` | 解包应用 / 平台产物（Linux 为解包目录） |
| 源码布局      | `sources:check` / `check:layout`                       | 固定上游与产品目录边界                  |

根 `dev/build/start/check` 默认操作桌面，不会替代 Admin、Server、Android 各自的检查。首次跑 `check:ui` 前安装浏览器：`corepack.cmd yarn workspace @superdsh/desktop exec playwright install chromium`；界面检查需已有构建。

桌面打包输出在 `apps/desktop/dist`，安卓 APK 在 `apps/android/app/build/outputs/apk/debug/app-debug.apk`。完整 Docker 部署的构建、启动、停止是独立操作；不会因修改源码自动更新运行容器。

## 开发约定与数据

- UI 只导入 Core 的公开 `client/*`、`contracts/*`，不直接访问 Node、Electron 或上游内部文件。第三方旧界面放在独立兼容容器，保留模块 ID、Remote、Slots 语义。
- 两空格、单引号、无普通行尾分号；组件 PascalCase，普通模块 kebab-case，以 Prettier 为准。自有工程用根 Yarn，上游 Harness 保留 pnpm；不手改生成类型、构建产物或固定上游。
- 开发 Home 默认 `.superdsh/home`，安装版默认系统应用数据目录下 `SuperDsh/home`；可由 `SUPERDSH_HOME` 或已保存的目录设置覆盖。
- 平台账号不切换本地 Home。凭据、设备绑定和同步检查点按平台地址与稳定用户 ID 隔离；同机不同账号会获得同一本地历史各自的云端副本，旧平台 Home 不自动合并。
- 导入须退出源应用、使用空目标并保留备份；失败回滚，不覆盖源数据。授权、Key、环境变量、`.credentials.yaml` 和设备绑定不复制，需重新配置。
- 开发配置、签名和密钥不提交 Git；数据库备份须同时保留原环境文件和加密密钥。发布前配置自己的更新地址与签名，保留上游许可。细则见 [AGENTS.md](AGENTS.md)。

## 排障与验证边界

| 现象                                  | 先检查                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `DockerDesktopLinuxEngine` 管道不存在 | Docker Desktop 的 Linux 引擎是否就绪；用 `docker info` 核对，再运行依赖或部署命令                                        |
| 网页无法访问                          | 开发网页是 `5174`、API 是 `8000`；完整部署才是 `15174`；确认相应进程正在运行                                             |
| 登录失败或设备离线                    | 是否连接正确环境、是否完成空库初始化；再查 API 就绪检查和 Connector 状态，登录记录不等于执行设备                         |
| Agent 在线但聊天无回复                | 核对个人/平台模型、当前会话选择及执行错误；内置 DeepSeek 名称不代表已经授权，见上方[进度](#目前完成进度)                 |
| 官方模型验证报非公网地址              | 本机代理 Fake-IP 可能触发校验；按[服务端配置](apps/server/README.md)核对精确 origin，并重启 API，勿同时运行重复 API 实例 |
| 中文路径下工具找不到模块              | 工作区脚本使用工具的 Node 入口；不要改成可能破坏编码的批处理包装器                                                       |
| 首次依赖安装或网页编译内存不足        | 保存错误日志、释放内存并减少并行任务后重试；不把未经验证的堆参数当成通用修复                                             |
| 安卓打不开或登录后仍连旧地址          | 先构建 APK，核对 SDK/AVD/签名、App 保存的地址和对应 `adb reverse`                                                        |

本页进度只汇总已有证据，本次文档整理未重新运行应用或联调。静态检查、测试模型、真实 Host、无头界面和手机实机的范围分别记录，不能相互替代。

## 专题与许可

只需按需要深入这三个专题：

- [桌面组件索引](apps/desktop/ui/README.md)：查聊天、设置、设备等具体组件。
- [服务端部署与配置](apps/server/README.md)：数据库、密钥、鉴权、完整部署和服务端 Agent。
- [安卓环境与模拟器](docs/android-local-development.md)：SDK、AVD、Gradle、签名及设备连接。

保留 [MIT 许可证](LICENSE) 与各上游、第三方组件的许可和署名。来源见上方[改造基础](#基于哪些项目改造)；SuperDsh 为独立社区开发，与 DeepSeek 不存在官方隶属或背书关系。

# Web Admin 第一份计划 基础架构建设和基础功能迁移

在 `apps/web-admin/fronted` 与 `apps/web-admin/backend` 建立 Vue3 + TypeScript 与 Python FastAPI 新实现，保持现有 `apps/admin` 包不变。新旧实现对齐功能、界面、交互及客户端协议；DSH 继续承担唯一 Agent 执行循环。现有数据仅用于测试，新实现使用独立新库，不迁移历史数据。

本计划交付可独立启动、构建、部署并完成基础登录及真实 DSH 接入的底座。[第二份计划](web-admin-02-function-and-interaction.md)完成全量功能和交互，[第三份计划](web-admin-03-parity-validation.md)完成差异验证。下方勾选项对应已实现和验证的范围；阶段交接及尚未完成项以文末执行记录为准。

实施统一遵循 [Web Admin 开发规范](../../apps/web-admin/AGENTS.md)：版本来源集中、新业务路由无版本号、领域内职责分层、有意义的中文注释、测试和过程文件隔离，并将健壮性作为完成条件。该规范约束后续代码与部署接线，不以增加目录或框架数量代替架构质量。

### 原生启动补充验证（2026-11-09）

- 修复 Windows 热重载使用 Selector 导致 DSH 异步子进程不可用，以及直接换 Proactor 后复用父监听句柄引发 `WinError 87` 的问题。Windows 每代工作进程独立绑定监听端口，继续复用 Uvicorn 文件监听、信号与退出等待；原生入口仍为 `uv run python main.py`，配置加载、数据库迁移和热重载保留。
- 20 项入口、事件循环与真实重载测试通过；独立端口初次启动及连续两次重载均完成 HTTP 和异步子进程探测，三代子进程回收、最终端口关闭。真实开发配置下另外完成 DSH 与外部模型对话验证，细节见计划二。
- 持久配置增加可选 `providerAllowedOrigins`，只接受确切 HTTP/HTTPS 来源，默认空；环境导出和新 Compose 接线一致。6 项配置测试及 TS 检查通过。本机 Fake-IP 代理场景只配置用户指定的两个供应商来源，未更改通用地址校验或系统代理。

## 产品理念和不可变边界

产品继续遵循[设计理念](../../README.md#设计理念)与[扩展开发契约](../agent-extension-development.md)：扩展来源提供实现；工具配置选择实现版本、参数与凭据；技能组织方法、阶段、工具与资料；智能体组合这些资源并发布到同一工作台。

- Office、知识问答、报表等是可配置工具和技能的应用实例，不是平台核心写死的助手类型。不得按助手名称、示例 ID 或文件后缀选择固定业务流程。
- 通用核心负责身份、权限、资源与版本、会话绑定、运行记录、确认、证据、成果和生命周期。文档生成、图表、公式、模板及对应检查属于工具实现或可注册校验器。
- 新建场景通过现有扩展契约接入实现，再配置工具、技能和智能体；新增实现可以需要代码，但不应要求修改平台根路由、根页面或 DSH 内核。
- 工具保留 Node、Python、本地 MCP 与远程 MCP 的已有扩展能力。平台自有业务使用 Python，不等于禁止第三方 Node 工具或 DSH 的原有运行依赖。
- 技能保留普通指令与可配置阶段两种能力；`legacy/auto/fixed` 策略、辅助工具调用、证据检查、修订和发布语义继续成立。普通问答不强制进入流程。
- LangGraph 是可选的内部流程实现方式。业务配置使用产品自己的 `SkillProgram` 等契约，不要求用户理解图框架，不为每个示例手写一张专用图。
- DSH 保留执行队列、Agent loop、模型工具调用和原有 interaction 机制；LangGraph 不创建第二套执行队列或独立规划 Agent。
- 新 HTTP／WebSocket 规范入口和前端路由不带版本号。旧 API v2 与历史版本路径仅由集中入口映射兼容，同一业务实现保持 OAuth 客户端身份、回调、错误和事件语义；新 Vue 只调用无版本入口。
- 旧 `apps/admin`、桌面和安卓业务代码、固定上游子模块不修改；允许修改根工程接线、检查与文档，并新增新实现自己的运行和部署文件。
- 不依赖旧管理端源码、旧 Node 服务或退休 Python 后端运行。可复制经检查的静态资产、公共协议和测试样本到新目录，保留来源与许可证。

## 目标目录和模块职责

```text
apps/web-admin/
  fronted/
    src/
      App.vue              # 根组件
      main.ts              # 应用入口
      router/index.ts      # 路由装配
      layout/              # 公共布局
      views/<domain>/      # 页面，专属组件按需要放 components
      api/<domain>/        # 请求与 DTO 适配
      composables/         # 通用响应式方法，领域用例放 <domain>
      store/modules/       # 认证、偏好与工作台等共享状态
      store/session-controller.ts # 认证会话协调
      types/<domain>/      # 类型契约
      utils/               # 请求、地址、错误和构建信息基础适配
      utils/<domain>/      # 本领域纯方法
      assets/styles/       # 主题变量与页面样式
      components/          # 通用表单、表格、确认、成果与运行记录展示
    public/
    vite.config.ts
    tsconfig.json
  backend/
    app/
      main.py
      api/                 # 无版本入口装配、WS、错误与兼容适配
      modules/<domain>/    # identity、management、agents、skills、tools 等领域
        controller/        # Router、协议转换与授权入口，只调用 service
        service/           # 业务、用例、事务与幂等协调
        dao/               # 本领域数据访问，不编排业务和提交事务
        entity/do/         # SQLAlchemy 数据库实体
        entity/vo/         # Pydantic 请求和响应模型
      infrastructure/      # 数据库、存储、配置、日志、锁和网络边界
      integrations/dsh/    # DSH 协议、监督、投影、取消与工具回调
      workflows/           # 可选 LangGraph 适配，不持有独立 Agent loop
      workers/             # 通用受控进程与后台工作生命周期
    toolkits/              # 可配置工具实现；office 为其中一个实现包
    resources/             # 默认技能、工具清单、示例组合与模板
    migrations/
    pyproject.toml
    uv.lock
  contracts/               # 生产使用的对外契约和跨语言 Schema
  engine-adapter/src/      # 固定 DSH 必要的 TypeScript 注册/传输适配
  engine-adapter/dist/     # 构建生成并忽略，不属于源码
  tests/                   # 全部新测试、fixture、基准和测试工具
    fronted/
    backend/
    contracts/
    integration/
    e2e/
    parity/
    fixtures/
    tooling/
  deployment/              # Dockerfile、代理、初始化与依赖 Compose
    compatibility-routes.json # 唯一的历史入口映射声明
  scripts/                 # 新实现专属构建、启动和运维程序
  README.md
```

测试报告、截图、trace、日志、coverage、临时目录、测试 Home 和缓存统一写到 `.superdsh-work/web-admin-validation/<run-id>`，不写进源码树。生产 `contracts` 不保存测试快照；基准清单、合成数据和测试 runner 归 `tests`，构建与启动脚本才归生产 `scripts`。测试目录不参与业务 import 或最终运行镜像。

`fronted` 按本次指定拼写使用。首期前端作为根 Yarn 管理的独立应用目录，不创建独立 `package.json` 或 JavaScript 锁文件，也不新增 Yarn workspace。Vue/Vite/vue-tsc 等依赖显式纳入根 `package.json` 和 `yarn.lock`；根命令直接调用 Node 工具入口，显式指定前端配置与工程根目录。

前端目录按用户要求调整为若依 Vue3 风格：职责目录置于 `src` 根下，各目录内保留领域归属。此轮只移动已有文件并更新引用，保留页面组件名、路由、业务逻辑和交互；不再使用 `app`、`features` 目录，不建立转发文件或空目录。

2026-11-07 目录迁移验证：49 个文件移动，53 个源文件均保留；逐文件比较仅引用路径和格式变化，131 处本地引用全部解析成功。前端及测试 TypeScript、ESLint、格式检查通过，前端单元/组件测试 15 个、使用合成接口的无头浏览器交互用例 5 个通过，隔离目录内生产构建通过。实际开发服务保持运行，浏览器测试不创建真实业务数据。前端目录边界验证通过；额外执行全工程目录检查时发现后端已有 `app/__pycache__/build_metadata.cpython-312.pyc` 缓存，不属于本轮前端位置调整，未修改后端或放宽检查规则。

这个安排保护旧 Docker 构建：旧 Dockerfile 在不可变安装之前只复制已有 workspace 的 manifest，直接增加新 workspace 会造成缺失安装输入。新前端仍有独立源码、配置、构建产物和部署镜像。Python 使用独立的 `pyproject.toml`、`uv.lock` 和受支持版本锁定，工具包沿用已有 Python 3.12 扩展契约。

## P1-01 固定源码和行为基准

- [x] 记录当前工作区源码清单及摘要，包括已有未提交的技能、工具和界面改动；不能只用 Git HEAD 代替用户当前版本。排除缓存、生成物、真实凭据和运行数据。
- [x] 导出当前 HTTP、WebSocket、页面模块、权限码、OAuth、扩展、技能与工具协议；本次盘点的 274 HTTP、7 WS、21 页面模块只是观察值，执行时重新枚举并逐项核对。
- [x] 为旧包建立前后指纹和修改归属记录；后续发现用户并行编辑时记录差异并更新明确的对照快照，不回滚用户改动。
- [x] 生产 Schema 保存到新 `contracts`；基准清单、黄金契约和合成 fixture 保存到 `tests/parity`、`tests/contracts`、`tests/fixtures`。旧源码临时快照和运行证据写独立验证目录；旧包不增加文件、不改测试、不生成源码。

交付：可复现的来源快照、完整接口及资源契约清单、旧包保护检查。第二、三份计划使用同一基准标识。

## P1-02 建立前后端工程和依赖边界

- [x] 新建 Vue3、TypeScript strict、Vite、Vue Router、Pinia 的前端工程，复用既有视觉 tokens、字体和文案。Element Plus 用于通用基础控件，样式按旧页面对齐，不套用若依默认外观替代现有产品。
- [x] 新建 FastAPI、Pydantic、SQLAlchemy 异步访问、Alembic、结构化日志和统一异常的 Python 工程。按 RuoYi-FastAPI 风格拆 `controller/service/dao/entity/do/entity/vo`；controller 只调用 service，业务与事务在 service，dao 仅访问本领域数据，跨模块只调用公开 service，不直接跨域写表。
- [x] 借鉴若依的模块分层、Schema 表单与权限菜单组织，沿用 SuperDsh 自身的身份、权限码、响应与资源归属契约。
- [x] 建立前端禁止导入 Python／服务端凭据、后端不导入旧 Node 实现的静态门禁。新运行镜像中不得包含旧业务入口作为 fallback。
- [x] 固定依赖与来源；根 Yarn 4.18 使用不可变安装，Python 使用冻结锁安装；构建时安装依赖，业务执行时不临时安装。
- [x] 明确发布版本唯一元数据及前后端构建信息生成方式；引擎 pin、镜像版本和外部协议标识从受控配置／契约读取。保留业务 revision 数据和不可变迁移标识，不把禁硬编码误用为删除版本管理。
- [x] 建立无版本规范路由、集中 API 客户端和兼容映射加载器。只在 `deployment/compatibility-routes.json` 声明历史方法／路径模板／传输类型，对新旧入口复用 handler；禁止新增按版本复制的目录、DTO、组件和业务分支。
- [x] 前端页面、组件、composable、API、store 与纯方法各守职责；公开契约和复杂控制逻辑补充中文说明，不在单页、万能工具文件或全能服务类中堆积实现。

交付：前后端各自能构建、类型检查和执行最小测试；没有空壳页面冒充业务迁移完成。

## P1-03 建立新库和独立运行空间

- [x] 新库从 Alembic 新基线初始化；不继承旧 `v2_35–v2_46` 历史升级负担，也不把旧非空库自动 stamp 成新基线。
- [x] 优先建立用户、角色、会话、菜单、审计、资源版本、绑定、执行收据、确认、成果与证据的通用模型；内部结构调整不改变 API 表达。
- [x] 为新开发与新部署分别建立配置目录、数据库、Redis、Qdrant、对象存储桶／卷、用户 Home、workspace 和日志。旧平台所有数据与生成密钥保留。
- [x] 默认开发数据使用 `.superdsh-work/web-admin-dev`，生产使用新 Compose 持久卷。重复初始化复用已有密钥，不覆盖管理员自行修改的配置。
- [x] 初始化器仅处理明确归属的新空库；缺失配置但发现已有卷时明确失败，不静默生成另一套密钥。

交付：新旧实例可独立启动；新库初始化、再次启动、迁移失败回滚与配置持久化均有隔离测试。

## P1-04 建立通用扩展和资源契约

- [x] 明确 `Extension`、`ToolDefinition`、`ToolConfiguration`、`SkillDefinition`、`AgentDefinition`、`Binding`、`Run`、`Approval`、`Artifact`、`Evidence` 的边界，保留既有 ID 与对外字段。
- [x] 工具配置和表单来自 JSON Schema，`writeOnly` 凭据加密存储、读取只返回设置状态；工具实现与用户配置分开版本管理。
- [x] 会话冻结资源和实现版本，撤权／停用立即阻止后续调用；已引用版本保留，升级检查失败不替换有效版本。
- [x] 技能方法、参考资料、模板与可执行工具分离；导入技能不能绕过工具安装与授权直接执行脚本。
- [x] 原工具确认、方案哈希、阶段修订、真实证据与成果引用迁为通用服务；兼容现有 Office 对外字段，具体文档检查仍由工具实现承担。
- [x] 默认助手和 Office 技能作为可编辑、可复制、可停用、可删除的资源包加载；重复初始化不覆盖定制，也不恢复用户已经删除的示例。

交付：一个无 Office 特例的合成扩展可完成安装声明、Schema 配置、技能关联和智能体发布的基础闭环；生产级扩展生命周期由第二份完成。

## P1-05 迁移认证和基础权限

- [x] 迁移首次初始化、登录、登出、访问令牌、刷新轮换、登录会话与账号状态校验；保留旧客户端密码挑战、错误、Cookie 和原生端响应语义。
- [x] 前端 access token 保持内存管理；刷新单飞、账号代际隔离、登出后迟到请求拒绝回写。
- [x] 迁移角色、权限码与资源归属检查。菜单隐藏与授权分离，管理员运维不能越权读取他人聊天、文件和终端。
- [x] 迁移基础用户、角色、菜单的真实 API 和页面；支持现有过滤、分页、编辑失败保稿、并发更新冲突和危险操作确认。
- [x] 保留 OAuth client ID、PKCE 和回调约束；先建立兼容端点与可运行的本地合成协议测试，外部身份源完整联调列入第二、三份。
- [x] 按新旧入口验证 Cookie Path、刷新、登出清理及 OAuth 状态 Cookie；集中映射处理 Location 和下载 URL。保留外部签名／已注册回调，不用全局字符串替换或 301/302 跳转兼容 POST／WS。

交付：真实数据库上的登录／刷新／登出／角色变化／菜单冲突闭环；使用合成账号，不复用用户真实凭据。

## P1-06 迁移布局 导航和基础状态

- [x] 建立与旧版一致的官网入口、登录入口、工作台及后台布局、导航、语言和主题基础；全量页面内容由第二份对齐。
- [x] 按当前模块清单注册路由和权限，保留旧 Hash 别名、预览／分享／OAuth 入口、403 和 404 行为。
- [x] 管理页面不加载工作台运行依赖，不因登录或访问管理页面启动 DSH；网页沿用 deferred Agent 准备行为。
- [x] 草稿、待上传附件和设备／模型选择按账号管理，切模块可恢复、换账号清空；刷新不持久化临时 File。
- [x] 尚未实现的页面明确标为开发未完成，不用假数据或成功提示代替真实能力，不计入完成清单。

交付：基础页面可实际操作，导航生命周期正确；第二份可按模块独立推进。

## P1-07 完成 Python 到现有 DSH 的接入

- [x] 固定现有 DSH、Bridge、产品 profile、patches 和依赖来源；不为重写更新引擎，不从只读子模块源码临时加载运行依赖。
- [x] 验证官方 Python SDK／runtime 对当前产品组合的覆盖范围。SDK 是同引擎接入，但不能假设其简化接口具备现有逐会话取消、审批、preset、历史投影与 ACK 能力。
- [x] 用 Python 接入现有 RuntimeBridge 完整产品协议；SDK 已覆盖的能力可复用，同一会话只保留一条命令提交路径，不同时维护两个 Host 或两套会话事实源。
- [x] 迁移每用户 Home/workspace、数据库运行锁、就绪握手、重用、故障诊断、取消及进程树回收。首期单 API worker 和唯一 supervisor，重型工具使用受管工作进程。
- [x] 子进程使用环境白名单与短期受限凭据，不直接继承 API 进程的数据库、登录及供应商密钥。不同用户目录是产品所有权边界，不宣称 OS 沙箱。
- [x] 建立通用工具回调与结果／取消桥接；固定 Harness 必要的注册／传输适配以 TypeScript 源码放独立 `engine-adapter/src`，构建产物放被忽略的 `dist`。`backend/app` 不放 JS/MJS/TS，业务与工具处理保持 Python，不保留 Node 业务服务，不在执行时编译。
- [x] 在临时用户目录完成真实 DSH 的准备、发起、事件接收、逐会话取消和关闭；真实模型测试与协议 fixture 分别记录。

交付：Python 平台驱动固定引擎的真实闭环，证明不依赖旧 admin 进程；完整多场景行为由第二份迁移。

## P1-08 建立可选流程和后台处理接口

- [x] 建立产品自己的阶段执行接口和版本化运行记录；`inspect/submit/prepare/execute/review`、辅助工具及检查契约以现有定义为准。
- [x] LangGraph 适配只表达可配置阶段状态、分支和等待，不直接再驱动独立模型循环。既有普通技能可以不经过 LangGraph。
- [x] checkpoint 只保存稳定 ID、版本和引用；业务表持有确认、收费与工具收据。缺少 ACK 的操作进入结果未知，不能自动重发。
- [x] 旧确认在修订后失效，迟到结果不能覆盖新阶段；重启保留记录并标记中断，不自动重放带副作用操作。
- [x] 建立 CPU／ZIP／渲染／向量化工作进程的超时、取消、资源和清理契约，不把长期业务挂在一次 HTTP 请求生命周期里。

交付：一个合成技能验证阶段提交、确认、修订、取消与中断；Office 等真实配置包由第二份接入同一套机制。

## P1-09 新增完整启动和构建命令

- [x] 后端缓存边界修复：原生入口在业务配置读取前设置并校验 `.superdsh-work` 下的字节码路径，Node 入口统一注入 Python/uv/Ruff/mypy 的绝对缓存目录；Docker 缓存同步放入镜像内 `/app/.superdsh-work`。隔离复现确认冷 `uv lock` 的动态版本解析会生成源码字节码，已通过仅对本项目元数据构建设置 `PYTHONDONTWRITEBYTECODE` 阻止，保留正常运行缓存与动态版本来源。

2026-11-07 缓存整理：源码内遗留的 `app/__pycache__`、`.ruff_cache` 及历史 `.egg-info` 已迁入 `.superdsh-work/web-admin-tools/legacy-cache/2ec6bbc4177b4b7fb815b70da5ec8254`。批量递归删除被自动审批拒绝，改为保留文件并迁出源码的方式完成整理，没有绕过删除限制。启动配置测试 16 个、Node 缓存边界测试 7 个通过；Python 类型检查覆盖 112 个文件通过。历史 `.egg-info` 属构建元数据，后续显式冷解析/打包仍可能生成，不将其描述为运行字节码缓存。

缓存实机验证：在工作目录内的独立源码副本、全新虚拟环境和临时 PostgreSQL/Redis 上原样执行 `uv run python main.py`，迁移完成且 ready 为 HTTP 200；真实 PTY 触发热重载后，旧 worker 正常退出，新 worker 再次 ready 200。迁移进程、重载父进程和两代 worker 的缓存目录均在临时仓库 `.superdsh-work`，281 个字节码文件全部外置，临时业务源码无 `.pyc` 或 `__pycache__`。Ctrl+C 后确认测试进程及端口全部退出，临时库、容器、源码、venv、Home 和缓存已清理。新管理端全工程目录及镜像所有权检查已重新通过，前端目录迁移记录中的后端缓存问题已解除；用户现有服务保持运行。

- [x] 按用户要求改为配置驱动的初始管理员：默认值集中在 `deployment/initial-admin.json`（`admin / admin123`），初始化写入持久 `settings.json.initialAdmin`；原生 Python 和独立 Docker 同样通过环境配置注入。后端启动仅为空库创建首个管理员，与兼容初始化共用事务锁，已有账号的密码、角色和状态均不覆盖。前端直接登录，不再显示初始化令牌或创建管理员表单。

2026-11-07 初始管理员改动验证：配置生成、旧配置补齐和自定义配置保留 3 个用例通过；隔离 PostgreSQL 身份回归共 10 个通过，覆盖并发初始化、真实应用生命周期重启、改密及权限保留；前端 15 个用例通过，其中登录组件新增 6 个。Python/TS 类型、改动文件格式和 lint 检查通过。当前开发配置已补齐，按同一服务用例创建请求的持久管理员；独立无头浏览器实际以默认账号登录当前开发站点并进入总览，随后登出，临时浏览器目录已清理。用户运行中的前后端保持运行，旧 `apps/admin` 未改动。

本轮临时数据库、容器和 Home 已清理；两个本轮验证目录 `login-config-20261107`（报告与 Vitest 缓存）和 `initial-admin-static`（类型检查缓存）的删除被自动审批以 `blocked by policy` 拒绝，未绕过，均位于 `.superdsh-work/web-admin-validation`，没有残留合成业务账号。

原生 Python 环境统一修复：根命令和原生 `uv run python main.py` 默认共用 `backend/.venv`。`web-admin:prepare` 将受管 Python 安装到 `.superdsh-work/web-admin-tools/python`，按实际解释器路径同步后端依赖，并检查实际基础解释器的归属；`web-admin:init` 先执行同一准备流程，再导出配置和启动开发数据库。准备过程不改全局 Python 注册或命令目录，避免再次复用指向用户 Roaming 的旧虚拟环境。README 已更新首次安装、单独修复及日常启动顺序。原生命令启动成功，后端及前端代理 ready 均为 HTTP 200，验证后关闭我方后端；用户随后在自己的终端明确确认“起来了好使了”，用户服务保持运行。旧 CPython 启动器路径失效的真实回归通过（15.39 秒），本轮临时环境已清理；新 uv trampoline 的测试故障注入与中文路径探测已适配。原先工具进程与用户终端访问 Roaming 路径的具体差异未获直接证据，不将其归因为已确认的文件删除或权限变更。

2026-11-07 开发数据库连接故障已恢复：PostgreSQL 容器内部 `pg_isready` 正常，但 Docker Engine/containerd 主进程与 API socket 缺失，宿主机转发连接超时。正常 Desktop 重启也超时；先让原 5 个容器正常退出，回收失去响应的 Desktop 后，又定位到遗留 `dockerInference` IPC socket 阻止启动。将仅含 IPC 的旧运行目录保留为 `C:/Users/zhong/AppData/Local/Docker/run.before-web-admin-recovery-20261107-155336`，重新创建运行目录后引擎恢复；原 web-admin PostgreSQL/Redis 与 phm 的 3 个容器均恢复 healthy，容器 ID、数据库卷及两份开发配置哈希保持不变。实际执行 `uv run python main.py` 成功完成迁移并启动，后端 live/ready 和现有前端代理 ready 均为 HTTP 200，database/redis 检查为 ok；验证后正常关闭后端和热重载进程，保留用户原前端及数据库运行。未创建业务测试账号或改动业务代码。此前入口改名验证遇到的数据库阻断已解除。

原生启动入口统一：后端目录只保留 `main.py` 开发入口，标准命令为 `uv run python main.py`；保留开发配置加载、数据库迁移、默认热重载和 `--no-reload` 选项。`backend/app/main.py` 继续负责 ASGI 应用装配。入口引用、质量检查范围、规范和文档已同步更新，无旧入口文件或引用。Ruff、mypy 与 14 项配置测试通过，本轮临时验证目录已清理；精确启动命令已进入迁移，但本机 PostgreSQL `127.0.0.1:55435` 连接超时（独立连接探测复现），Docker 查询也未返回，故本轮未确认 HTTP 就绪与实际重载。验证后后端进程已退出、8001 端口空闲，用户原有 5175 前端保持运行。启动异常无消息时补充类型诊断，避免空白错误。

依赖交付补充：从 `uv.lock` 冻结导出 `backend/requirements.txt` 和 `backend/requirements-dev.txt`，完整包含运行／开发的直接与间接依赖、平台条件及哈希；新增 `web-admin:requirements` 重建入口。两份清单已通过 `uv pip install --dry-run --require-hashes` 检查，现有后端环境无须变更，`uv pip check` 通过。uv 已安装到用户报错所指的 Python 解释器，普通、`-s`、`-I` 三种模块调用及独立 `uv` 命令均验证成功；文档将安装和验证前置。未启动前后端服务。

独立开发入口补充：支持后端目录 `uv run python main.py`（自动锁定同步、迁移、热重载）和前端目录 `npm run dev`。`web-admin:init` 准备同一后端虚拟环境、生成共用开发配置并启动 PostgreSQL、Redis，不构建或启动应用；Python 原生入口读取外置配置，不经 Node 调度运行。前端新增仅含命令的私有 manifest，沿用根依赖与锁、不加入 workspace，所有权检查相应改为禁止第二套依赖和锁文件。uv 项目声明为源码运行的 virtual project，依赖版本不升级，不隐式构建本项目。独立双终端实测首页及 API 代理返回 200，结束后释放端口；配置边界测试 14 项、Ruff、mypy、TS 与 ESLint 通过。文档以该方式作为推荐入口。测试合成配置目录 `.superdsh-work/web-admin-validation/native-dev-config` 清理被自动审批拒绝（`blocked by policy`），无业务数据；未绕过拒绝。

2026-11-07 预览入口调整：新增 `web-admin:preview`，以 `--no-build` 只启动开发 PostgreSQL、Redis，再复用前后端源码启动。已实际运行根命令；首页、Python `/api/health/ready` 与前端代理就绪接口均返回 200，脚本 TypeScript 与 ESLint 检查通过。未构建前端、引擎或镜像，未创建测试账号；开发服务保留运行供用户查看。

同日启动健壮性补充：`preview/dev/backend-dev/migrate/start` 自动实际探测解释器、冻结同步依赖并验证导入；缺少环境或基础 Python 路径失效时由 uv 重建，依赖文件损坏时重装锁定依赖，失败即停止启动。新增 `prepare` 入口只处理环境。根 TypeScript 入口保持 CommonJS 兼容，新脚本使用局部 ESM 声明，Vite 使用模块运行器加载配置，用户启动命令不再出现模块类型警告。真实 Windows 回归验证“空环境安装 → 破坏临时环境的基础解释器路径 → 自动修复 → 依赖导入恢复”，21.3 秒通过且锁文件不变；该回归临时目录已清理。实际预览重新启动、首页/API/代理均返回 200，脚本与测试类型检查、ESLint 通过。首次独立诊断目录 `python-repair-c8adca8f200844dc94bd5366c5a78c67` 的清理被自动审批拒绝（`blocked by policy`），仍位于 `.superdsh-work/web-admin-validation`，只有临时环境和缓存，无业务数据；未绕过拒绝。

根 `package.json` 新增以下命令，统一调度 `scripts/web-admin.ts` 或新实现专属 TypeScript 脚本。现有 `dev/build/start/package:dir/dist:*` 继续面向桌面，`admin:*` 与 `server:*` 保持原义。

| 新命令                       | 必须交付的行为                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `yarn web-admin:sync`        | 冻结安装独立 Python 环境、生成元数据并构建固定引擎适配                           |
| `yarn web-admin:prepare`     | 准备项目受管 Python，检查并修复后端 `.venv` 和锁定依赖，不启动服务或构建         |
| `yarn web-admin:init`        | 准备后端 `.venv`、导出原生开发配置、启动 PostgreSQL 与 Redis，不构建或启动前后端 |
| `yarn web-admin:dev`         | 启动 Vue 热更新和 Python API，统一日志与关闭，默认网页 5175、API 8001            |
| `yarn web-admin:preview`     | 只启动 PostgreSQL、Redis 并运行前后端源码，不执行前端、引擎或镜像构建            |
| `yarn web-admin:fronted:dev` | 仅启动新 Vue 应用，代理到明确配置的新后端                                        |
| `yarn web-admin:backend:dev` | 仅启动新 Python API，不启动旧 Node 服务                                          |
| `yarn web-admin:deps:up`     | 初始化并启动新开发依赖，识别自己的 Compose 标签并复用健康实例                    |
| `yarn web-admin:deps:down`   | 停止自己的开发依赖，保留卷，不影响旧 `superdsh-dev`                              |
| `yarn web-admin:migrate`     | 迁移明确归属的新数据库，不读取旧默认数据库配置                                   |
| `yarn web-admin:build`       | 构建前端并校验 Python 分发、固定引擎及资源产物                                   |
| `yarn web-admin:start`       | 启动已构建的新前端入口和 Python 服务，不使用开发服务器冒充生产                   |
| `yarn web-admin:check`       | 新前后端格式、lint、类型、构建、单元、契约与边界检查；不得静默跳过未接入项       |
| `yarn web-admin:parity`      | 运行第三份的差分入口；第一份只建立结构，完成全量验证前不得报告整体通过           |
| `yarn web-admin:up`          | 用新生产 Compose 构建并启动新服务，保留持久卷和密钥                              |
| `yarn web-admin:down`        | 停止新生产服务，不附加删除卷参数                                                 |
| `yarn web-admin:logs`        | 读取新生产服务日志，屏蔽凭据                                                     |

- [x] Node 脚本直接使用 `node node_modules/<tool>/<entry>`，显式传入配置文件；Python 通过锁定环境调用，Windows 中文路径参数不经有损批处理包装。
- [x] 检查及差分命令从 `tests` 收集测试、调用 `tests/tooling`，为所有测试器统一注入验证输出、缓存和临时目录；生产命令不依赖测试代码启动。
- [x] 热更新不反复启动用户 Host；API 重载先完整回收所属资源和锁，异常退出不能留下第二个执行者。
- [x] 使用独立开发配置、端口和目录；不要调用硬编码旧包的 `server.mjs`、知识模型准备或字体准备脚本。
- [x] Cookie 不按端口隔离。并行浏览新旧站点使用不同 hostname（例如旧 `127.0.0.1`、新 `localhost`）或独立浏览器配置；自动化差分必须使用独立 browser context。

交付：每条命令的帮助、退出码、启动诊断和 Ctrl+C 行为；没有依赖旧应用先启动的隐式前置条件。

## P1-10 新增 Docker 和 Compose 交付

- [x] 新建根 `compose.web-admin.yml`，生产 project 使用独立名称，例如 `starbridge-web-admin`；原 `compose.yml` 默认服务保持不变。
- [x] 新建 `deployment/compose.dependencies.yml`，仅承载新开发数据库与存储依赖，project 与旧 `superdsh-dev` 区分，端口可配置且冲突明确诊断。
- [x] 新建 `deployment/Dockerfile.fronted`：根 Yarn 不可变构建、输出 Vue 静态资源、Nginx 同源代理 API 和 WebSocket；生产默认仅发布前端 5175，后端在内部网络。
- [x] 新建 `deployment/Dockerfile.backend`：冻结 Python 依赖、Python 应用入口、固定 DSH 产物、所需工具／字体／模型资源与许可证；不启动 Next 或旧 Node API。
- [x] 使用对应的 `Dockerfile.fronted.dockerignore` 与 `Dockerfile.backend.dockerignore` 控制新构建上下文。保持根旧 `.dockerignore` 的既有边界；安装阶段若需要旧 workspace manifest，只读取包管理元数据，不复制旧业务实现到运行镜像。
- [x] 最终前后端运行镜像排除新 `tests`、基准快照、验证过程目录、缓存和真实配置；测试阶段与运行阶段分离。镜像和应用版本由统一发布／部署元数据注入，不在 Dockerfile 与业务代码反复写版本字面量。
- [x] 新建配置初始化、迁移、反向代理、健康检查与优雅关闭配置。存活检查、依赖就绪、用户 Agent 就绪分别表达，不用一次 HTTP 200 掩盖执行不可用。
- [x] 新 config、database、runtime、files、Qdrant、Redis、MinIO 卷全部独立；重复 `up --build` 不重建密钥或覆盖资源配置。
- [x] DSH 可执行文件连同完整伴随资源交付；SDK/runtime、产品补丁与 Host 安装锚一致，缺少资源直接失败。
- [x] 新旧 Docker 镜像都从干净安装输入构建，证明新增根依赖未破坏旧 Dockerfile 的不可变安装和构建。

交付：新 Compose 配置检查、镜像构建、启动登录、真实 DSH 准备、停止回收与再次启动持久化证据。旧 Compose 仍可按原命令使用。

## P1-11 接入工程检查和交付说明

- [x] 扩展 `scripts/code-quality.mjs` 的新目录与 `.vue` 覆盖、构建输出排除，新增 Vue ESLint 配置；Python 接入 Ruff、类型检查与 pytest，不以未扫描通过检查。
- [x] 新增旧包依赖禁止检查、通用扩展边界检查和新命令测试；保持现有 desktop、layout、vendor pin、patch 与上游来源检查。
- [x] 新增版本来源、无版本业务路由、兼容映射唯一性、领域依赖方向、测试目录与镜像排除检查；必要协议标识的例外逐项登记，不能用宽泛豁免绕过规则。
- [x] 中文公共契约注释及复杂逻辑说明纳入审查，检查“原因、输入输出、不变量、异常和清理行为”，不以注释覆盖率代替内容质量。
- [x] 更新根忽略规则中的 Python 虚拟环境、缓存、前端输出与环境文件；真实配置、数据和凭据不能进源码或镜像上下文。
- [x] CI 增加新前端、Python、契约和新 Docker 检查，保留旧管理端检查；第三份的全量差分在完成后进入独立准入任务。
- [x] 更新根开发命令说明、新 `apps/web-admin/README.md` 和适用的仓库规则，写清新旧产品并存与目录责任；不改旧包内文档来宣称它已被替换。

## P1-12 建立健壮性基础设施与工程门槛

- [x] 为输入校验、统一错误、事务、超时／取消、有限重试、幂等收据、日志关联、资源清理和状态代际检查建立明确接口；可复用方法与具体 UI 组件分开实现。
- [x] 外部网络和长期工具调用不得阻塞 API 或占用长事务；流式缓冲有上限，依赖故障明确呈现，不能吞异常后返回成功或擅自换供应商。
- [x] 每个用例给出适用的边界、无权限、冲突、超时、取消及清理测试；副作用与执行所有权另测重复请求、未知结果、迟到回包、租约丢失和重启。
- [x] 在中央 `tests` 验证测试收集与输出设置，检查 `fronted/src`、`backend/app`、`toolkits/resources/contracts/scripts` 没有混入测试与过程文件；覆盖 Python 缓存和工具默认输出路径。
- [x] 验证直连 Python 开发入口和 Nginx 生产入口都加载同一兼容声明；规范入口无版本、新客户端只走规范入口，旧客户端请求保持等价。

交付：可被第二份业务实现直接使用的基础接口、约束和故障测试样例；第三份 P3-14 对这些工程规则及实际模块逐项验收，不能只审查目录名称。

## 第一份完成门槛和交接

- [x] 新前后端独立构建、启动、停止；新依赖及生产 Compose 可用且不依赖旧服务。
- [x] 登录、刷新、登出、用户／角色／菜单基础闭环通过；管理页不启动 DSH。
- [x] Python 使用固定 DSH 完成真实最小执行与取消；进程所有权、环境和资源清理正确。
- [x] 通用资源配置与技能阶段合成闭环通过，Office 示例不构成平台硬编码分支。
- [x] 版本来源、无版本规范路由／兼容映射、领域职责、中文注释、集中测试与过程输出及健壮性门槛均落实；生成文档或空目录不算完成。
- [x] 旧 `apps/admin` 源码未被本次任务修改，原命令与 Docker 干净构建仍可用。
- [x] 向第二份交付冻结契约、来源快照、目录规范、配置 fixture、运行环境和剩余未实现清单；向第三份交付可启动的对照环境与证据结构。

第一份通过只代表底座与基础功能完成。全部业务、界面和交互以第二份为准；功能无损与扩展性对齐必须在第三份取得证据后才能确认。

## 实施记录（2026-11-07）

状态：基础架构和基础功能已实现，统一 `web-admin:check`、最终镜像构建及真实 Docker 生命周期复验均通过。文件清理仍有自动审批阻断，见下方单独未完成项。第二份、第三份仍待执行，不宣称全业务无损迁移已经完成。

| 验证           | 实际结果                                                                                                                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 旧包保护       | 740 个文件与实施前工作区一致；包含原有未提交修改。基准指纹 `df4b278c5207e583987260417cc18b57939c83a1ec295fd603ef6cecde6dc257`                                                                                                                                                                                  |
| 来源和接口清单 | 274 HTTP、7 WS、21 页面模块，完整清单及旧 OpenAPI 保存在 `tests/fixtures/baselines`                                                                                                                                                                                                                            |
| 新统一检查     | `node scripts/web-admin.ts check`，退出码 0；Ruff 格式 108 个文件、mypy 109 个文件、前后端 TS、ESLint、分层与所有权门禁通过                                                                                                                                                                                    |
| Python 测试    | 23 项通过：真实 PostgreSQL/Redis 身份权限、资源密文及 Schema 投影、确认/修订/收据/证据、迁移保护、真实工作进程、真实固定 DSH 与协议反例                                                                                                                                                                        |
| 前端与工具测试 | 9 个 Vue 单元测试、6 个 Node 工具测试通过                                                                                                                                                                                                                                                                      |
| 浏览器         | 6 项通过：1 项真实 Python/PostgreSQL/Redis 闭环，5 项使用 API fixture 的交互/窄屏反例；Edge headless，独立 context                                                                                                                                                                                             |
| 启动与关闭     | `dev`、`fronted-dev`、`backend-dev`、`start` 实测通过；包含 SPA/代理/API/404、正常退出、IPv4/IPv6 端口释放                                                                                                                                                                                                     |
| Docker 运行    | 两轮独立项目各 10 项通过：真实 DSH 准备、停止、运行中重启、再次启动、账号/密钥保持、配置缺失拒绝、镜像边界；最终镜像再次复验 10 项通过，退出码 0                                                                                                                                                               |
| 新镜像         | 独立固定摘要 BuildKit 完成前端、后端、MinIO 的干净构建，退出码 0；最终后端 `75a5d26da5bb…`、前端 `7fde21636208…`，与最后 Docker 验收相同                                                                                                                                                                       |
| 旧镜像         | 未改动旧 Dockerfile，从其原有构建入口完成不可变安装、Next/Node 构建和完整镜像导出，退出码 0                                                                                                                                                                                                                    |
| 全仓只读检查   | `yarn lint` 通过（旧测试 1 条未用参数 warning）；`yarn typecheck`、`yarn check:layout`、双语文档一致性通过                                                                                                                                                                                                     |
| 原有失败       | `yarn test` 的桌面 Core 为 357 passed / 1 failed / 2 skipped；`platform-agents.spec.ts` 附件结果旧断言缺少现实现的 `name/sha256`。相关源码与测试未修改；根测试链在 Core 失败后停止，后续 workspace 测试未由该命令继续执行。`yarn format:check` 仍有 8 处原有差异，均不在本次新代码；没有改动旧文件来让检查变绿 |
| 全量差分       | `web-admin:parity` 按设计返回非零并说明阶段三未完成，不能以基础检查冒充差分通过                                                                                                                                                                                                                                |

### 实现边界与后续交接

- 后端为 `controller → service → dao`，DO/VO/业务值分开；业务目录纯 Python。必要的固定引擎注册/传输为独立 TypeScript，编译的 `.mjs` 只存在于被忽略的 `engine-adapter/dist`。
- 已登记 34 项基础历史入口映射。通用资源 API 为 `/api/resources/*`；它提供配置、版本、授权、绑定等底座，不冒充旧智能体/技能/工具完整 DTO。完整业务 HTTP、七类旧 WS、桌面/安卓实机及外部 OAuth 验收由第二、三份完成。
- 真实引擎使用固定 Host、受控本地模型、真实工具回调和 PostgreSQL 所有权/投影；覆盖取消、撤权、未知收据、ACK、重启与进程树清理。没有调用外部付费模型，不宣称真实设备或 OS 沙箱覆盖。
- Office 仅为可编辑示例资源；平台没有按 Office 名称选择执行分支。LangGraph 可选，阶段记录和副作用收据由业务服务持有，DSH 保持唯一执行循环。
- 第一阶段成果使用受管本地对象卷。MinIO 私有桶及独立卷已初始化，S3 provider/管理界面属于第二份；MinIO 由集中元数据固定源码、SHA-256 和构建镜像，避免依赖已无法匿名拉取的旧镜像。
- 两份新 Dockerignore 使用显式构建输入白名单；旧根 Dockerignore/Compose/启动命令不变。镜像不含新测试、旧业务或本机配置，依赖闭包实测证明不需要根前端 `node_modules`。
- 本机旧 BuildKit 的导出后不退出问题与 [上游记录](https://github.com/moby/buildkit/issues/6209) 一致；本次使用独立固定摘要 builder 验证，不升级或重启用户 Docker，不切换默认 builder。可复现命令在新 README，CI 使用相同集中摘要。

### 测试数据清理与限制

- [x] 独占测试数据库与共享测试 PostgreSQL/Redis 容器已删除，真实浏览器进程和本机 API/Vite/DSH 测试进程已关闭。
- [x] 统一 `check` 的本轮临时数据库、账号、Home、缓存、截图、trace 及过程文件在 finally 中清除；独立 Docker 验收项目的 7 个容器、7 个卷、网络和合成配置文件已清除。
- [x] 本次独立 BuildKit builder 及其专属缓存卷已移除；默认 builder 和其他项目容器保持原状。
- [x] 前端命令验证的合成 `settings.json` 已按精确单文件方式删除；空 `superdsh_web_admin.egg-info` 元数据目录已移除。
- [ ] 手动验证遗留目录未全部删除。自动审批多次拒绝递归或批量清理，仅给出 `blocked by policy`，没有更细原因；未改用其他通道绕过。残留包括 `.superdsh-work/web-admin-validation/{backend-first,backend-final,dsh-p1,dsh-protocol,dsh-closure,fronted-commands,fronted-e2e,fronted-e2e-final,fronted-e2e-mobile,fronted-live,fronted-tests,build}` 的过程产物；原后端 `.ruff_cache` 已在本轮迁入工作目录的 `legacy-cache`，不再位于源码树。这些文件均不进 Git 或镜像，不包含真实用户账号；仍需完成文件清理，不能宣称“全部测试文件已清空”。

静态测试源码、合成 fixture 和冻结协议清单按要求保留在 `apps/web-admin/tests`，不是一次自测产生的运行数据。默认生产配置和既有平台持久卷不作为测试垃圾删除。

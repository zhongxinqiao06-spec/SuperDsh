# Web Admin 重构计划二：全量功能与交互对齐

状态：P2-01 至 P2-21 功能实现与自测已完成；测试资源清理仍有下文列明的自动审批拒绝例外。旧包 740 个文件与第一阶段基准一致；本次记录见 `apps/web-admin/tests/parity/phase-two-source.json`。完整的新旧差异验收由计划三继续，不将本阶段自测直接记作等价通过。

### 本轮集成进度（2026-11-09）

- 真实模型配置生效：初次按用户要求，将本机 `.superdsh-work/server-dev/model-initialization.json` 的平台 DeepSeek 与火山方舟连接写入新管理端，新库加密保存凭据；旧个人配置未提升为平台配置，旧管理端及其命令未改。默认聊天模型为 `deepseek-flash`，另保留 `deepseek-v4-pro` 与火山 `doubao-seed-2.1-pro`。2026-11-10 按用户明确指定的位置，正式后端启动配置为 `apps/web-admin/backend/config/model-defaults.json`，每次启动原子、幂等应用明确声明的记录；旧导出文件不能改变默认读取路径，旧平台文件不再是新后端运行依赖。实际配置排除 Git 和镜像，Docker 只读挂载。维护语义见新管理端 README 的“后端启动默认模型”。
- 真实供应商验证：DeepSeek Flash、Pro 的 Chat Completions 和火山 Agent Plan 的 Responses 各完成一次短请求并返回 `OK`。随后以独立临时 member、只读权限、已发布默认助手走新管理端 → 固定 DSH → 模型代理完整链路：未显式选模型使用 Flash、显式选择火山模型，各收到持久助手消息 `OK` 和 `session.turn_ended: completed`；原生 `lastUsedModel` 与消息来源模型一致。这是实际外部模型证据，非受控服务结果；不代表 Office、图片、长上下文或全部模型参数矩阵通过。
- 补齐新会话默认模型解析，采用引擎目录返回的真实选择标识，显式选择和既有会话保持不变；默认目录尚未就绪的确定未提交错误释放本次外层收据，已提交或结果未知不重发。修复可选 token/上下文字段透传 `null` 导致固定 DSH 禁用 DeepSeek 的协议差异，未配置字段改为省略，不写死默认数值。29 项默认选择/收据测试、4 项空值边界测试、4 项桥契约测试通过；真实目录对照验证两项 DeepSeek 恢复启用，火山保持启用。
- 连接检测只做模型目录 GET。火山 Plan 目录返回 404 时显示“只读检测无法确认”，不判密钥无效、不误报成功、不静默调用生成；具体模型调用由上面的显式真实请求验证。新会话投影补接 DSH 目录/库存控制通知，真实回复和完成事件可正常读取；失败终态不会被同轮原生 idle 覆盖，新轮执行可解除错误状态。最终合并回归 92 项 Python、14 项前端和 6 项配置测试全部通过，覆盖默认模型、空值边界、检测提示、启动诊断、收据、通知回放、状态及真实 Windows 重载。
- 本轮验证使用的 5 个临时账号及关联会话、收据、审计等 279 条记录、10 条已撤销验证登录记录已精确删除；确认测试账号剩余 0，平台默认值和模型配置保留。验证启动的后端与 DSH 子进程已停止，8001 已释放，原前端 5175 保留。报告和缓存集中在 `.superdsh-work/web-admin-validation`，未进入生产源码。
- 最终全量 Python 静态检查覆盖 309 个文件，Ruff 检查/格式与 mypy 均通过；本轮 TS 类型、ESLint、Prettier、目录/语言/镜像边界检查通过。生产及测试源码扫描 `.pyc` 为 0，旧 `apps/admin` 740 个文件指纹仍与冻结基线一致。
- 本轮运行目录清理例外：自动审批先后拒绝删除下列 5 个新临时账号目录，原因仅为 `blocked by policy`，未换方式重试。目录位于 `.superdsh-work/web-admin-dev/runtime/`，分别为 `19ad9fda7a484c53ecf8372dde84b60128fc979c61c3eec0f23cc469acbbae9e`、`9fdf252b92ae0665c5239098c0b0f3b3855c26180a6251d5d22be5e9abe16276`、`55233ef0bf81eb366f888d8eba240d3841fce42ec0c9f4df40ca4bdc128baf8e`、`3e959bf18488a9ccde833f15fe564479fa8b0f58bfe0a8a30a703692ee38eb9b`、`3a4ca3f79c1faad6a54fc78fca5abdad73d366e02012469240c22d8224c03b42`。以本轮 `*-cleanup.json` 的精确路径为核对依据，不能记作文件清理完成。

- 样式回归：按旧端实际源码恢复桌面 240px / 移动 256px 侧栏、56px 页头、面包屑和线性图标；统一 Geist 字体、中性主题、控件圆角与高度、表格/工具栏/分页、居中弹窗。管理员总览恢复五类看板及四项主指标，智能体恢复表格，工作台恢复居中消息列、用户气泡与一体输入卡。12 个统计指标及原有业务操作保留；若依目录分层不变。
- 本次样式验证单独覆盖登录、看板、用户列表/编辑弹窗、工作台的浅/深色和 390px 窄屏，主按钮对比度、移动抽屉及退出确认焦点均通过；原有 CRUD 冲突、撤权、跨模块草稿、退出、富文本和审批交互继续通过。该证据是组件规范与代表性页面回归，不将全部页面逐像素一致记作已验收，计划三仍负责完整差异验证。
- 样式回归自测结果：前端及测试类型检查、ESLint（无错误）、Prettier、目录边界、旧包指纹和前端生产构建通过；57 项 Vue 测试、9 项浏览器用例通过。全部使用合成浏览器数据，没有向开发数据库写入账号或业务记录；用户运行中的前后端保留，本轮未启动额外后端或数据库。
- 本轮清理例外：自动审批拒绝删除 `.superdsh-work/web-admin-validation/style-alignment-20261109` 和 `style-management`，返回 `blocked by policy`；其中截图、报告、缓存及临时前端构建仍保留，不能记作清理完成。未换工具绕过拒绝，也未再次操作前次已列明的清理例外。

- 身份、账号、用户角色菜单、配置总览、模型、智能体、知识库、技能、工具来源、文件存储、设备、工作台、分享、预览和终端均已有真实服务及 Vue 页面；路由不再回退到“未迁移”占位页。已通过本阶段整套检查，结果不替代计划三的新旧差异验收。
- 后端按领域 `controller → service → dao → entity` 组织；前端按页面、API、composable、类型和纯方法分工。新增源文件、测试和过程产物分别保持生产目录、`tests`、`.superdsh-work` 边界。
- 真实 PostgreSQL 用例已覆盖账号/OAuth/手机会话、权限与版本冲突、工具安装/MCP、模型请求收据、技能确认、文件和设备；真实 MinIO 已验证签名、迁移和持久清理恢复。固定 DSH 已验证原生确认前不执行副作用、确认后回传结果、取消和重启不重放；供应商响应使用受控测试服务，不宣称外部收费模型或手机真机验证。
- 默认资源改为声明式可编辑包；四个示例组合、四份实际资料及三个知识库通过初始化幂等、删除不恢复、显式复制和失败补偿测试。Office 原生文件/计算/归档检查已扩充至 20 例，包含模板全部公式缓存、跨表重算和 Word 简单/复杂域；真实渲染及通用确认到成果/文件/修订/撤权链路分别有测试。渲染不合格保留诊断草稿，通用阶段验收拒绝将其作为可交付成果。
- 首份差异报告已覆盖冻结的 274 HTTP 与 7 WS 入口，集中映射均有真实目标；740 个旧包文件指纹不变。OpenAPI 投影差异、完整视觉对照和外设真机验证保持第三阶段待审，不能将 Schema 形状或模拟设备测试当作行为等价通过。
- 完整 `node scripts/web-admin.ts check` 已退出成功：138 项 Python、54 项 Vue、15 项 Node 工程、21 项 Office 文件/真实渲染和 10 项浏览器用例；291 个 Python 文件类型检查及前端/适配器/脚本/测试类型检查通过。原生 `uv run python main.py` 的配置加载、迁移、热重载启动及 API 检查通过，联合开发、前后端分别启动和生产入口的退出/端口回收均通过。正式 `node scripts/web-admin.ts build` 也已退出成功。
- Windows 控制管道改用 `PeekNamedPipe` 检查已到达字节，避免阻塞 stdin 读取挂起继承该管道的子解释器。真实回归覆盖父管道持续打开时的 spawn/NumPy 计算、分包关闭命令和 EOF；Office 生成、表格解析和 PDF 复核的重依赖只在受管工作进程入口加载。生产源码无 `.pyc`，旧构建元数据和诊断缓存归 `.superdsh-work`。
- 最新镜像的真实 Docker 回归 13/13 通过：独立依赖、镜像边界、登录、Nginx/API/WS、文件/预览、Shell、Linux PTY、源码缓存、三类 Office 中文渲染、固定 DSH、重启与停启持久化。运行标识 `deployment-1794190863201-9db58802`；本轮容器、卷、网络和合成文件已清理。后端镜像 `sha256:6018b686de1420ffab7245f0d2196e49253e0086df55af796e604aae2cf3348a`，前端镜像 `sha256:f7cb0e5ea74bc9291e18d952bb463a753c48cf851e04355905576e89c999a387`。
- 完整检查运行标识为 `check-1794190136748-f1885d67`，其测试数据库、Home、上传文件和过程目录已清理，临时 API/前端进程已停止。验证源码及场景索引见 `apps/web-admin/tests/parity/features.json`；该索引保留差异验证待执行状态，不能替代执行报告。
- 第二阶段交接时的结构报告为 `.superdsh-work/web-admin-validation/parity-1794190793666-9836c82f/parity-report.md`；当时 `parity --report-only` 退出成功，结构错误零、旧包变化零，完整 `parity` 门禁尚未通过。后续实际差分、修复与最新门禁结果统一见[第三阶段实施进度](web-admin-03-parity-validation.md)，不以本阶段历史结果覆盖新证据。

### 实现交接索引

以下目录均相对 `apps/web-admin`；每个任务的具体用例名称、旧来源及非菜单场景见 `tests/parity/features.json`。

| 任务           | 已落地的职责边界与主要实现                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-01、P2-21   | `tests/parity`、`tests/fixtures/baselines`、`tests/tooling/parity.ts`：冻结来源、21 模块/25 非菜单场景、真实路由及差异报告。                                                        |
| P2-02 至 P2-05 | `fronted/src/views/{website,auth,account,access,console}`，`backend/app/modules/{identity,navigation,management}`：主题官网、账号安全、用户角色菜单、统计与权限导航。               |
| P2-06 至 P2-08 | 前后端 `models`、`agents`、`knowledge` 领域：资源编辑/版本、模型配置、可编辑示例、资料解析/索引和可追溯检索。                                                                       |
| P2-09、P2-10   | 前后端 `skills`、`tools` 与后端 `extensions`：技能程序、确认修订、Node/Python/MCP 安装和运行、Schema 配置、凭据隔离。                                                               |
| P2-11、P2-12   | 前后端 `files`、`storage`、`devices` 与后端 `runtime`：文件/S3、迁移清理收据、设备协议和固定 DSH 生命周期。                                                                         |
| P2-13 至 P2-16 | 前端 `workbench`、`share`、`workspace-files`、`file-preview`、`terminal`，后端 `conversations`、`devices`、`skills`：会话/项目、流式恢复、审批、方案/来源、分享、冲突编辑、多终端。 |
| P2-17          | `backend/toolkits/office` 与通用执行/成果服务：原生文档/表格/演示/配图、独立重算、修订、真实渲染与草稿标识；平台无 Office 名称分支。                                                |
| P2-18          | 前端 `service`、`audit`、`mobile-connections`，后端 `identity`、`management`：邮件/OAuth 配置、公告、审计、手机登录会话。                                                           |
| P2-19          | `backend/app/workflows/references.py`：可选纯状态引用校验，持久状态仍在业务表；不创建模型循环或第二执行队列。                                                                       |
| P2-20          | `scripts`、`deployment`、`tests/tooling`：原生启动、冻结安装、生产构建、独立镜像、真实 DSH 与部署生命周期。                                                                         |

### 修改范围与未完成的差异验收

本阶段实现范围为 `apps/web-admin/{backend,fronted,engine-adapter,contracts,scripts,deployment,tests}` 及该应用文档；配套接线为根 `package.json`/`yarn.lock`、`scripts/web-admin.ts`、`compose.web-admin.yml`、新应用 CI 和这三份计划。固定 DSH 上游仅作为运行与构建输入，未修改其源码；旧 `apps/admin` 的现有未提交修改保持原样。

交接报告覆盖全部 274 HTTP 与 7 WS 旧入口，当前结构错误为零；179 项 OpenAPI 投影差异仍待核对。完整的新旧页面截图差分、相同请求/事件回放、真实桌面/Android、外部付费模型与 OAuth/邮件、Office 原生客户端验收均在计划三保持开放。受控供应商、模拟设备协议和本阶段的单端浏览器回归不替代这些证据。

### 测试数据清理例外

正常结束的独立验证会自动清理其数据库、容器、Home、上传文件和过程目录；用户正在运行的 8001/5175 服务及原有数据未被接管。本轮有以下**自动审批拒绝**，返回原因均仅为 `blocked by policy`，未绕过或换命令重试：

- 先前中断的 `check-1794045747388-7c59c1db`：对应 `web-admin-<run-id>-pg/redis` 两只容器及同名验证目录。
- 本轮内存压力导致日志进程异常退出的 `check-1794187879404-d995c794`：对应两只容器及同名验证目录；其中为合成测试账号和文件，未混入用户开发库。
- `.superdsh-work/web-admin-validation` 下的 `richtext-browser`、`workbench-final-browser`、`workbench-final-tests`、`workbench-final-mypy` 四个测试输出目录。

这些清理项保持开放，不能记录为“全部测试数据已删除”。允许保留的只读差异报告不含测试账号库或运行 Home。

计划一已采集的参照是 `tests/fixtures/baselines/source-fingerprint.json`：740 个旧包文件，工作区指纹 `df4b278c5207e583987260417cc18b57939c83a1ec295fd603ef6cecde6dc257`，包含采集时未提交修改；接口清单为 274 HTTP + 7 WS、21 页面模块。基础资源服务采用 `/api/resources/*`，其 DTO 是供后续领域实现复用的基础契约；本阶段仍须逐项实现旧智能体、技能、工具、知识库的完整 DTO 与交互，不能直接登记不等价的历史入口映射。

前置：[计划一：基础设施与基础迁移](web-admin-01-foundation.md)。后续：[计划三：差异验证与交付](web-admin-03-parity-validation.md)。本阶段在新应用内完成全部业务实现，交给第三阶段逐项证明功能、交互、视觉和协议一致。

## 范围与执行约束

- 新应用固定为 `apps/web-admin/fronted` 与 `apps/web-admin/backend`；`fronted` 按用户指定拼写，不擅自改成 `frontend`。
- `apps/admin` 完全不动、不删、不重新格式化；只读参考当前实现。新应用不得导入、代理到或在运行时启动旧应用补齐功能。
- 基准是计划一冻结的**当前工作区快照，包括未提交的业务变更**，不是单独的 `HEAD`。记录快照标识、文件哈希和待纳入差异；后续旧代码变化先登记，再同步验收范围。
- “一模一样”按冻结的行为与视觉基准实施：页面结构、布局、文案、状态、交互顺序和可见结果保持一致，不借框架替换改版。Vue 组件实现可以不同，Element Plus 默认样式不是验收基准。
- 前端为 Vue 3 + TypeScript；业务服务为 FastAPI 模块化单体；LangGraph 可作为局部技能/工具流程的实现手段。DSH 仍为唯一执行引擎，其队列、协议、固定上游与补丁不在重写范围。
- 新 HTTP/WS 规范入口为 `/api`、`/ws` 等无版本路径；旧 `/api/v2` 等入口仅通过集中兼容映射保留，WebSocket 事件/票据、桌面和 Android OAuth 身份/回调语义不变。允许新测试数据库从空库初始化，不把历史测试数据迁移作为前提，也不操作旧应用数据卷。
- 表内 `F` 指 `apps/web-admin/fronted/src`，`B` 指 `apps/web-admin/backend/app`；未写全前缀的旧 `src/`、`server/` 证据路径相对 `apps/admin`；测试集中在 `apps/web-admin/tests`，生产 `contracts` 只放生产 Schema 与契约资产。
- 每项任务完成都需记录实现路径、测试路径、对应基准场景和剩余差异。复选框记录本阶段实现及对应自测状态；逐像素、逐报文与真实客户端对照结果仍在计划三单独验收，不能凭页面出现或接口返回 200 宣布等价。

## 开发规范与任务准入

规范权威为 [新应用开发规范](../../apps/web-admin/AGENTS.md)；以下将规范落实到本阶段交付。目录示例只在需要时创建，不为满足结构批量建空文件夹。

### 版本来源与无版本路由

- 发布版本、DSH/扩展运行时版本和构建标识从各自 manifest、锁文件或构建元数据读取，不在页面、服务、脚本重复写版本字面量；来源缺失明确报错，不猜测版本。
- 业务 router 与前端 client 仅使用集中 base URL 加相对 path；`apps/web-admin/deployment/compatibility-routes.json` 按 method/template/transport 独占旧路径到新路径的精确映射，新旧请求进入同一应用用例，不复制旧版路由/服务。
- 无版本要求同时覆盖 `/api/v2` 前缀与 `terminals-v2` 等资源名后缀；开发直连 FastAPI 与生产 Nginx 使用同一兼容清单，新前端只请求规范路径，业务组件不判断旧版本入口。
- 下载地址、`Location` 和 Cookie Path 的兼容由边缘适配根据原入口派生；外部 OAuth 已注册/签名回调保持原身份与地址，不以无版本规范为由破坏外部认证契约。
- 不新增含 `v1`/`v2`、新版后缀的模块/方法/组件或接口目录；必要 `schemaVersion`、事件协议版本、资源版本、业务 `revision` 与冻结绑定字段继续保留，它们是契约数据而非硬编码发布版本。
- 每次新增接口同时核对规范入口与兼容入口的鉴权、校验、状态码及响应；兼容映射不能绕过新入口校验，也不能让新前端继续依赖旧前缀。

### 领域目录与职责分离

- 前端按若依 Vue3 风格拆分：`F/views/<domain>` 负责页面，`F/api/<domain>` 负责传输，`F/composables/<domain>` 负责用例与生命周期，`F/store/modules` 负责共享状态，`F/types/<domain>` 和 `F/utils/<domain>` 分别负责契约与纯方法；路由、公共布局、样式归 `F/router`、`F/layout`、`F/assets/styles`。页面专属组件放 `F/views/<domain>/components`，只建立有实际职责的目录。
- 下方目标中的 `F/views/<domain>` 表示该能力的页面归属，其 API、composable、类型、纯方法与共享状态按上述职责目录实现，不因目标只列页面路径而把所有逻辑堆入页面。
- 组件通过显式 props/emits 交换数据，不直连其他领域 store 或在模板内放业务算法；共享 `F/components` 只容纳通用 UI，跨域复用通过公开接口，不把领域代码堆进万能 utils。
- 后端采用 RuoYi-FastAPI 风格，按 `B/modules/<domain>/{controller,service,dao,entity/do,entity/vo}` 拆分：controller 负责路由、协议和授权入口；service 组织业务、用例及事务；dao 只访问本领域数据；DO 映射数据库，VO 定义请求、响应与校验。
- 调用方向严格为 controller → service → dao；业务规则不进入 controller、DO 或通用依赖注入模块，dao 不提交事务。跨领域只调用公开 service，禁止跨模块直连 dao/表、循环依赖、万能服务类和按新版后缀复制模块。
- `backend/app` 只放 Python；固定 DSH 必要的引擎侧注册与传输以 TypeScript 放独立 `engine-adapter/src`，构建产物不进源码；工具业务在 Python，业务执行时不编译适配器。
- Office 工具包与可选 LangGraph 实现沿用通用调用边界，内部按解析、校验、执行、渲染、结果适配拆职责，不扩张为平台专用控制器或集中处理所有类型的巨型方法。

### 中文注释与测试产物隔离

- 公开函数、服务方法及组件契约使用中文 JSDoc/docstring 说明输入输出、错误、权限/副作用；组件说明 props/emits/暴露方法，复杂算法解释约束，不能只把函数名翻译一遍。
- 并发恢复、幂等键、租约、超时取消、清理顺序和特殊协议兼容必须有中文注释，说明为什么以及失效条件；协议 ID、类型名和外部接口字段保留原标识。
- 所有用例、fixture、测试辅助脚本与可追踪基准集中在 `apps/web-admin/tests/{fronted,backend,contracts,integration,e2e,parity,fixtures,tooling}`；功能清单固定为 `tests/parity/features.json`。
- `fronted/src`、`backend/app`、`backend/toolkits`、生产 `resources` 与 `contracts` 不放测试用例、测试样本或过程文件；生产示例资源应有实际产品用途，不用更名规避隔离要求。
- 每次运行的报告、截图、trace、日志、缓存和临时文件写入 `.superdsh-work/web-admin-validation/<run-id>`；统一 gitignore，测试配置指定输出目录，生产构建与 Docker 镜像排除测试及其产物。

### 健壮性在各任务中的验收落点

| 任务                | 必须实现并验证的失败与边界行为                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| P2-03、P2-04、P2-06 | DTO 类型/长度/枚举/范围与权限双重校验；401/403/409 等按契约归一；取消请求和身份变化阻止过期响应覆盖状态。                          |
| P2-07 至 P2-11      | 缺失/非法引用、归档路径、Schema、文件大小和资源归属校验；事务失败回滚，部分上传/安装清理；重复请求不重复发布、索引或绑定。         |
| P2-12 至 P2-16      | 可取消超时、有界事件缓冲与重连退避；订阅/计时器/预览URL按生命周期释放；跨用户/会话迟到结果隔离，保留仍被使用的任务和终端。         |
| P2-17、P2-19        | 子进程退出/超时/取消可区分，副作用以幂等记录与版本栅栏保护；耗时I/O不占长数据库事务；失败不输出成功成果，不自动重放收费调用。      |
| P2-18、P2-20、P2-21 | 错误保留可追踪关联ID且对用户可理解；日志脱敏；仅对允许重试的错误和幂等操作有限退避重试；重启、依赖不可用及资源释放都有可重复证据。 |

## 保留可配置、可组合的扩展架构

设计依据为根 `README.md` 的设计理念、[智能体扩展、工具与技能](../agent-extension-development.md)，以及 `apps/desktop/core/src/contracts/skills.ts`、`extensions.ts`；以工作区实际文件为准，包括本次技能底座更新。

- 通用关系保持为“扩展来源 → 带版本的工具实现 → 工具配置 → 技能/资料 → Agent 组合 → 会话冻结绑定”；平台根据清单注册的实现 ID 路由工具调用，不按示例助手名称或 Office 类型编写核心流程分支。
- 资源通过 Schema、权限、输入输出、成果、证据、确认和运行记录契约接入。新增或替换合规工具/技能原则上不修改核心页面、会话执行主链和权限框架。
- Office 是可配置工具实现包与示例技能的组合，放在 `apps/web-admin/backend/toolkits/office`；不设平台顶层 Office 业务域或专用固定向导。文档、表格、演示文稿及配图的现有强能力必须保留，不能退化成提示词示例。
- 管理界面以通用 Schema 配置、版本、依赖和绑定为中心；现有预设是可编辑/复制/删除的数据，不覆盖定制项，不在启动时恢复已删除示例。
- `agents.manage` 与安装可执行扩展所需的 `extensions.manage` 分离；`writeOnly` 凭据不随资源正文、接口响应或成果泄露。会话冻结版本，停用/撤权即时阻止后续调用。
- 平台业务统一 Python；既有外部扩展的 Node/Python/MCP 运行契约继续支持。工具进程不是另一套 Agent 引擎，保留这些工具不等于保留旧 Node 平台后端。
- LangGraph 不替代 DSH 语义选技能、确认链或 Agent loop，不强制每个技能成图，不新增执行引擎注册表或 DAG 编辑器；检查点与运行记录服务于现有语义，而非另建独立调度器。

## 21 个模块的覆盖索引

来源：`apps/admin/src/features/console/modules.ts`；旧路由别名以同目录 `routes.ts` 为准。模块 ID 保持稳定，作为第三阶段用例与证据的关联键。

| 模块 ID              | 现有路由               | 本阶段任务                        |
| -------------------- | ---------------------- | --------------------------------- |
| `overview`           | `#/overview`           | P2-05                             |
| `access.users`       | `#/access/users`       | P2-04                             |
| `access.roles`       | `#/access/roles`       | P2-04                             |
| `access.menus`       | `#/access/menus`       | P2-04                             |
| `agents`             | `#/agents`             | P2-07                             |
| `knowledge`          | `#/knowledge`          | P2-08                             |
| `skills`             | `#/skills`             | P2-09                             |
| `tools`              | `#/tools`              | P2-10                             |
| `models`             | `#/models`             | P2-06                             |
| `models.multimodal`  | `#/models/multimodal`  | P2-06                             |
| `system.storage`     | `#/system/storage`     | P2-11                             |
| `account.files`      | `#/account/files`      | P2-11                             |
| `devices`            | `#/operations/devices` | P2-12                             |
| `workbench`          | `#/workspace`          | P2-13、P2-14、P2-15、P2-16、P2-17 |
| `system.service`     | `#/system/service`     | P2-18                             |
| `system.audit`       | `#/system/audit`       | P2-18                             |
| `account.profile`    | `#/account/profile`    | P2-03                             |
| `account.security`   | `#/account/security`   | P2-03                             |
| `account.models`     | `#/account/models`     | P2-06                             |
| `account.appearance` | `#/account/appearance` | P2-02、P2-03                      |
| `account.mobile`     | `#/account/mobile`     | P2-03、P2-18                      |

官网 `/`、`/website`，初始化/登录/注册/隐私入口，独立文件预览、公开分享、OAuth 回调，以及工作台设备/会话/归档子路由同属必迁范围，不被上述 21 个菜单计数替代。

## 实施任务

### P2-01 基准清单与纵向任务切片

- [x] 输入计划一的工作区快照、API/WS 清单、基础登录/RBAC/导航和独立启动环境；逐项读取 `apps/admin/src/app`、`src/features`、`server/contracts` 与现有测试，不只采集菜单截图。
- 输出新应用 `tests/parity/features.json`：每条记录包含模块 ID、旧来源路径、用户操作、角色、规范/兼容接口、事件、状态、截图场景、目标文件、测试与任务 ID。
- 将每个业务切片按“模型/仓储 → 服务/API → Vue 页面 → 错误与交互 → 用例”推进；需要新表时只通过新后端迁移创建，不调整旧 schema 文件。
- 验收：21 模块及所有非菜单入口均有责任任务；无权限、空数据、加载、失败重试和提交中状态均有基准；未提交业务变更未遗漏，清单/fixture 不混入生产目录。

### P2-02 视觉系统、公共交互与官网

- [x] 证据：`apps/admin/src/app/globals.css`、`src/components/ui`、`management/presentation.tsx`、`components/website`、`messages`、`public/images/website`、本地字体及许可。
- 目标：`F/assets/styles`、`F/components`、`F/views/website`、`F/i18n`；输入冻结截图与主题参数，输出字体、颜色、间距、尺寸、断点、弹窗、表格/卡片、分页和官网完整实现。
- 保留官网 `/`、`/website`、工作台入口、滚动/展示交互、中英文、深浅主题、图片与链接；公共控件保持焦点顺序、键盘、取消、提交禁用、错误保草稿和危险操作确认。
- 验收：固定桌面/移动视口逐状态对照；无缺图缺字、布局溢出和未经登记的视觉差异；构建不临时请求外部字体，保留素材来源和许可证。

### P2-03 账户完整流程与身份状态

- [x] 证据：`src/components/auth`、`console/account-page.tsx`、`management/security-card.tsx`、`features/auth`、`features/mobile-connections`；接续计划一登录基础，不另造身份体系。
- 目标：`F/views/account`、`F/views/auth`、`B/modules/identity`；输入各角色/账号状态，输出初始化、注册、邮箱验证码、密码恢复/强制修改、资料头像、登录记录、注销与账号安全全流程。
- 保留密码 verifier、内存 access token/HttpOnly refresh cookie、刷新单飞、登出/换号隔离、原 OAuth client ID/PKCE/回调、登录后续路由及隐私告知；外观即时生效。
- 验收：旧请求/回调样例可直接调用；过期、拒绝、重复扫码和并发登出不串号；失败保留草稿；账号变化清理临时附件、预览 URL 和旧异步回写。

### P2-04 用户、角色与菜单完整管理

- [x] 证据：`src/components/management/users-panel.tsx`、`roles-panel.tsx`、`console/menus-page.tsx`、`server/management/accounts.ts`、`navigation.ts`。
- 目标：`F/views/access`、`B/modules/management`；输入计划一权限目录与导航服务，输出用户筛选分页/增改禁用删除、角色配置、两级菜单编辑/排序/显示/重置及相应业务 API。
- 保持原权限 ID、服务端授权、分页默认值和无分页旧客户端兼容；菜单版本冲突返回 409；隐藏菜单不撤销合法访问权限，撤权立即移除受限内容。
- 验收：管理员、普通成员、定制角色分别走完整操作链；越权写入被拒绝；冲突不覆盖他人改动；取消不提交，删除/禁用确认与错误反馈匹配。

### P2-05 总览与管理页面生命周期

- [x] 证据：`src/components/console/overview-page.tsx`、`console-shell.tsx`、`features/workbench/agent-lifecycle.tsx`、`server/management/dashboard.ts`。
- 目标：`F/views/overview`、`F/layout`、`B/modules/management`；输入登录身份和可见统计，输出总览统计、入口、加载/错误/空态与模块切换行为。
- 保留管理页不挂载 WorkspaceProvider、不订阅会话 WebSocket、不触发设备全量查询/Agent 准备的边界；首次进入工作台才准备，已有实例复用，失败显式重试。
- 验收：登录到总览和反复切管理页时无多余 DSH 进程；进入工作台只触发规定准备；离开释放订阅但已提交任务继续执行。

### P2-06 平台、个人与多模态模型

- [x] 证据：`src/components/management/models-panel.tsx`、`model-configurations-panel.tsx`、`features/management/models-api.ts`、`server/models`。
- 目标：`F/views/models`、`B/modules/models`；输入供应商/模型/能力与权限样例，输出平台和个人配置、可用目录、模型选择、连接测试及多模态配置的等价接口与界面。
- 对齐默认值、兼容供应商参数、能力限制、错误映射、配置更新后的目录刷新；凭据只在后端存取，返回掩码与保留旧密钥语义按现行为实现，不导入真实凭据。
- 验收：新增/编辑/清空/未改密钥、无权访问、连接失败/超时、模型禁用与权限撤回均可复现；Web/桌面/Android 模型目录字段及选择结果一致。

### P2-07 Agent 定义、资源绑定与试运行

- [x] 证据：`src/components/management/agents-panel.tsx`、`agent-definition-editor.tsx`、`agent-resource-manager.tsx`、`server/agents/resources.ts`、`service.ts`、`definition-readiness.ts`。
- 目标：`F/views/agents`、`B/modules/agents`；输入 Agent 定义与资源状态，输出列表/编辑/历史、模型/技能/工具/知识/资产绑定、就绪校验和试运行。
- 保留资源作用域、版本、发布/草稿、自动/固定/旧指令技能策略与绑定语义；缺失资源/无模型不能静默执行；“试用”只打开主工作台并准备草稿，不自动发送或覆盖已有草稿。
- 验收：现有定义与请求样例逐字段兼容；任意合规工具/技能可组合成新Agent，不新增专用后端分支；编辑/回退/停用立即呈现正确限制，手动发送后的真实DSH结果可追踪。

### P2-08 知识库、解析、索引与检索

- [x] 证据：`src/components/management/knowledge-*`、`features/agents/knowledge-api.ts`、`server/agents/knowledge-*`、`embedding-profiles.ts`、`office/knowledge-parser.ts`。
- 目标：`F/views/knowledge`、`B/modules/knowledge`；输入原文档/索引配置/查询样例，输出资产管理、解析重试、嵌入配置、索引状态、检索参数和来源可追溯的回答输入。
- 保留版本/重建/删除一致性、权限过滤、引用定位、解析失败与部分失败呈现；耗时解析/嵌入在受管理工作进程执行，不能阻塞 FastAPI，也不能把索引状态仅放内存。
- 验收：相同固定样本文档可检索到约定来源；空库、损坏文档、失败重试、改配置重建、删除后不可检索；精确检索与模型生成差异按计划三分别度量。

### P2-09 技能管理与技能程序

- [x] 证据：`src/components/management/skills-panel.tsx`、`skill-program-editor.tsx`、`skill-import-dialog.tsx`、`server/extensions/skill-archive.ts`、`server/agents/skill-package.ts`。
- 目标：`F/views/skills`、`B/modules/skills`；输入现有技能 schema、归档、版本与执行样例，输出导入、编辑、校验、发布、历史、绑定、运行状态及错误展示。
- 保留匹配词/排除条件/输入格式/输出类型、匹配试验、阶段草稿/发布、引用技能冻结版本、修订上限和旧指令模式；执行程序保持 `inspect/submit/prepare/execute/review`，不强制转换成LangGraph格式。
- 复刻同工具相邻 `prepare/execute`、`submit` 多次辅助调用与只读检查、原 `userQuestions.ask` 确认、修订使旧确认失效、阶段真实证据检查、`skillRunId/skillRevision` 与历史记录；不新增模型回合或技能队列。
- 验收：合法/非法/重复包、默认预设删除与定制、自动/固定技能、辅助生图/识图拒绝和修订均覆盖；读取skill-runs接口与三端投影一致；重启标记中断，不自动重放收费工具，运行中编辑不改已有冻结版本。

### P2-10 工具、扩展与 MCP

- [x] 证据：`src/components/management/tools-panel.tsx`、`tool-implementation-editor.tsx`、`tool-configuration-fields.tsx`、`tool-sources-dialog.tsx`、`server/extensions`。
- 目标：`F/views/tools`、`B/modules/extensions`；输入内置目录、JSON schema 和 MCP fixture，输出工具来源、安装/配置/启停/校验、工具实现绑定、连接诊断与能力投影。
- 支持冻结基准已有的 Node/Python 扩展包、MCP stdio/Streamable HTTP、JSON Schema表单、授权配置和进程生命周期；安装期准备依赖、健康检查、版本保留/回滚、MCP Schema变化需重新授权；凭据不进浏览器。
- 验收：将同一示例Agent的工具替换为等价实现，无需修改工作台即可运行；工具新增/停用、超时、配置错、重启和资源释放可见；旧目录兼容，必需引擎保护与工具运行权限均有效。

### P2-11 存储、我的文件与资源附件

- [x] 证据：`src/components/management/storage-panel.tsx`、`files-panel.tsx`、`agent-assets-panel.tsx`、`src/lib/api/download-auth.ts`、`server/files`。
- 目标：`F/views/files`、`B/modules/files`；输入本地/S3策略与测试文件，输出上传、分页、预览、下载、删除、资产绑定、策略配置和维护任务。
- 对齐 MIME/大小/文件名处理、流式传输、失败清理、访问控制和已有下载鉴权规则；登录凭据不附加到不可信下载地址；资源归属和引用不得串用户。
- 验收：附件/库文件/Agent资产/Office产物均能走完整链路；中断重试、无权下载、已删文件、策略错误得到同等反馈；新数据只使用新应用独立测试存储。

### P2-12 设备、运行实例与 DSH 生命周期

- [x] 证据：`src/components/pages/device-page.tsx`、`management/devices-panel.tsx`、`runtime-*-dialog.tsx`、`pair-device-dialog.tsx`、`server/devices`、`features/dashboard/server-agent.ts`。
- 目标：`F/views/devices`、`B/modules/devices`、`B/integrations/dsh`；输入协议目录与设备状态，输出配对、在线状态、运维筛选、运行实例配置/启停/故障诊断/重试。
- 保持固定 DSH、每用户 Home/workspace、租约所有权和既有队列；同用户子进程不是容器隔离；受保护组件不可由普通管理操作卸载或禁用。
- 验收：重复登录/准备不会重复启动；掉线重连、启动失败、进程退出、租约失效均可诊断；平台 API 为 Python，固定引擎、薄适配和外部工具各守边界，不借工具扩展保留旧业务后端。

### P2-13 工作台框架、项目与创建会话

- [x] 证据：`src/components/demo.tsx`、`workspace-context.tsx`、`task-composer.tsx`、`components/sidebar`、`features/workbench/memory.ts`、`server/conversations/workspace.ts`。
- 目标：`F/views/workbench`、`F/composables/workbench`、`F/store/modules`、`B/modules/conversations`；输入项目/设备/会话快照，输出侧栏、项目排序/固定、设备选择、工作区选择、模型与Agent选择、会话创建/归档。
- 保留旧Hash别名、浏览器前进后退、移动布局、可伸缩面板、附件上传、乐观发送和临时会话ID到正式ID的草稿迁移；状态留当前账号内存，刷新不伪装成附件持久化。
- 验收：切模块草稿可恢复、换账号彻底清理；创建失败不丢文本/附件；发送后立刻切页面仍能找回会话；已有项目/会话操作顺序与反馈匹配。

### P2-14 会话流、快照、订阅与恢复

- [x] 证据：`src/components/session-detail.tsx`、`session/session-event-state.ts`、`session-event-buffer.ts`、`timeline-*`、`features/dashboard/api.ts`、`server/conversations/routes.ts`。
- 目标：`F/api/workbench`、`F/composables/workbench`、`F/store/modules`、`F/utils/workbench`、`B/modules/conversations`；输入版本化事件、快照和WS-ticket fixture，输出统一事件投影、流式时间线、恢复游标与断线提示。
- 原样保留 event ID/sequence/cursor/版本语义、快照与订阅竞态、同序号实时投影、去重/缓冲、需要快照的恢复路径；LangGraph 事件不能直接替换公开会话协议。
- 验收：快速完成、订阅前完成、重复/乱序、恢复中到达、旧会话迟到、缺版本和长断线全部测试；最终内容不漏不重、滚动跟随与历史展开符合基准。

### P2-15 审批、输入、回顾与公开分享

- [x] 证据：`src/components/session/session-approval-card.tsx`、`input-request.ts`、`session-review-*`、`public-session-share.tsx`、`turn-actions.tsx`、`src/app/share`。
- 目标：`F/views/workbench/components`、`F/composables/workbench`、`F/api/workbench`、`F/views/share`、`B/modules/conversations`；输入待审批/等待输入/完成/失败快照，输出审批回复、补充输入、停止/重试、回顾历史和分享生命周期。
- 保留请求ID和过期/已处理错误、权限检查、执行中撤权、分享访问边界与撤销；不能用前端隐藏按钮替代后端校验，不重复提交失效审批。
- 验收：刷新/断线后待处理项仍可正确回应；双页面竞争处理结果一致；撤销分享立即失效，公开页不泄露凭据和私有管理入口。

### P2-16 文件工作区、编辑器与终端

- [x] 证据：`src/components/panels`、`file-preview-page.tsx`、`session-tool-sidebar*`、`monaco-code-view.tsx`、`session-terminal-lifecycle.ts`、`lib/file-preview-*`。
- 目标：`F/views/workspace-files`、`F/views/terminal`、`B/modules/devices`；输入文件树/版本与终端状态，输出浏览、预览、编辑保存、独立预览窗口及多终端标签。
- 保留路径面包屑、文件大小/编码限制、保存412冲突、未保存退出提示、下载、终端复用/resize/重命名/关闭、标签切换不误杀会话和断开后的资源释放。
- 验收：两页面冲突编辑不覆盖新内容；取消退出保留内容；终端切换/隐藏/重进不意外新建；Markdown/公式/Mermaid/代码与图片预览按固定样本对照。

### P2-17 可配置 Office 工具包与通用成果契约

- [x] 证据：`server/agents/office`、`office-worker*`、`office-plan*`、`artifact-preview-cache.ts`、`src/components/session/agent-session-artifacts.tsx`、`agent-artifact-preview.tsx`。
- 目标：`apps/web-admin/backend/toolkits/office`、`B/modules/extensions`、`B/workers`、`F/views/artifacts`；输入旧工具/成果契约、可编辑技能/模板与样例，输出Python工具实现、实现描述Schema和示例技能，不新增Office专属平台流程。
- 保留生成/修订、图表/公式、结构化配图、图片素材引用、来源/方案哈希、真实成果复核和渲染质量检查；统一接通通用成果、证据、确认与技能运行记录，技能配置不能关闭工具自身必需检查。
- 自有Office逻辑无旧Node服务兜底；渲染器等外部进程按实现包依赖受管理，Docker声明字体依赖、运行缓存目录、超时与资源限制，不打包本机缓存或验证产物；核心平台仅认识契约和能力，不按PPT/Word助手名称判断流程。
- 验收：同一工具可供不同技能/Agent复用，替换或禁用实现正确影响绑定；DOCX/XLSX/PPTX可打开且数据/公式/图表/修订有效，分页/溢出检查与预览下载一致；图片素材不替代最终文档证据。

### P2-18 服务配置、公告、审计与手机连接

- [x] 证据：`src/components/pages/service-page.tsx`、`service-email-card.tsx`、`service-announcement-card.tsx`、`mobile-connections-page.tsx`、`components/announcements`、`management/audit-panel.tsx`。
- 目标：`F/views/service`、`F/views/audit`、`F/views/mobile-connections`、`B/modules/management`；输入测试服务配置/公告/登录记录，输出配置修改、公告阅读、审计筛选分页及手机会话撤销。
- 对齐邮件/OAuth配置校验、保存失败保草稿、敏感字段掩码、公告门禁与已读状态、审计身份/时间/行为；手机连接页管理登录会话，聊天仍在工作台，已登录手机不强制重复扫码。
- 验收：不发送真实邮件、不修改真实第三方账号；使用测试接收器验证通知；配置错/超时/撤销登录有明确结果；审计可追到对应用户操作且不泄露密钥。

### P2-19 可选的 LangGraph 技能/工具实现

- [x] 输入 P2-07 至 P2-17 的通用资源/执行契约和样例；先登记可被图结构简化的工具内部多步处理或技能状态记录，再实现可选适配，不把普通问答、CRUD与所有技能统一套图。
- 目标：`B/workflows` 和相应工具实现包；输出可替换的内部实现、检查点、步骤输入输出与错误映射；平台入口仍为通用Skill/Tool契约，前端继续消费既有API/WS投影。
- DSH保留技能选择、工具调用与原确认控制权；副作用绑定调用幂等键、run/revision、会话和资源版本；图恢复不得另启模型回合、循环提交DSH任务、自动重放收费调用或改变重启标记中断语义。
- 验收：选用 LangGraph 时，按同一旧行为基准验证图实现的契约；未选用时记录适用性判断，不要求额外开发两套实现。副作用前后崩溃不重复发布成果、迟到响应不覆盖修订、旧确认被拒绝；新增非Office技能与工具不需修改图框架或核心工作台。

### P2-20 分批集成与独立部署回归

- [x] 每批完成运行计划一提供的 `web-admin:check`、`web-admin:build`；使用 `web-admin:dev` 在新入口联调，命令前缀统一，不挪用 `admin:*`、`server:*`。
- 输入新前后端、独立数据库种子、固定DSH资源与Docker定义；输出可从空环境启动的全功能构建，生产静态资源/API/WS反向代理与开发模式行为一致。
- 将Office渲染、知识索引、MCP与DSH所需运行资产显式打包；禁止绝对路径引用旧包、借旧node_modules、依赖本机缓存或后台遗留服务完成请求。
- 验收：停止旧应用后新应用仍通过关键链路；API重启/工作进程失败可恢复；Docker内文件/字体/WS/进程退出实测；静态检查版本来源、路由集中映射、依赖方向、中文契约注释与测试目录隔离，镜像无测试/验证产物，数据与端口不碰旧部署。

### P2-21 向差异验证阶段交接

- [x] 输入所有任务输出与未解决差异；交付 `tests/parity/features.json`、`tests/fixtures` 内请求/事件与测试数据、页面状态/交互场景和固定截图条件；构建运行清单、报告与复现日志保存在对应 `<run-id>` 目录。
- 每个模块至少关联正向、权限、失败恢复及适用的并发用例；非菜单入口、工作台子路由、弹窗和异步状态必须独立编号，不合并成“页面正常”。
- 将既有 `apps/admin/test` 的行为断言迁入新测试框架；React/JSDOM挂载与源码正则检查不能照搬为Vue功能通过证据，旧实现只可作为隔离对照对象。
- 验收：运行第三阶段定义的 `web-admin:parity`，在 `.superdsh-work/web-admin-validation/<run-id>` 输出首份差异清单与规范检查结果；未通过项保持开放，由计划三逐条复测关闭，不将人工未验、条件跳过或模拟设备标记为真实通过。

## 本阶段完成与交接门槛

- [x] 21模块与非菜单业务入口全部实现；没有占位按钮、演示数据代替真实后端、静默降级、旧服务代理或遗漏的权限动作。
- [x] 新应用在开发启动和独立Docker启动下均可走完整链路；只依赖明确声明的基础设施、固定DSH运行资源与打包依赖。
- [x] 行为、视觉、HTTP、WS、Office产物和跨端兼容各自有证据索引；“接口通过”不能代替“用户交互与界面一致”。
- [x] 版本与路由无散落字面量、领域职责与依赖方向清晰、公开契约及并发逻辑有中文说明；健壮性矩阵逐项有失败注入证据，所有测试和过程文件位于规定目录且不进入生产包。
- [x] 保持 `apps/admin` 原样，记录本阶段新增/修改文件白名单；最终验收由[计划三](web-admin-03-parity-validation.md)处理，三份计划均不切换现有默认入口或删除旧实现。

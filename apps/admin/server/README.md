# Node 服务端

平台 API、数据库访问与服务端 Agent 在 `apps/admin/server`，与 Next.js 管理网页共用 Node 24 入口。`server:dev` 一次启动网页、API 与本机 Agent 管理；Docker 仅运行 PostgreSQL / Redis / Qdrant。启动命令见[主 README](../../../README.md#日常开发)，从 Git 获取到生产启动见[部署指南](../deployment/README.md)。

## 模块职责

| 目录                                | 职责                                                                |
| ----------------------------------- | ------------------------------------------------------------------- |
| `main.ts`、`application.ts`         | Next + HTTP / WebSocket 装配、初始化、关闭                          |
| `http`                              | API v2 分发、鉴权入口、取消与错误响应、网络边界                     |
| `identity`                          | 密码、会话刷新/撤销、PKCE、OAuth、扫码、恢复、加密兼容              |
| `management`                        | 用户、RBAC、导航菜单、设备运维、设置、公告、审计、统计              |
| `infrastructure`                    | PostgreSQL、Redis、配置、增量迁移与结构检查                         |
| `devices`、`conversations`、`files` | Connector、会话事件、审批、取消、附件、文件与终端                   |
| `models`                            | 平台/个人供应商、加密 Key、目录、默认模型和流式代理                 |
| `runtime`                           | 按用户的本机 Harness、Node Connector、模型网关与会话同步            |
| `agents`                            | 业务智能体定义、上传资料、会话版本绑定、Host 工具桥接及 Office 成果 |
| `contracts`、`test`                 | API v2 基线、只读协议与隔离测试                                     |

界面继续在 `../src`，不得导入本目录的服务端凭据或进程实现。Agent 由生命周期服务启动，不能在 Next 页面请求或热更新模块中临时创建。

## 执行与授权

```text
Next 网页 / 桌面 / 安卓
  → Node API v2 + PostgreSQL / Redis
  → 所属电脑 Connector，或产品管理的 Node Connector
  → 完整 Harness Host（服务端为本机子进程）
```

保留既有 API v2 路径、字段、错误、事件游标、去重与重连语义。迁移基线覆盖原 193 个路由入口（含 7 个 WebSocket）和 35 张表；路由清单与测试用于防止漏接，不代表每项客户端界面都已验收。

登录 access token 15 分钟，refresh token 30 天并轮换；网页刷新凭据使用 HttpOnly Cookie，原生端使用安全存储。每次操作重新检查账号状态、权限与资源归属，禁用和封锁影响已有连接。管理员不能通过运维接口访问他人聊天、文件或终端。

服务端 Agent 按稳定用户 ID 分目录，数据库绑定和运行租约防止重复实例。Host 与认证 Connector 都就绪才报告可用；退出客户端不终止任务，停止平台则回收所属子进程。Harness 管理任务队列；不自动重放意外中断、可能产生副作用的任务。

新建服务端会话必须使用 `/server-agent` 返回的 `connectorId`、`runtimeId` 和 `projectId`，不能按设备名称、项目顺序或第一个 DSH 实例猜测目标。Windows 工作区的大小写、斜线和尾部分隔符共用同一标识；历史投影也使用这个标识。准备 Agent 时会修复同账号、同设备、同运行实例下的旧重复关联，保留原项目及会话记录。

`create-and-start` 按 `clientMessageId` 记录创建结果：已接受的重复请求返回原会话，明确拒绝返回原错误，正在处理或发送后结果未知返回 `409 / session_create_outcome_unknown`。断网、超时后先刷新会话并核对原消息，不能生成新请求自动重发。界面显示实际失败原因；明确未执行的请求允许恢复草稿后手动修改发送。

**同一系统用户下的进程不提供操作系统安全隔离。** 目录与 API 所有权保护产品状态，不应视为容器、文件系统或终端沙箱。正式使用须按自身运行场景配置宿主权限。

## 数据与升级

启动时执行事务迁移与结构校验，保留账号 ID、设备归属、会话、密码哈希、令牌签名和模型密文格式。必须沿用原 `AGENT_SERVER_SECRET`、`SUPERDSH_MODEL_ENCRYPTION_KEY` 与数据库，不重新生成密钥。

- 支持空库及本产品 `v2_35` → `v2_36` → `v2_37` → `v2_38` → `v2_39` → `v2_40` → `v2_41` → `v2_42`；用户名冲突、孤立设备、缺列或未知版本明确失败并回滚。
- `v2_40` 新增 `business_agent_assets`、`business_agents`、`business_agent_sessions`、`business_agent_artifacts` 和会话 `agent_definition_json`；为内置管理员补入 `agents.manage`，为已保存菜单补入智能体入口，保留原菜单配置。
- `v2_41` 新增 `business_knowledge_bases`、`business_agent_skills`、`business_agent_tools`；独立持久化知识库、执行指令和工具设置，补入三个独立菜单，不覆盖既有菜单定制。
- `v2_42` 将智能体列表、知识库、技能和工具菜单收拢到一级「智能体管理」分组，保留原页面地址及业务数据。
- 更早的 AA 数据库须先使用对应旧版本升级至产品基线，不直接修改版本号。当前版本校验通过后复用，不重建业务数据。
- 原生 Agent 默认生产数据 `.superdsh-work/server-native`、开发数据 `.superdsh-work/server-dev/native`；`SUPERDSH_SERVER_DATA_DIR` 可指定绝对持久目录。
- 文件路径由 `AGENT_SERVER_FILES_LOCAL_ROOT` 控制，开发模式保留原 `agent-server.files`。S3 模式沿用相应配置与对象，迁移不会下载整库文件。
- 旧容器 Home 不自动搬入原生目录；先停旧实例，备份并核对用户归属，再按空目标迁入，不覆盖原卷。源码清理不意味着运行数据可删除。
- 配套环境文件与数据必须一起备份。开发默认管理员仅用于已核实的受管开发空库，不修改已有管理员密码。

旧容器数据使用独立 `server:import-agent-data` 命令迁入，见[离线导出与导入](../deployment/README.md#旧容器-agent-数据离线导入)。传入已有环境文件、绝对导出路径、稳定用户 ID 和原 Connector ID；命令持有平台全局与用户运行租约，核对数据库归属后才复制到空目标，不迁移数据库、不改源数据。导入器拒绝符号链接、活动锁和重叠路径；租约丢失或复制失败会撤回暂存。不要手写标记文件绕过归属验证。

## 模型与网络

个人与平台供应商支持 OpenAI Completions、OpenAI Responses、Anthropic Messages。Key 加密、只写入，读取仅返回已配置状态。服务端新会话优先个人默认，否则平台默认；既有会话保留选择，失效需要用户明确更换，不自动变更费用来源。

模型执行通过内部 Connector 身份代理，不依赖手机登录令牌。平台令牌不写入用户可以任意改址的供应商。代理保留流、工具调用与取消传播，不增加生成重试或第二套队列。

个人自定义供应商默认只允许公网解析。自托管或 Fake-IP 场景由管理员设置 `SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS`，仅列出确切可信 origin（例如 `https://api.deepseek.com`），重启 API 后生效；不要宽泛放行。验证成功只证明连接能力，还需当前会话的实际回复验收。

## 智能体资料与 Office 模板

操作入口和三个虚构企业示例见[主 README](../../../README.md#智能体演示与开发入口)。知识库、技能、工具和智能体分别有独立列表、持久配置、版本与审计，再由智能体关联。当前已发布定义及绑定资料在单平台共享，不含公司租户与员工隔离；技能指令可编辑，工具实现来自代码登记目录，不执行上传脚本。管理接口要求 `agents.manage`，执行与下载仍检查会话归属和执行权限。

`GET /api/v2/agents` 返回已发布列表；`/api/v2/admin/agents` 管理定义，`/admin/agents/assets` 上传文件，`/admin/knowledge-bases`、`/admin/skills`、`/admin/tools` 分别管理资源。四页首次加载自动调用 `/admin/agents/initialize`，在一个事务中准备三个智能体、三个知识库、三个技能、三个工具和四个脱敏文件；保留 `/admin/agents/demo` 兼容接口。后续不覆盖编辑、不复活删除项；旧示例只补缺失的知识库关联。

`create-and-start` 顶层传 `agentDefinitionId`，仅限真实服务端 Agent 目标；创建时固定定义、知识文件、技能指令及工具设置快照。`/sessions/{id}/agent-artifacts` 返回成果清单，`/sessions/{id}/attachments/{fileId}` 返回带 `contentBase64` 的下载对象，沿用现有文件存储，不伪造聊天事件。

资料和模板中的 `.docx`、`.pptx` 可通过 `/admin/agents/assets/{asset_id}/preview` 生成分页 PDF 预览；每次请求先检查 `agents.manage` 与文件维护者归属，再复验 Office 归档。预览使用 Admin 直接依赖的 `@deepseek-ai/libreoffice-kit` 附带引擎，不调用 Harness，也不上传到外部文档服务或修改原文件。每个 Node 进程同时生成一个预览，限时 60 秒、输出最多 16 MiB；忙碌时返回可重试错误，关闭预览会取消转换。每次转换结束或失败都会关闭转换器并清理临时文件。

部署必须保留该库与当前平台所需的引擎可选依赖及其许可证：Windows/macOS 使用附带原生引擎，Linux 使用附带 WASM 引擎。Windows 需要相应架构的 Microsoft Visual C++ v14 运行库；精简 Linux 环境需要安装文档使用的字体。缺失引擎会返回明确错误，缺失字体随预览结果返回并在界面提示；原始 Word/PPT 文件仍可下载。

| 输入       | 当前约束                                                                                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上传资源   | 管理上传单文件不超过 4 MiB；扩展名与实际内容都校验，不接受本机路径。Office 解包最多 600 项、合计 40 MiB、单项 8 MiB，拒绝宏、嵌入对象、外部链接及加密归档                                                                                    |
| 知识       | `.txt`、`.md`、`.csv`、`.xlsx`、`.docx`，文本使用 UTF-8，提取后最多 100000 字符；原文保存到 PG，Qdrant 保存可重建的分块检索索引；没有 PDF、图片或扫描件 OCR                                                                                  |
| 销售台账   | UTF-8 CSV 或 XLSX，最多 5000 行；列为 `orderId,date,region,product,quantity,unitPrice,unitCost`，也支持对应的「订单编号、日期、区域、产品、数量、单价、单位成本」；输入数据使用值，不含公式/错误/链接                                        |
| Excel 模板 | `.xlsx`，只支持文本占位符与样式，不保留用户输入公式。必须包含 `{{revenue}}`、`{{cost}}`、`{{profit}}`、`{{orderCount}}`；唯一的 `{{salesRows}}` 位于明细表 A2–A10 的未合并单元格，其下为空且无合并。数值占位符独占单元格，输出公式由工具生成 |
| PPT 模板   | `.pptx`，1–20 页且页面编号/顺序连续；占位符在名称唯一的普通文本框内，至少有 `{{title}}`、`{{revenue}}`。不支持表格占位符、动画、音视频或任意模板自动改版                                                                                     |

Excel 其他占位符：`title`、`company`、`period`、`source`、`units`、`grossMargin`。PPT 支持 `title`、`company`、`period`、`summary`、`source`、`orderCount`、`units`、`revenue`、`cost`、`profit`、`grossMargin`、`regionSummary`、`productSummary`、`knowledge`，均写作 `{{名称}}`。先下载演示模板修改，未知或未闭合占位符会报错。

知识库页提供索引状态与重建入口；`SUPERDSH_QDRANT_URL` 指向 Qdrant HTTP API，认证使用仅后端可见的 `SUPERDSH_QDRANT_API_KEY`。索引使用英文单词、中文双字词项的归一化稀疏向量，不请求外部 Embedding 模型，也不等同于稠密语义检索。知识检索按维护者、文件哈希及会话绑定检查来源；服务不可用时返回明确错误，不静默伪装为已检索。管理列表、资料上传和默认示例准备不依赖 Qdrant 就绪。

实际规则以 [agents/office](agents/office/) 中的 `validation.ts`、`sales.ts`、`spreadsheet.ts`、`presentation.ts` 为准。工具直接读取绑定资料或本会话销售附件，计算金额并生成真实可编辑文件；模型需要已配置且支持工具调用。聊天附件限 CSV/XLSX、4 MiB：工具用 `attachmentName` 和可选 `attachmentHash` 选择本会话已消费的用户消息附件，经公开 Harness 附件流读取并由父进程复验；不接受任意路径，不取队列中的最新文件，同名歧义或读取失败不退回绑定示例数据。

本轮临时 PG/Redis + 真实 Node API/Connector/完整 Host + **本地工具调用测试模型**已验证：管理上传新 CSV，Excel/PPT 实际收入为 260；知识工具返回经营原则原文及来源；重启临时平台后原会话继续绑定 v2，再上传聊天 CSV 生成收入 777，未误用配置台账 260。Next 无头浏览器与真实 API/Host 的管理操作和主聊天、桌面无头真实 Host 与平台 API fixture、管理端生产构建、Node 服务检查及布局检查分别通过，临时资源已清理。此证据不覆盖真实付费模型、桌面真实 GUI、手机实机、目标系统发布或 Office 客户端视觉验收。

## 配置与验证

开发读取 `.superdsh-work/server-dev/aa-dev.env`，生产入口要求 `SUPERDSH_SERVER_ENV` 指向配置文件。关键变量与 HTTPS 反代见[部署配置](../deployment/README.md#配置与数据)。统一网页/API 默认 `5174`，兼容 API 默认 `8000`，二者连接同一实例；旧 `15174` 需显式设置端口。

根命令 `server:check` 检查类型、测试和 lint，包含 Office、知识检索及聊天附件回归；`server:test:integration` 建立临时 PG / Redis / Qdrant 后运行数据库与运行链路测试并清理。数据库集成测试缺少隔离库配置时明确失败；真实浏览器用例需要测试运行器提供相应标志，否则会跳过。不能把跳过、受控测试模型或 Host 在线当作真实手机、付费模型和正式发布通过。

固定上游协议、Harness 与 AA 子模块保持只读；来源记录在[导入清单](../../../vendor/agents-anywhere/apps-source.json)。历史 Python 测试报告保留原事实，当前执行代码以此目录为准。

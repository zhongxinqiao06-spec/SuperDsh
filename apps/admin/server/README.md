# Node 服务端

平台 API、数据库访问与服务端 Agent 在 `apps/admin/server`，与 Next.js 管理网页共用 Node 24 入口。`server:dev` 一次启动网页、API 与本机 Agent 管理，开发依赖由单独的 Compose 提供。服务器部署可在仓库根目录执行 `docker compose up -d --build`，一起启动平台、PostgreSQL、Redis、Qdrant 和 MinIO；服务端 Agent 仍由平台作为子进程管理。开发命令见[主 README](../../../README.md#日常开发)，默认配置、升级与备份见[部署指南](../deployment/README.md)。

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
| `extensions`                        | 扩展包/MCP 生命周期、配置 Schema、版本、凭据和受管理工具进程        |
| `skills`                            | 配置校验、候选匹配、DSH 阶段约束和独立运行记录，不新增执行队列      |
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

**同一系统用户下的进程不提供操作系统安全隔离。** 目录与 API 所有权保护产品状态；Compose 中的多个 Agent 与 API 共用一个平台容器，并非每个用户独立容器。正式使用须按自身运行场景配置宿主权限。

## 数据与升级

启动时执行事务迁移与结构校验，保留账号 ID、设备归属、会话、密码哈希、令牌签名和模型密文格式。必须沿用原 `AGENT_SERVER_SECRET`、`SUPERDSH_MODEL_ENCRYPTION_KEY` 与数据库，不重新生成密钥。

- 支持空库及本产品 `v2_35` → `v2_36` → `v2_37` → `v2_38` → `v2_39` → `v2_40` → `v2_41` → `v2_42` → `v2_43` → `v2_44` → `v2_45` → `v2_46`；用户名冲突、孤立设备、缺列或未知版本明确失败并回滚。
- `v2_46` 增加 `agent_skill_runs`、`agent_skill_events`，记录技能和阶段的版本、状态与证据；不修改既有账号、会话、供应商或默认模型配置。阶段配置及接入方法见[技能开发说明](../../../docs/agent-extension-development.md#自动匹配阶段与运行记录)。
- `v2_40` 新增 `business_agent_assets`、`business_agents`、`business_agent_sessions`、`business_agent_artifacts` 和会话 `agent_definition_json`；为内置管理员补入 `agents.manage`，为已保存菜单补入智能体入口，保留原菜单配置。
- `v2_41` 新增 `business_knowledge_bases`、`business_agent_skills`、`business_agent_tools`；独立持久化知识库、执行指令和工具设置，补入三个独立菜单，不覆盖既有菜单定制。
- `v2_42` 将智能体列表、知识库、技能和工具菜单收拢到一级「智能体管理」分组，保留原页面地址及业务数据。
- `v2_43` 新增 `business_office_plans`、`business_agent_evidence` 及资料 `source_segments_json`，记录确认方案、会话证据和原文位置，不改原用户及模型密文。
- 更早的 AA 数据库须先使用对应旧版本升级至产品基线，不直接修改版本号。当前版本校验通过后复用，不重建业务数据。
- 原生 Agent 默认生产数据 `.superdsh-work/server-native`、开发数据 `.superdsh-work/server-dev/native`；`SUPERDSH_SERVER_DATA_DIR` 可指定绝对持久目录。
- 文件路径由 `AGENT_SERVER_FILES_LOCAL_ROOT` 控制，开发模式保留原 `agent-server.files`。S3 模式沿用相应配置与对象，迁移不会下载整库文件。
- 旧容器 Home 不自动搬入原生目录；先停旧实例，备份并核对用户归属，再按空目标迁入，不覆盖原卷。源码清理不意味着运行数据可删除。
- 配套环境文件与数据必须一起备份。开发默认管理员仅用于已核实的受管开发空库，不修改已有管理员密码。

旧容器数据使用独立 `server:import-agent-data` 命令迁入，见[离线导出与导入](../deployment/native.md#旧容器-agent-数据离线导入)。传入已有环境文件、绝对导出路径、稳定用户 ID 和原 Connector ID；命令持有平台全局与用户运行租约，核对数据库归属后才复制到空目标，不迁移数据库、不改源数据。导入器拒绝符号链接、活动锁和重叠路径；租约丢失或复制失败会撤回暂存。不要手写标记文件绕过归属验证。

## 模型与网络

`models/configuration-service.ts` 管理连接、配置版本与各能力默认值，`capability-service.ts` 负责已授权工具调用、付费提交收据及结果转存；`connection-compatibility.ts` 用原身份解密旧 Key 后重新封装，保留平台／个人配置。`v2_45` 增加这些表、统一文件元数据及独立 `storage.manage` 权限。聊天继续用原三协议流式代理，火山聊天通过方舟适配接入；语音、视频及本服务的 Embedding 仅有不可用契约。

火山按量 API 使用 `https://ark.cn-beijing.volces.com/api/v3`；Agent Plan 专属 Key 使用 `https://ark.cn-beijing.volces.com/api/plan/v3`，均使用 `Authorization: Bearer <Key>`，两种 Key 不混用。Agent Plan 使用套餐模型名称，例如本轮实测成功的 `doubao-seed-2.1-pro`，不是按量调用的日期版本 Model ID；以[官方接入说明](https://docs.volcengine.com/docs/ark/agent-plan-personal-other-tools?lang=zh)和账户可用模型为准。连接表单提供入口选择，不自动改变默认模型或费用来源。

`connection-check.ts` 只访问模型列表，不自动提交收费请求。`/models` 的 404/405 返回 `requires-trial`，不能据此认定 Key 无效；401 和 403 分别报告鉴权与访问权限问题。若代理 Fake-IP/DNS 返回非公网地址，保持网络保护，由部署管理员仅在 `SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS` 加入明确可信的 origin；开发环境重启 Node 后加载该设置，不对所有私网地址放行。

火山图片生成与参考图编辑遵循[官方图片 API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=en)，视觉使用 Responses（`store:false`）。配置保存模型规格、参考图上限和尺寸；不认识的接入点仅开放兼容的 2K，扩展规格需管理员明确选择。每次生成单张原生图片，不把整页 PPT 变成截图。普通工具参数不接受地址或 Key；默认配置在会话绑定时冻结，禁用／撤权继续检查当前状态。中断请求表示取消意图，不声称供应商已撤销计费。

供应商操作使用账号＋会话＋执行幂等标识和 PostgreSQL 租约，先记账再提交；不明确的受理结果不重发。已返回结果加密保留，存储故障后可用同一操作恢复转存；临时 URL 失效时明确失败，不能自动重新生成收费图片。供应商临时 URL 经地址校验并转存私有文件；不向下载主机转发供应商 Authorization。

`files/file-library.ts` 管理 `FileObject` / `FileEntry` / `FileReference`、8 MiB 分片与不可变版本；实际内容在 local / S3，元数据及授权在 PostgreSQL。`/files` 提供本人文件目录、分片完成、Range 下载与回收站；旧附件接口通过映射保持可读。新知识与模板同时建立文件映射，旧 `content` 原文保留作迁移源。维护命令、固定 MinIO 版本及备份步骤见[存储升级](../deployment/README.md#minio-与文件存储升级)。

个人与平台供应商支持 OpenAI Completions、OpenAI Responses、Anthropic Messages。Key 加密、只写入，读取仅返回已配置状态。服务端新会话优先个人默认，否则平台默认；既有会话保留选择，失效需要用户明确更换，不自动变更费用来源。

模型执行通过内部 Connector 身份代理，不依赖手机登录令牌。平台令牌不写入用户可以任意改址的供应商。代理保留流、工具调用与取消传播，不增加生成重试或第二套队列。

个人自定义供应商默认只允许公网解析。自托管或 Fake-IP 场景由管理员设置 `SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS`，仅列出确切可信 origin（例如 `https://api.deepseek.com`），重启 API 后生效；不要宽泛放行。验证成功只证明连接能力，还需当前会话的实际回复验收。

## 智能体资料与 Office 模板

操作入口和三个虚构企业示例见[主 README](../../../README.md#智能体演示与开发入口)。知识库、技能、工具和智能体分别有独立列表、持久配置、版本与审计，再由智能体关联。当前已发布定义及绑定资料在单平台共享，不含公司租户与员工隔离；技能指令可编辑，工具实现来自代码登记目录，不执行上传脚本。管理接口要求 `agents.manage`，执行与下载仍检查会话归属和执行权限。

`GET /api/v2/agents` 返回已发布列表；`/api/v2/admin/agents` 管理定义，`/admin/agents/assets` 上传文件，`/admin/knowledge-bases`、`/admin/skills`、`/admin/tools` 分别管理资源。以下路径均省略 `/api/v2` 前缀。四页首次加载调用 `/admin/agents/initialize`，在一个事务中准备三个助手、知识库、技能、工具及脱敏文件。v3 原位升级内容完全匹配旧默认值的记录；用户编辑、禁用及删除的记录不覆盖或恢复。向 `/admin/agents/demo` 传 `{ "copyLatest": true }` 可创建新版草稿副本，同一版本重复操作复用副本。

定义支持 `recommendedPrompts`、`inputRequirements`、`outputExamples`；`GET /admin/agents/{id}/readiness` 返回配置检查。发布校验引用及工具依赖；缺少可选输入或模板只提示，不自动绑定示例。配置检查不等于真实模型可用，试用不会自动发送或覆盖已有草稿。

`create-and-start` 顶层传 `agentDefinitionId`，仅限真实服务端 Agent 目标；创建时冻结定义、知识文件、技能指令及工具设置。Excel/PPT 经输入检查、方案确认、生成及校验；只有用户明确选择演示资料时才可使用它们。`OfficePlan` 绑定账号、会话、输入哈希与版本，复用 Harness `userQuestions.ask` 和运行通知响应，不新增队列；等待确认不占用生成超时。修订须重新确认；重复确认复用结果，既有文件保留。

`GET /sessions/{id}/office-plans` 读取方案，`GET/PUT /sessions/{id}/office-plans/{planId}` 读取/修订；`/sessions/{id}/agent-evidence` 返回证据，`/sessions/{id}/agent-evidence/{evidenceId}` 按当前权限复验原文。`/sessions/{id}/agent-artifacts` 返回成果及来源/版本，`/sessions/{id}/attachments/{fileId}` 下载 `contentBase64`；沿用存储和会话归属检查，不伪造聊天事件。

| 输入             | 当前约束                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 资料与附件       | 单份输入不超过 4 MiB；扩展名与内容双重校验，只接受当前会话有权使用的资源、已消费附件或历史成果，不接受任意路径。Office 解包最多 600 项、合计 40 MiB、单项 8 MiB；拒绝宏、外部链接及加密归档，PPT 原生图表内嵌工作簿按受控关系单独校验                  |
| Excel            | UTF-8 CSV / XLSX，多文件、多工作表，可选表头行及字段映射；每表最多 5000 数据行、64 列。清洗、去重、筛选、排序、拼接、关联、分组、交叉统计及原生图表；数字文本须显式转换，金额使用精确十进制计算，不合计混合币种或凭空补成本                            |
| Excel 公式与模板 | 使用受控公式 AST，支持算术、条件、汇总、精确查找与日期函数；保留可编辑公式及程序计算缓存。模板保留支持的原页/样式/公式并追加结果页，不任意覆盖原单元格。不支持公式会在预检报错；输入已有图表/透视表等不能无损保留时，须明确同意仅提取数据，模板则拒绝  |
| PPT              | 无需销售表，支持文本、公司知识、表格及图片。确认受众、目的、页数、提纲和风格；标题、正文、表格及图表可编辑。模板按实际页面关系顺序读取，以页面用途和区域映射适配，不强制销售占位符；限 1–20 页，不支持动画、音视频或组合对象，预检说明不兼容及溢出风险 |
| 知识             | TXT、Markdown、DOCX、CSV、XLSX、文字型 PDF；保留标题、段落、PDF 页码、表名及行号。表格解析不要求销售字段；扫描件、加密文件及无有效文字明确报错，不提供 OCR                                                                                             |

知识位置与授权保存在 PostgreSQL，新原文通过文件服务保存；历史数据库原文保留作迁移源。Qdrant 保存可重建的稠密/关键词索引，RRF 合并结果。`SUPERDSH_QDRANT_URL` 与仅后端可见的 `SUPERDSH_QDRANT_API_KEY` 配置连接。知识库「索引与检索」查看每份资料状态、重试和原文；Qdrant 或 Embedding 不可用不会阻塞管理列表，但检索明确报错，不静默回退成假检索。

旧资料缺少位置元数据时不会虚构页码。维护者在「索引与检索」选择「重试索引」，从保存的原文件重新解析，补充定位并保留资料 ID、原字节及哈希；失败保留原记录并显示具体原因。

原生部署的默认本地 Embedding 为 `Xenova/bge-small-zh-v1.5`，revision `75c43b069aac4d136ba6bc1122f995fedcfd2781`，q8 ONNX、512 维。根目录执行 `corepack.cmd yarn server:knowledge:prepare` 提前下载并逐文件校验 SHA256；读取开发环境中的数据目录，允许 `SUPERDSH_EMBEDDING_MODEL_DIR` 覆盖。根 Compose 默认使用 Ollama，启动时校验 `quentinz/bge-small-zh-v1.5:q8_0` 的摘要和 512 维向量输出。知识库通过 `/admin/knowledge-embedding` 独立配置本地或 OpenAI 兼容 Embedding；保存和全局重建要求同时拥有 `models.manage` 与 `agents.manage`，每批请求及配置提交前复验权限。Key 加密且只写入。

外部资料外发许可由部署环境 `SUPERDSH_KNOWLEDGE_EMBEDDING_TRUSTED_ORIGINS` 控制。原生部署默认为空，根 Compose 默认允许项目内的 `http://ollama:11434`。配置示例为 `https://embedding.example.com,https://approved-provider.example`；值只能是完整 origin，无路径、凭据、参数或通配符。网页无权修改信任列表。该设置表示企业部署方批准平台知识向这些服务发送，不能把网络连通性当作资料授权。网络层仍独立校验所有 DNS 地址并固定连接目标，拒绝重定向；私网端点还需 `SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS`，后者不能替代外发许可。已有外部配置在新环境未被信任时，平台仍启动，但知识调用返回明确的 403，不发送 Key 或资料，不自动换供应商。

更换 Embedding 会构建独立索引代次，成功才切换；失败保留原模型及索引，不自动更换费用来源。引用 ID、来源权限与摘录由服务端核验；证据只能支持其对应内容，不能把未经核验的整篇模型回答标为可信。原文不可用、权限变化、资料冲突或无依据须在回答中明确。

资料的 DOCX / XLSX / PPTX 经 `/admin/agents/assets/{assetId}/preview` 生成分页 PDF；会话成果使用 `/sessions/{id}/agent-artifacts/{artifactId}/preview`。请求复验权限及归档，使用 `@deepseek-ai/libreoffice-kit`，每进程同时一个转换、60 秒、最多 16 MiB，支持取消并清理临时文件。预览不改原文件，不把 PDF 渲染成功当作 XLSX 已重算。部署保留引擎可选依赖和许可证；Windows/macOS 使用原生引擎，Linux 使用 WASM，Windows 需 VC++ v14，中文字体缺失会提示，原文件仍可下载。

实现入口为 [agents/office](agents/office/) 的 `generic-spreadsheet.ts`、`generic-presentation.ts`、`knowledge-parser.ts`，方案与文件授权在 `office-plans.ts` / `office-sources.ts`；模型需支持工具调用。旧工具 ID 和销售专用导出保留兼容，新方案走通用实现。测试模型、真实模型、实际渲染和 Office 客户端检查分别记录，不将历史销售案例通过结论扩大为本轮全部能力验收。

## 配置与验证

### 可配置工具与 JSON 配图

工具管理中选择实现、版本和 Schema 配置；「扩展来源与 MCP」安装包、连接远端、检查、启停和回滚。安装代码需要单独的 `extensions.manage`，默认只授予内置管理员。技能管理支持导入 ZIP，或选择已安装扩展的技能及配置好的依赖工具；引用资料和技能版本一同提交，失败整体回滚。资源历史可恢复为新版本，已冻结会话不随编辑变化。

默认配图使用 `illustration_render`：聊天模型工具调用输出 JSON，固定字体、布局、文字度量和 resvg 渲染真实 PNG。流程、时间线、组织、对比和指标图不需要额外 Key。PNG 保存为当前会话成果，再由 PPT/Word 工具用 `artifactId` 和 `role: image` 引用。原生标题、正文、表格及数字图表仍保持可编辑，不把整页截图当作演示文稿。可选 `image_generate` 只在明确配置并授权后调用 Images 服务，不作为默认回退。

`server:sync` 和正式构建准备固定 Noto CJK 字体并校验 SHA256；未准备时绘图明确报错。PPT/Word 使用最终文件实际渲染检查，最多两轮规则修正，关键问题标为草稿。规则与渲染检查不代表视觉模型或 Office 客户端验收。开发清单和包示例见[扩展工具与技能开发](../../../docs/agent-extension-development.md)。

开发读取 `.superdsh-work/server-dev/aa-dev.env`，原生生产入口要求 `SUPERDSH_SERVER_ENV` 指向配置文件；Compose 自动初始化并持久保存配置。关键变量与 HTTPS 反代见[部署配置](../deployment/README.md#默认配置与数据)。统一网页/API 默认 `5174`，兼容 API 默认 `8000`，二者连接同一实例；旧 `15174` 需显式设置端口。

根命令 `server:check` 检查类型、测试和 lint，包含 Office、知识检索及聊天附件回归；`server:test:integration` 建立临时 PG / Redis / Qdrant 后运行数据库与运行链路测试并清理。数据库集成测试缺少隔离库配置时明确失败；真实浏览器用例需要测试运行器提供相应标志，否则会跳过。不能把跳过、受控测试模型或 Host 在线当作真实手机、付费模型和正式发布通过。

固定上游协议、Harness 与 AA 子模块保持只读；来源记录在[导入清单](../../../vendor/agents-anywhere/apps-source.json)。历史 Python 测试报告保留原事实，当前执行代码以此目录为准。

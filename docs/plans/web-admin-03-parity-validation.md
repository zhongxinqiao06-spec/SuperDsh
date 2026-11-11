# Web Admin 重写计划三：差异验证与交付准入

本计划定义新管理端与当前工作区旧管理端的功能、API 和交互验证范围；实际执行和通过状态以本页实施进度及关联报告为准，任务要求本身不代表已经通过。

## 模型选择与发送稳定性追加验证（2026-11-10）

- [x] 修正同名条目实际连接不同的问题：受管服务端目录只返回当前账号授权配置与 DSH 实际目录的交集，排除未配置凭据的引擎内置项、其他账号及已撤销模型。保留真实个人／平台同名连接和引擎不透明选择 ID；不修改固定引擎或远程设备目录。
- [x] 下拉默认项置顶，配置名称与个人／平台、供应商来源分开展示，默认模型及权限直接回显。旧的失效选择明确提示重新选择，不自动切换供应商。新建、继续发送和修改选择均在后端校验授权，推理子项同样校验；已完成发送优先返回收据，不因配置变化重发。
- [x] 修复发送闪动：继续提问只合并快照，保持当前订阅与控件；首次创建拿到快照后再切换会话，承接模型与权限；未到达的状态字段不清空选择。发送按钮加载态保持固定宽度。与旧管理端的配置默认值、真实运行选择思路对齐。
- [x] 55 项后端用例、12 项前端选择／上传生命周期用例通过；3 项浏览器用例覆盖首次发送、延迟快照、连续提问、订阅不重建，以及历史输入栏明暗主题、空闲／执行／只读、窄屏。TS、Python 类型、Ruff、ESLint（无错误）、格式和所有权检查通过，旧包 740 文件指纹保持不变。
- [x] 当前开发环境真实目录及浏览器核对：仅显示 DeepSeek Flash、DeepSeek Pro、火山 Doubao、阿里云 Qwen 四项配置，默认 Flash 置顶，未再出现无凭据的原生重复项。本轮没有新发外部模型请求、没有生成测试会话或成果；合成浏览器数据随上下文关闭释放，实读登录已退出。证据在 `.superdsh-work/web-admin-validation/model-selection-ux` 的 `backend.xml`、`fronted-tests.json`、`browser-final/browser-results.json`、`actual-menu.json` 和截图。本轮不改变整体 `fullParity: false` 结论。

本次目录过滤替代下方早期“只校正原生条目显示名称”的处理，保留名称来源于配置的规则。

## 历史会话删除与终止追加验证（2026-11-10，真实 PPT 流程已通过）

- [x] 输入栏底部统一单行：设备、智能体、模型、推理与权限按内容分配可伸缩宽度，附件与发送固定在两侧；输入卡被侧栏挤窄时按卡片实际宽度收起模型设置，沿用同一状态抽屉，监听随组件卸载释放。1440/1280/1000/390 宽度截图与边界检查通过，紧凑抽屉保留模型、Low 与权限选择；已有浅/深色历史会话空闲、运行、只读和窄屏 2 项浏览器回归通过，未发送模型请求、未写业务测试数据。证据：`.superdsh-work/web-admin-validation/composer-single-line`。
- [x] 同日模型名称显示修复：DSH 原生目录返回 `DeepSeek-V41-Flash`，后端配置与供应商目录为 `DeepSeek-V4.1-Flash`。管理端目录适配按当前账号授权配置同步名称；原生项需供应商名与模型 ID 同时匹配且配置名称唯一，有歧义保留原名。选择 ID、供应商身份、启用状态与推理选项不变，不在业务代码硬编码版本号、不修改固定 DSH。6 项名称边界与 33 项既有默认模型回归通过，浏览器实际下拉显示包含小数点，证据在 `.superdsh-work/web-admin-validation/model-label`。
- [x] 历史菜单增加删除及二次确认；服务端按当前账号授权，运行任务先核对 DSH 状态，未停止时拒绝删除。删除清理平台消息、事件和分享，保留会话身份与执行收据以防旧请求重发；独立生成文件保留。迟到投影和完整同步不能恢复已删除历史。
- [x] 终止只提交一次，按钮等待真实持久状态变为空闲或异常，15 秒未确认给出明确提示；切换会话、换号和卸载停止旧等待。侧栏随当前会话状态更新，不继续保留旧的 starting/running 标签。
- [x] 本轮只读诊断发现管理员三条 starting 记录对应 DSH 返回 `SESSION_NOT_FOUND`。新增缺失诊断会明确标记异常，可删除后新建，不自动重发原请求，也不宣称任务已成功终止；并发序列变化时拒绝覆盖。未替用户删除这些记录。
- [x] 56 项后端内存/投影回归、7 项前端状态测试及 1 项无头浏览器操作流程通过。浏览器覆盖取消删除、运行拒删、等待终止、侧栏空闲回显、恢复输入、删除当前会话及刷新后不出现；这组浏览器接口为合成数据，不属于真实 DSH 验收。前后端类型、Ruff、ESLint、格式、若依分层和所有权检查通过，旧包 740 文件指纹不变。
- [x] 隔离 PostgreSQL 的删除事务、分享失效、读取授权、列表过滤和重放验证已执行；删除、批量会话与工具执行组合 10 项通过，工具阶段回归 9 项通过（包含新增的中断撤销与正常修改方案两种意图）。独立容器、测试库与测试 Home 由 runner 清理。
- [x] 使用已发布的“PPT 演示助手”和当前配置的默认 DeepSeek，通过真实 DSH 验证思考中终止、等待方案确认时终止、同会话继续并重新确认。修复等待确认的取消传播：DSH 问答取消后用独立短时限撤销 Python 的原收据与技能，不触发执行；原方案 cancelled，新方案与技能使用新身份。
- [x] Windows 可选 Office 渲染器复用固定 DSH 依赖树中的 LibreOfficeKit，校验公开安装清单、路径与程序摘要，显式 CLI 配置优先，不在运行时下载、不改固定引擎。16 项会话生命周期与渲染测试通过，其中 6 项为清单边界、CLI 优先及真实中文 PPT 渲染；引擎确认取消控制测试 1 项通过。
- [x] 长 PPT 流程复现 DeepSeek 最终回复被 DSH 判为 CONTEXT_WINDOW_EXCEEDED。启动配置原先缺少 contextWindow；调用该连接的只读 `/models` 获得准确容量后，补入后端私有配置的两个 DeepSeek 聊天模型，保留现有输出上限、密钥及默认选择。官方字段依据见 [DeepSeek 模型目录](https://api-docs.deepseek.com/api/list-models/)，实际无凭据响应保存在 `model-metadata.json`。重新启动后真实生成完成、最终回复持久化、会话 idle。
- [x] 最终验收生成 4 页可编辑 PPT（51 个原生文本形状），下载摘要与成果记录一致；真实渲染 PDF 4 页、无缺失字体、无越界字符、文本保留通过，逐页查看截图无截断。浏览器显示成果入口、已完成技能和空闲输入栏；删除历史并刷新后不再出现。PowerPoint 桌面客户端仍未验证，不宣称原生 Office 全量覆盖。
- [ ] 临时运行文件与成果物理清理：自动审批以 `blocked by policy` 拒绝清理，不重试、不绕过。全部本轮临时账号已撤销、所属 DSH 停止；无成果的两次账号数据已清理，生成成果的两次账号记录与物理对象保留，以便核对引用后完整清理。旧用户、全局智能体、模型配置和数据库卷均保留。

证据位于 `.superdsh-work/web-admin-validation/session-lifecycle`：原回归 `backend.xml`、`fronted-tests.json`、`e2e/browser-results.json`；本轮 `database.xml`（10 项）、`confirmation-database.xml`（9 项）、`final-backend.xml`（16 项）。`live-ppt-a08f5a30-fe7d-43f4-a89c-3dc15703a3a3` 保存取消前后、继续后的新方案、首次成果和删除刷新记录；`live-ppt-21b194a9-17e3-4c9c-b87e-730b6ab56236` 保存容量修正后的最终成功快照、`verification.json`、PPT/PDF 和逐页截图。实测使用新建临时 member 账号，模型/权限不手动选择；没有替管理员删除原历史会话。测试启动的前后端结束后停止，Docker 开发数据库保留运行。

原 Docker 环境阻塞已由用户恢复，本轮已使用健康的 PostgreSQL/Redis 完成实测，没有重置 Docker 或删除业务数据库卷。启动时同时修复用户模型 JSON 中一处多余字符和一处缺失引号，仅恢复合法配置，不输出或复制真实凭据。上述验证针对本次会话删除、终止和代表性 PPT 链路，不改变第三阶段整体 `fullParity: false` 的结论。

2026-11-09 补充外部模型实测证据：用户配置的 DeepSeek Flash/Pro 与火山 Agent Plan 短请求均返回 `OK`；默认助手在固定 DSH 中分别使用默认 Flash、显式火山 Doubao，完成真实调用、助手消息持久化与完成事件回放，实际模型身份核对一致。对应记录见计划二及 `.superdsh-work/web-admin-validation/live-models-20261109`。该代表性链路关闭“尚无外部模型实测”的空白，不将其扩张为所有供应商、模型参数、Office 工具、图片或新旧全量差分通过；`fullParity` 仍为 false。

计划一交付的源码指纹为 `df4b278c5207e583987260417cc18b57939c83a1ec295fd603ef6cecde6dc257`（740 个旧包文件），清单位于 `tests/fixtures/baselines`。第二阶段已实现 `web-admin:parity` 首版结构报告：核对旧包指纹，装配真实新路由与 OpenAPI，比较 274 HTTP + 7 WS 冻结入口，检查集中兼容映射、若依依赖边界及 21 任务/21 模块/非菜单场景的具体测试索引。报告写入 `.superdsh-work/web-admin-validation/parity-<run-id>`，Schema 投影差异、缺少 Schema、未运行的行为/视觉/真机差分分别保留，不能仅凭路径数量或索引存在判定等价。

`corepack yarn web-admin:parity` 现已接入本轮实际执行：证据门禁反例、旧新处理器与 Office 语义差分、隔离 PostgreSQL/Redis 上的双 HTTP/WS 和选定正向业务场景。退出码零只代表报告中列明的本轮自动套件通过；失败、漏证据、跳过或资源清理失败返回非零。`corepack yarn web-admin:parity --report-only` 只运行结构检查，不启动服务；两种报告均保留 `fullParity: false`，完整 UI、真实 DSH、Docker、设备与原生 Office 门槛分别记账，不能从测试索引或历史 JSON 推导通过。两种命令均不使用真实用户数据或外部付费模型。

前置与交叉引用：[计划一：工程基础](web-admin-01-foundation.md)、[计划二：功能与交互](web-admin-02-function-and-interaction.md)。新前端路径固定为 `apps/web-admin/fronted`，新后端为 `apps/web-admin/backend`，保留用户指定的 `fronted` 拼写。

工程规范以 [新管理端 AGENTS.md](../../apps/web-admin/AGENTS.md) 为权威；P3-14 是 P3-12 准入及 P3-13 结论的前置门槛，任务编号不代表可以跳过依赖。

## 开发启动故障追加修复（2026-11-10）

阶段验收后，日常开发命令出现 `WinError 1225`。检查确认 Docker 恢复后，开发 PostgreSQL、Redis 容器仍为停止状态；数据库端口拒绝迁移连接。已通过 `web-admin:init` 恢复原依赖，配置文件 SHA256 未变；开发 PostgreSQL、Redis 声明并应用 `unless-stopped` 恢复策略。原生 Python 入口仍不负责启动 Docker；依赖被手动停止时先执行初始化命令恢复。没有重启 Docker 来测试恢复策略，策略声明、实际容器配置及 Compose 解析已核对。

迁移连接失败现在显示脱敏 PostgreSQL 地址与恢复命令，建连超时显式限定为 10 秒；权限、文件与未知结构等非网络错误保持原有语义。此追加修复执行 24 项定向测试、Ruff/格式及 4 文件 mypy，全部通过；不将它们写成又一次全量检查。证据：`development-connection-diagnostic-20261110/summary.json`。本次两个 `pytest` 临时目录删除另被自动审批以 `blocked by policy` 拒绝，未重试或绕过，清理例外保留在该报告。

已在日常开发配置下实际执行 `uv run python main.py`，按既有链完成待执行迁移，`/api/health/ready` 与 `/api/auth/config` 均返回 200，已有管理员无需初始化。只做健康与公开配置读取，未创建测试账号、会话或文件。验证后后端及重载进程均停止，8001 无监听；PostgreSQL、Redis 保持健康供用户启动，源码 `.pyc` 为 0，旧包 740 文件未变。恢复证据：`startup-connectivity-20261110/results.json`；恢复命令已补入新管理端 README。

## 后端模型启动配置追加实现（2026-11-10）

按用户后续要求，将一次性导入改为正式后端启动读取；随后按明确指定的位置修正为 `apps/web-admin/backend/config/model-defaults.json`。默认路径由后端源码位置定位，不随 cwd 或 `.superdsh-work` 设置改变；原生入口忽略旧导出文件中的模型路径，仍支持终端显式 `WEB_ADMIN_MODEL_DEFAULTS_FILE` 覆盖。实际配置位于用户指定目录但排除 Git 和 Docker 构建上下文，仅提交 `backend/config/model-defaults.example.json` 空模板；生产将宿主机文件只读挂载到容器对应的后端 config 路径。

模型领域的启动 service 在同一模型事务锁内应用连接、能力配置和默认值；稳定标识保留原会话绑定，密钥加密，完全相同的配置不增加修订。文件明确声明的记录以文件为准，未声明的个人/其他平台记录不受影响；非法配置整体回滚模型同步并中止启动。现有 DeepSeek/火山两条连接、三个模型已迁入正式开发文件，默认仍为 DeepSeek Flash；与原配置密钥及现库字段逐项只读核对一致，没有付费模型调用，也未停止用户正在运行的后端。

追加验证见 `.superdsh-work/web-admin-validation/model-startup-configuration`：最终 41 项后端定向回归、7 项 Node 配置测试通过；覆盖真实应用 lifespan 首次/重复/修改配置重启、并发幂等、默认目录、密钥轮换、无效文件后恢复、事务回滚与个人数据保留。Python 类型/格式、TS、ESLint、若依分层及所有权检查通过，旧包 740 文件未变，源码 `.pyc` 为 0；本轮专属数据库/容器/Home 已清理。Compose 已解析，并用现有生产运行镜像挂载当前源码验证 UID 1000 可读取只读配置；没有把该定向探测表述为重新构建镜像或全量 Docker 生命周期验收。用户重启自己的后端后即可启用新配置读取路径。

配置目录修正的定向证据另存 `.superdsh-work/web-admin-validation/backend-config-location`：41 项 Python、7 项 Node 配置测试通过，覆盖后端默认路径、不同工作目录、忽略旧导出路径及显式环境覆盖。原生 `uv run python main.py`、组合开发、前后端分别开发及构建产物启动四组生命周期验证通过；首次组合开发退出超过断言时限，保留失败记录，串行复跑全部通过，未放宽断言。相关 TS/Python 类型、格式、所有权和旧包指纹检查通过。使用合成配置验证 Docker 构建上下文排除真实文件名，以及 UID 1000 从容器后端 config 读取只读挂载；未重新执行全量生产镜像生命周期。实际配置迁入指定目录后逐字节一致，Git 已忽略，导出启动路径已更新，源码 `.pyc` 为 0，本轮验证专属数据库、容器与进程已清理。

旧 `.superdsh-work/web-admin-dev/config/model-defaults.json` 副本的删除被自动审批以 `blocked by policy` 拒绝，未绕过或重试。该副本仍在，但新后端默认启动和部署不再读取它；此清理例外不标为完成。旧平台自己的配置文件保持不变。

## 工作台准备状态追加修复（2026-11-10）

用户反馈一直“准备中”且无法聊天。只读检查时，当前用户 DSH 已为 `running`，新浏览器进入工作台可正常显示就绪；未取得用户原浏览器的失败请求，不能断言其当时具体网络错误。通过合成故障复现：准备期间第三次状态请求返回 503，旧前端停止轮询，永远保留 starting。现将同步职责拆入 `composables/workbench/use-runtime-readiness.ts`，暂时性读取失败最多尝试 4 次，准备超过 3 分钟显示“状态待确认”与“刷新状态”；只重试状态和目录读取，不自动重复启动或提交模型消息。列表初次失败不再阻断状态轮询，账号切换、卸载及请求乱序均有保护。

定向前端回归 21 项、生产及测试 TS 类型检查、ESLint、格式检查通过；浏览器分别验证单次 503 后自动恢复、持续失败停止请求后手动恢复，两者均变为“已就绪”、发送可用且没有重复启动请求。真实隔离账号经固定 DSH 与默认助手，使用默认 `deepseek-flash` 和显式 `doubao-seed-2.1-pro` 各完成一次短请求；两次均回复 `OK`、助手消息持久化、结束序列已提交，实际使用模型一致。旧探针最初因新账号首次改密门禁失败，修正后又因误将 HTTP 恢复接口当成完成事件重放而超时；DSH 日志证明该轮已回复，按当前持久完成序列修正验证后通过，保留原失败记录，不将其描述为模型调用失败。

证据统一位于 `.superdsh-work/web-admin-validation/runtime-preparing`：`reproduction-before.json`、`browser-recovery.json`、`fronted-tests.json`、两张恢复截图及 `live-chat-final/{evidence.json,completion.json}`。本次所有临时账号及其业务数据库记录已精确清理，测试 DSH 进程已停止，用户原前后端与 DSH 保持运行，旧包 740 文件核验未变。两个测试 Home/工作目录的删除被自动审批以 `blocked by policy` 拒绝，未绕过或重试；它们仍位于开发运行目录，具体位置在 `live-chat-retry/completion.json`、`live-chat-final/completion.json` 中，`filesystemDeleted` 保持 false。本次定向验证不替代全量差分或其他供应商的 DSH 验收。

工作台入口位置后续调整：按用户标注，将新会话上方的服务端 Agent 与业务智能体两张卡片收进输入框底部工具栏。独立展示组件 `NewSessionSelectors.vue` 通过 props/emits 复用原用例；执行设备下拉保留状态、准备/刷新操作和说明，智能体下拉保留通用对话、选择与目录刷新，模型及权限选择继续并列。准备状态以底部状态点和可访问文本提示，错误仍由页面明确展示；窄屏自动换行。已实测 1440、900、390 三档浏览器宽度下选择、刷新和边界布局，以及准备失败后的手动恢复；原“准备一次、切页保稿、退出清理状态”浏览器回归通过。类型、ESLint、格式及旧包指纹检查通过；证据在 `.superdsh-work/web-admin-validation/composer-controls`，全部使用合成请求，未创建后端业务测试数据。

通用对话默认模式修复：用户不选业务智能体、已选模型和权限时，创建请求缺失顶层 `agentPreset`，固定 DSH 在创建前返回 `Choose a default Agent mode in the AA Runtime configuration.`。之前真实模型探针仅覆盖绑定“默认助手”，没有覆盖这个分支。新增运行领域 `AgentSelectionService`，首次创建从 `catalog.listAgentPresets.configField.default` 读取模式并核对可用性；不硬编码模式 ID，不隐式绑定业务助手，不覆盖显式预设或既有会话。默认解析位于执行收据占位之前；配置缺失/不可用以稳定中文错误拒绝，外层只释放明确未提交的占位，未知执行结果仍禁止自动重发。

追加验证：默认模型/模式与外层收据共 37 项回归通过，包含通用会话、显式业务预设保留、缺失/禁用模式、幂等重放和失败占位释放；7 文件 mypy、Ruff/格式、所有权及旧包 740 文件检查通过，源码 `.pyc` 为 0。真实临时账号不传 `agentDefinitionId`，分别用默认 DeepSeek、显式火山模型及显式只读权限，经当前开发后端和固定 DSH 完成两次 `OK` 回复；业务绑定为 null，原生模式等于目录默认，结束序列及回复已持久化。证据在 `.superdsh-work/web-admin-validation/general-chat/{junit-final.xml,live}`；首次 pytest 因输出父目录不存在而未完成，创建目录后复跑，原失败报告保留。真实 Host 受控模型集成源同步加入不传预设及最终模式断言，本次未另跑该完整长场景，不计为新增通过证据。

本轮临时账号及全部关联业务数据库记录已清理，测试 DSH 已停止。唯一测试运行目录的删除被自动审批以 `blocked by policy` 拒绝，未绕过或重试，`live/completion.json` 的 `filesystemDeleted` 保持 false。用户开发后端随源码热更新继续运行；浏览器刷新后重新选择模型/权限并发送，避免沿用此前失败尝试的请求标识。本次未自动重发用户消息，也未清除用户原会话或未知收据。

## 通用对话默认选择与历史输入栏追加修复（2026-11-10）

- [x] 默认模型、原生模式与权限在首次创建时统一补齐。模型读取当前账号已授权的个人／平台默认；权限通过自有引擎适配控制通道读取同一 DSH Host 的公开 `permissionPresets.defaultPreset`，再匹配引擎目录的真实 `selectionId`。不按目录顺序猜选、不硬编码权限名、不隐式绑定业务助手；显式选择及历史会话原选择保留。
- [x] 前端目录回显实际默认模型和权限；新草稿不保存猜测的默认 ID，发送时由后端读取当前配置。默认配置错误、禁用、读取超时或引擎断开在提交前拒绝并释放明确未提交占位；控制读取有并发上限、总超时、取消与迟到响应清理。
- [x] 历史输入栏统一显示“通用对话”，修复禁用文本框恢复内部边框、嵌套 scoped 样式导致模型／权限整组换行。布局按输入卡实际宽度响应；窄栏将选择区与接管／附件／发送操作分行，选择项继续对齐，手机复用设置抽屉。
- [x] 当前开发后端 + 固定 DSH + 真实模型的浏览器完整流程：独立临时账号登录，连续两次不选模型／权限／业务智能体直接发送，从侧栏点击第一条历史记录，取消接管后恢复，再继续发送。三个回合均持久化 `OK`；业务绑定为 null，实际模型为后端默认 `deepseek-flash`，原生模式为 Host 默认 `standard`，权限为 Host 默认 `workspace-write`，继续会话前后配置一致。没有自动重发用户请求。
- [x] 定向回归通过：53 项 Python、5 项前端选择测试；浅／深主题两项浏览器用例覆盖空闲、运行、只读三种历史状态与 1440／1204／900／390 四档宽度，断言输入边框、选择项同行及按钮不越界。真实流程后的窄栏断点微调由这组无付费模型的合成布局回归复验。TS、14 文件 mypy、Ruff、ESLint、格式、若依分层和所有权检查通过；旧包 740 文件指纹不变，业务源码 `.pyc` 为 0。

证据集中于 `.superdsh-work/web-admin-validation/default-chat-flow`：`evidence.json` 是最终真实流程，`backend-results.xml`、`fronted-tests.json`、`history-layout/browser-results.json` 分别对应回归；截图记录真实聊天及合成布局。前三次探针分别因自动标题变更、Element Plus 隐藏原生 switch、缺少接管确认步骤而中断验收，记录保留在 `before-*` 子目录；已修正测试交互，不以这些失败尝试宣称完整通过。

四次真实探针创建的 4 个临时账号、8 条会话及关联业务数据库记录均按精确归属清理，专属 DSH 已停止；用户开发服务保持运行。三个前序临时 Home 目录的删除命令被自动审批以 `blocked by policy` 拒绝，未重试或绕过；后续目录也保留，四份 `cleanup.json` 的 `filesystemDeleted` 均保持 false，并记录唯一目录供后续处理。此清理例外不标记完成。本追加验证不等于再次全量 Docker、客户端或新旧差分验收。

## 第三阶段实施进度（2026-11-10，本轮自动套件已通过）

阿里云 Token Plan 接入验证：用户确认套餐类型后，在后端实际配置中添加专属连接及 `qwen3.8-flash` 聊天模型，保留全部既有默认选择；开发配置仅新增 Token Plan 精确来源并重新导出环境。本次两次真实最小调用分别验证直连 HTTP 200 与后端正式流式代理，均返回 `OK` 且正常结束；没有创建测试账号、会话或业务文件。通过正式启动 service 同步当前库，重复同步修订不变，密文解密与配置密钥一致，平台供应商投影可读取。证据见 `.superdsh-work/web-admin-validation/aliyun-token-plan/{connection.json,platform.json}`。未重启用户正在运行的后端，新来源白名单需用户完整重启后端后生效；本次不宣称已覆盖 DSH 完整智能体执行链。

火山多模态默认配置补充：按用户授权在后端 `config/model-defaults.json` 增加 `vision.analyze`（`doubao-seed-2.1-pro`）及 `image.generate`（`doubao-seedream-5.0-pro`），复用原 Agent Plan 连接，分别设置能力默认，保留聊天默认。真实调用经生产协议构造器及供应商传输边界完成：视觉识别合成红色方块正确，文生图和参考图编辑均返回一张可解码的 2048×2048 JPEG；未将图片解码通过扩张为视觉质量验收。所有图片只留内存，不读取用户素材、不产生业务会话或文件。最初探针缺少本机部署使用的允许来源而被访问边界拒绝，补入与现有部署一致的显式来源后完成上述验收，没有改变业务访问策略。

通过正式启动同步 service 应用到当前开发库，连续同步两次结果一致，当前为两条连接、五项模型配置；未来重启继续自动应用文件。隔离 PostgreSQL 的真实应用 lifespan 验证重启幂等、管理 API 返回两项多模态配置、聊天默认保留及新工具按能力冻结默认；连同原配置和多模态收据回归共 20 项通过。mypy、Ruff、格式、所有权检查通过，旧包 740 文件未变，源码 `.pyc` 为 0；本轮独立测试数据库、容器和 Home 已清理，用户后端没有重启。证据：`.superdsh-work/web-admin-validation/volcengine-multimodal/{live-results.json,applied.json,junit.xml}`。语音、视频、多模态向量尚未接入，不计入本次完成范围。

后续模型页反馈修复：只读核对开发库的两条供应商连接均已启用且保存密钥，三个模型配置均为 `chat`；多模态列表为空符合当前能力配置。原空态无条件要求“先添加供应商连接”，误把能力配置缺失描述成连接缺失；现显示共享连接数量，并区分未建连接、未建当前能力配置、搜索无结果及加载失败。没有按供应商名称自动创建视觉/生图能力，也未修改用户配置。定向前端回归 19 项通过，证据位于 `.superdsh-work/web-admin-validation/model-catalog-empty-state/fronted-tests.json`；只读核查未产生业务测试数据。

本轮完整 `web-admin:check`、默认 `web-admin:parity` 和最终生产 Docker 生命周期均已通过，退出码均为 0；旧包 740 文件再次确认未变。本轮各自持有的数据库、容器、进程和 Home 已清理，历史 9 个目录及 2 个已停止容器删除受阻仍单独保留。`fullParity` 仍为 false：完整当前旧 Next 视觉构建与细节对齐未全部关闭；Android 真机/系统权限、Word/Excel/PowerPoint 原生客户端及真实外部 OAuth 账号验证仍待环境，不以协议重放或 LibreOffice 替代验收。以下结论只对应实际执行的自动范围，不宣称全量无损或像素等价。

以下证据路径均相对于 `.superdsh-work/web-admin-validation`。各专项包含交叉回归，场景、测试函数、参数化用例与截图的计数口径不同，不能相加形成一次虚构的全量通过。测试索引、OpenAPI 或 Schema 投影只证明结构登记，不证明对应全部业务已经执行。

| 范围                             | 已执行及修复                                                                                                                                                                                                                         | 当前状态与实际证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3-01/02 基准与隔离              | 旧包 740 文件逐文件指纹核对；两套真实 HTTP 服务使用独立数据库账号、Redis 分库、Home 和随机回环端口。实库专项记录各自清理结果，未操作用户日常库或 Home。                                                                              | 基础隔离已验证；`tests/parity/live/environment.ts` 及各轮报告。最新再次核对旧包 740 文件未变，源码目录 .pyc 为 0；最终 parity 报告已归档一致的指纹与逐文件结果。9 个临时目录及 2 个已停止容器清理被策略拒绝，具体清单见下文，不能写成全部清理完成。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| P3-03 双服务 HTTP                | 最终默认 parity 覆盖 274 HTTP 入口认证边界：268 响应完全一致，另 6 项登记动态差异通过逐项白名单归一化；7 个 WS 拒绝边界无差异，同轮 196 项选定管理、模型、设备、附件、票据及 WS 业务场景通过。                                       | `parity-1794274094351-e2d09d53/live-http/http-evidence.json`：normalizedDifferences/socketDifferences/scenarioFailures 均为 0，所持数据库、容器、进程及 Home 已清理。274 项是认证边界，不是全部正向业务；196 项仅代表报告列明场景，不能据此推导全路由等价。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| P3-03 身份、查询与投影           | 首批 231 场景差分、85 项实库回归及查询/批量/身份专项保留历史证据；最新身份边界组合 142 项纯测试、16 项实库回归通过，修复用户名推导、头像/分页约束、发码门禁、OAuth 输入和管理员密码字段语义。                                        | `phase-three-api/identity-boundary-final/junit.xml`：142 项通过；`identity-boundary-regression-summary.json`：16 项通过、0 跳过、cleanup true。纯测试使用真实旧 handler/新 ASGI 与内存端口；实库中的 IdP/邮件为受控端口，不是真实外部账号。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| P3-03 仪表盘与配对边界           | 仪表盘局部更新保留原分区、规范化阈值，查询默认起点相对 to、空时区使用默认值；配对 claim/poll 对齐缺失、过期、消费、归属及凭据检查顺序和响应。                                                                                        | `phase-three-dashboard/junit.xml`：18 项纯差分；`phase-three-pairing-boundary/pairing-junit.xml`：12 项真实旧 handler 对照纯差分，均 0 失败/跳过。受控端口证据不扩大为真实设备或完整仪表盘全部状态。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P3-03 Schema 边界复核            | 历史 179 项投影差异中 112 项为文档组件差异；其余 67 项已完成限定字段/约束复核，其中 18 项入口观察差异已修复并附测试，49 项按源码、共用 DTO 及关联用例完成结构/语义复核。                                                             | `phase-three-api/schema-boundary-closure.json`：67 项已审、待源码复核 0，逐路由 `fullRouteParity` 仍 false；不是 67 个缺陷，也不是全路由等价通过。非零终端游标、运行配置拒绝及实例上限的两项具体自动证据缺口已补齐 8 项差分，连同 15 项既有响应共 23 项通过；限定范围见下文。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| P3-03 列表与客户端刷新           | 全量会话目录与默认 100 条游标列表分开；真实键集分页覆盖归档、撤销设备、删除/移动锚点；桌面及 Android 刷新请求字段能进入双入口，保留会话名称和凭据语义。                                                                              | `phase-three-api/listing-refresh-differential.xml` 17 项通过（列表 12 项与身份导航 5 个测试函数）；`listing-regression-summary.json`、`client-refresh-regression-summary.json` 各 2 项实库通过，cleanup 均为 true。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| P3-03 项目、导入、内联附件与配对 | 修复项目路径/手动创建语义、受管项目准备和保护；导入只持久化、不执行首次消息；恢复 Android 内联附件上传、稳定别名与文件归属；配对领取接受旧客户端 serverUrl，但不覆盖发起方冻结地址。                                                 | `phase-three-api/project-client-regression-summary.json` 首批 2 项通过；`inline-native-client-regression-summary.json` 最终 10 项实库通过、0 跳过、cleanup true，涵盖内联 2、配对 2、导入 2、Office 1、文件管理 3。旧 stage 12 项纯差分另有真实旧实现对照。不是 Android 真机或真实 Connector 执行证明。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| P3-04 终端                       | 恢复旧合法创建参数、默认 Shell/非持久、启动命令、浏览/会话作用域和关键视图字段；集中兼容适配保留原 RPC 返回形态，业务层不按版本分支。                                                                                                | `phase-three-terminal/summary.json`、`terminal-junit.xml`：28 项通过，含 15 条真实旧 handler 响应差分、2 个真实 Windows PTY。默认 parity 纳入 20 项纯终端差分；真实 PTY 仅完整 check 执行。5 个测试目录清理被拒，已保留失败状态。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P3-04 终端游标与运行配置         | 非零 snapshot 游标 7/4096 在规范与兼容入口各有对照；运行配置拒绝 3 项及实例上限 1 项补齐，拒绝保留设备诊断或旧默认错误。                                                                                                             | `phase-three-terminal-runtime-boundaries/summary.json`、`boundaries-junit.xml`：新增 8 项与既有 15 项响应组合共 23 项通过。使用真实旧 handler、新 controller/service 及受控 DAO/Socket，不计真实网络、数据库或 PTY；未创建运行数据或启动运行进程。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P3-04 WS、流与附件               | 修复票据有效期/单次消费/错作用域、旧握手与快照信封、元数据事件；恢复 multipart、JSON/Base64、短期 302 下载、Range 与原登录撤销绑定。流在每帧前复验原凭据、当前权限和会话归属，拒绝/超时关闭有统一短期限。                            | `phase-three-api/stream-attachment-regression-summary.json`：7 项实库/真实网络回归通过；`phase-three-stream-revocation/summary.json`、`stream-junit.xml`：21 项通过，含 9 个撤权/超时反例，后者使用真实 controller 和受控 async 端口，不计真实网络覆盖。最终默认 parity 的 196 项业务场景已包含扩展双服务帧链路并通过。先前元数据场景失败为 fixture 缺 runtime/runtimeId，补齐旧协议字段后通过，无生产改动；实际旧 Store/Hub 的 2 项拒绝/提交后发布回归已在最终完整 check 的 22 项 Node 测试中通过。                                                                                                                                                                                                                                                                                                                                    |
| P3-05 视觉与交互                 | 21 模块 × 7 状态 × 旧新两端，共 294 项观测；66 项交互采集；有数据资源流程 5 场景 × 2 端共 10 项断言通过。修复列表、弹窗、主题、资源关联、工作台项目/分组、设备重置、上传晚到及已读范围；真实初始化记录省略空数组导致的列表崩溃已修。 | `phase-three-ui/ui-review.json` 及矩阵/交互报告保留观测范围。`live-spec-regression-final/browser-results.json`：单轮真实 PostgreSQL/Redis/ASGI/Vue/Edge 3/3 通过（33.8 秒），覆盖设备文件、基础管理和 21 模块/示例/智能体创建刷新；`completion.json` success/cleanupPassed 均 true。资源 3 项及昵称 5 项单测通过，生产/测试 Vue TS、定向 ESLint 和格式检查通过。后续服务设置 oauth=null 崩溃修复另有 3 项单测；默认 9 个 spec 的 34 项浏览器组合在 `phase-three-ui/service-null-browser-final/browser-results.json` 单轮通过，无跳过或重试后通过，cleanupPassed=true，耗时约 100.8 秒；其中 3 个 live spec 使用真实 API，其余为合成 HTTP。最终完整 check 再次通过同一默认 34 项浏览器组合，无失败、跳过或重试后通过；报告见 `check-report-1794275197144-d6b1433a/live-browser/browser-results.json`。294 项截图不等于所有最新状态一致。 |
| P3-05 当前旧源码组件补证         | 当前冻结的 AgentResourceManager、SkillProgramEditor 经独立 React/Vite harness 与新 Vue 执行技能草稿、知识库冲突、上传关联索引 3 场景 × 2 端，6 项通过；最终技能重放 2 项通过。                                                       | `phase-three-ui/current-source-components/paired-source-components.json`、`skill-program-final.json`、`provenance.json`。两个源码 SHA256 与旧包一致；使用合成 auth/HTTP 和旧生产 CSS，只证明当前组件行为。完整当前 Next/Tailwind 构建仍因内存不足未通过，不能用该 harness 代替。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| P3-06/07/08 DSH 与扩展           | 运行域真实旧函数/handler 差分、固定引擎 preset 作用域通过；最终完整 check 再次执行真实固定 Host，涵盖既有会话改绑、重启不重放、确认/取消、租约丢失与撤权回收；活动时间、元数据事件和 notice 投影回归通过。                           | `check-report-1794275197144-d6b1433a/dsh-evidence.json`：real-fixed-host-controlled-model，执行围栏、Host 复用、会话改绑、不重放、撤权/租约回收及 processExited 均通过。模型端口受控，externalModel=false；与前文独立外部模型实测分别记账，不新增第二个执行循环或队列。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| P3-09 Office                     | 三种旧 Node/新 Python 生成器同输入比较；修复 XLSX 来源异常页/图表/打印、DOCX 目录/页眉页脚、PPT 封面/正文。六份产物在隔离 LibreOffice 容器真实成对渲染；另补最小 XLSX 来源说明完整 JSON/换行行高回归，最新组合 25 项通过。           | 最终 `office-e032ab70-9cc4-4ac2-ad7e-2121f9d459af/office-junit.xml`：25 项通过，134.04 秒，0 失败/跳过；同目录 `office-paired-rendering/*/comparison.json` 保留正文、页数、目录、图表对照。此前 office-94ca1990 轮次同样 25 项通过；原质量/同页数断言保留。`phase-three-office-bounds/fix-summary.json` 记录旧版裁切缺陷及新端修复；像素并非完全一致，Word/Excel/PowerPoint 原生客户端仍待环境。                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| P3-10 桌面协议                   | 现有账户、远程请求/票据 WS、附件保存、观察租约 4 个文件共 27 项测试通过；网络部分使用受控回环服务。                                                                                                                                  | `phase-three-desktop/results.json`；不表示桌面完整 GUI 或 Android 真机已验收。客户端静态字段审计与实际双入口回归见 `tests/parity/native-client-audit.json`，两种证据不能互换。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| P3-10/11/12/14 命令、部署与规范  | 最终全域 Ruff、372 文件 mypy、TypeScript 与结构检查通过；根 `check:layout` 再次退出 0。旧 Docker 原样 manifest 集合在全新 node_modules 中 immutable 安装通过（476.7 秒），验证新工作区没有破坏该安装步骤。                           | `phase-three-layout/layout-final.log`、`phase-three-deployment/legacy-install-results.json`。后者明确 `fullLegacyImageBuilt: false`；不能称旧完整镜像已构建。最终新生产镜像生命周期结果见下一行；默认 parity 与最新完整 check 均退出 0；命令验收见 `check-report-1794275197144-d6b1433a/commands/results.json`，原生 `uv run python main.py`、协同 dev、独立前后端、生产 start 共 4 组通过，涵盖配置/迁移/热重载与退出回收。                                                                                                                                                                                                                                                                                                                                                                                                            |
| P3-11 最终生产镜像生命周期       | 独立 Compose/端口/命名卷运行最终 Python 与 Vue 镜像；通过 Nginx 页面与就绪、单次票据 WS、文件/Shell/POSIX PTY、真实固定 DSH 准备回收、Office 真实渲染、密钥缺失拒绝、重启及 stop/start 持久化。                                      | `deployment-1794273930660-68ea51ae/results.json`：13 项完成、无失败，退出码 0；validationPassed/cleanupPassed/passed 均 true，报告记录两镜像 SHA256。仅验证所列兼容身份入口，未声称全部旧 API 由此通过；本轮容器/卷清理成功不消除前述历史清理受阻项。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| P3-12 最终完整自动检查           | Python 530 项（379.08 秒）、Vue 120 项/31 文件、Node 22 项（含 2 个真实旧 Store/Hub fixture 回归）、Office 25 项及默认浏览器 34 项通过；全部无跳过。静态、架构、真实 DSH 与 4 组启动命令同步完成。                                   | `check-report-1794275197144-d6b1433a/summary.json` 及其 pytest-junit.xml、fronted-tests.json、dsh-evidence.json、commands/results.json、live-browser/browser-results.json；退出码 0。实际 summary 字段 checksPassed/fullCheckPassed/cleanupPassed/archivePassed/integrityPassed 均 true，missing/errors 均为空。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| P3-13 结论                       | 最终默认 parity 退出码 0：8 项证据门禁、257 项纯差分及真实双服务套件均通过，旧包 740 文件指纹一致；原始响应与逐项归一化规则保留。                                                                                                    | `parity-1794274094351-e2d09d53/parity-report.json`：automaticScopePassed=true、fullParity=false；只表示本轮选定自动范围通过。完整 check 与生产 Docker 生命周期也已通过，本轮自动检查准入完成；真机/外部环境、当前旧 Next 完整视觉及细节、历史清理受阻事项继续分别记账，整体全量等价准入仍未关闭。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 本轮差异台账

以下为已确认差异及修复范围；专项仅对应所列范围，最终组合结果见上表。

| 差异                                     | 修复后的行为                                                                                                                                                                                                                                                              | 验证与剩余                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 查询与批量操作丢失旧参数/结果语义        | URL 查询、历史页/changes/恢复按真实旧 handler 语义处理；持久更新序列与展示顺序分开；批量已读/归档不再隐含截断大集合。身份与原生投影保留旧合法输入和字段。                                                                                                                 | `phase-three-api/query-input-differential.xml` 100 项；查询身份 19 项与批量 2 项实库报告。                                                                                                                                                                                                                                                                                                                                                                                        |
| 会话列表误把完整目录截为一页             | `/sessions/list` 返回完整归档/未归档目录；普通列表保持默认 100、真实 SQL 键集分页及旧游标字段。锚点被删除或移动后仍能按原排序边界继续。                                                                                                                                   | `listing-refresh-differential.xml` 与 `listing-regression-summary.json`；126 条合成事实实库覆盖。                                                                                                                                                                                                                                                                                                                                                                                 |
| 桌面/Android 刷新请求被严格 DTO 拒绝     | 显式接受客户端已有刷新字段，刷新不重命名现有登录会话、不泄漏凭据；其他业务写 DTO 仍拒绝无关字段。                                                                                                                                                                         | `client-refresh-regression-summary.json` 双入口 2 项通过；不使用全局 extra=ignore 掩盖差异。                                                                                                                                                                                                                                                                                                                                                                                      |
| 项目身份及受管工作区语义丢失             | 保留 manuallyCreated=false；Linux 路径区分大小写，Windows 等价路径复用；只在 prepare 创建受管项目，重复准备不覆盖名称/更新时间，阻止受管目录越界改建和删除。                                                                                                              | 项目实库首批 2 项通过；prepare 扩展已纳入导入/项目组合专项，最终全量再次复验。                                                                                                                                                                                                                                                                                                                                                                                                    |
| 导入旧会话误触发执行或错误幂等           | `POST /sessions` 校验配置、项目与外部会话身份后仅落库，返回 connectorResult=null，不发送消息/RPC；可无 clientMessageId，提供时以账号/设备/完整请求校验幂等冲突，不能跨创建模式重用。                                                                                      | `session-import-regression-summary.json` 保留早期 11 通过/1 Office setup MemoryError 的失败轮次；后续 `inline-native-client-regression-summary.json` 中导入 2 项及 Office 1 项均复验通过，不把早期报告改写为成功。                                                                                                                                                                                                                                                                |
| Android 内联附件与配对输入缺口           | 接受首次本地内联附件，文件别名稳定绑定账号/会话/文件库记录；重复请求不重复文件或 RPC，不同会话同 hash 独立；配对 claim 的 serverUrl 可接收但不能改写发起端地址。                                                                                                          | 最新 10 项实库报告包含内联 2、配对 2；附件 RPC 为受控端口。旧 stage 纯差分只验证指定输入转换，不能扩大为真实手机上传验收。                                                                                                                                                                                                                                                                                                                                                        |
| 终端合法参数 422、默认值/作用域/包装丢失 | shell/args/command/env/profile/ephemeralGroupId 按旧能力接收；原生 shell/args 和启动 command 按旧实现执行，原生忽略的 env/profile 不额外赋权。浏览会话固定 browse 身份；集中 responseSource 读取可信内部 TerminalResult 原始协议结果，保留普通与历史 RPC 包装的真实字段。 | `phase-three-terminal/terminal-junit.xml` 28 项通过，含真实 PTY、15 条实际旧响应；owner、terminal.use、workspace 校验保留，未增加引擎。                                                                                                                                                                                                                                                                                                                                           |
| 运行配置拒绝丢失设备诊断                 | 设备返回非空字符串 message 时保留其诊断；未提供有效诊断时沿用 invalid runtime config。实例数量限制不因错误适配放宽。                                                                                                                                                      | `phase-three-terminal-runtime-boundaries/boundaries-junit.xml`：运行配置 4 项及非零 snapshot 游标 4 项新增差分，与既有 15 项响应共 23 项通过；受控端口，不计真机或真实网络。                                                                                                                                                                                                                                                                                                      |
| 流撤权与超时关闭存在空窗                 | 会话每帧前重新验证原 credential、sessions.read 与 own；dashboard 权限收紧时丢弃旧快照；发送超时、拒绝和终端异常关闭有 3 秒上限，取消继续传播，旧 401 握手/1008 拒绝语义保留。                                                                                             | `phase-three-stream-revocation/stream-junit.xml` 21 项通过；包含缓存页发送途中撤权和 close 阻塞反例，明确为受控 async 验证。                                                                                                                                                                                                                                                                                                                                                      |
| 票据、文件下载与 Connector 行为差异      | 票据单次消费及会话/用途范围校验；短下载令牌绑定原登录及文件，Range/过期/撤权按契约响应；Connector 收到帧后再验授权并有界发送；设备 POST 重置旋转凭据、DELETE 删除返回 204。                                                                                               | 首批流/附件 7 项通过；最终默认 parity 的 196 项选定业务场景通过，涵盖设备重置/删除、附件与票据及元数据后续帧。元数据 fixture 按旧协议补齐 runtime/runtimeId，无相应生产改动；2 项旧 Store/Hub 回归见 tests/parity/live/session-metadata.test.ts。                                                                                                                                                                                                                                 |
| 运行域状态与事实投影不一致               | 保留 takeover 可写语义、归档读取、空闲绑定 CAS、真实活动时间、提交后事件序列及 notice 投影；修复同步完成重复请求与历史活动迁移。                                                                                                                                          | 真实旧函数差分与真实 DSH 专项已执行；最终完整 check 负责最新修复组合的重新验证。                                                                                                                                                                                                                                                                                                                                                                                                  |
| UI 资源/工作台交互不完整                 | 对齐公共布局、分页、角色/模型/配置弹窗、账号卡片；资源草稿取消、依赖工具联动、知识库 CAS 冲突保持；工作台按设备/项目/置顶分组，创建前绑定所属项目，上传晚到不得污染新账号；全部已读取完整目录后分批提交。                                                                 | `phase-three-ui/ui-review.json` 列明实际范围；上传生命周期 4 项、旧 helper/项目边界 6 项及当前组件配对通过。`phase-three-ui/final-pagination-read/fronted-tests.json` 最新 13 项通过，覆盖 101 条续页、1001 条已读分批及换号/卸载边界；最终完整 check 的 120 项 Vue 测试及 34 项浏览器组合通过，覆盖新增工作台流程；最后阶段折叠与全部已读未另作旧新配对浏览器重放，保留该视觉证据边界。294 项旧截图不是所有最新页面快照。                                                        |
| 真实预置智能体省略空数组导致渲染崩溃     | 读取 DTO 明确允许省略说明/资源数组，列表计数按空集合显示；编辑草稿逐字段复制补全，保留修订，写入仍要求完整数组。                                                                                                                                                          | `phase-three-ui/live-spec-regression` 保留初轮 2/3 通过及真实崩溃；`live-spec-regression-final` 单轮 3/3 全过，包含预置记录加载、新增、刷新持久化。资源单测覆盖省略数组、完整草稿与无原数组污染，3/3 通过。                                                                                                                                                                                                                                                                       |
| 服务设置未配置 OAuth 时页面崩溃          | 读 DTO 保留 oauth=null，摘要显示未启用；编辑草稿使用独立默认值，仅 PATCH 当前分区，保存访问或邮件设置不创建 OAuth 配置。空 secret 不提交，失败保留草稿。                                                                                                                  | `phase-three-ui/service-null-regression/diagnosis.json` 保留先前完整检查 33/34 浏览器通过、ServicePage 读取 null.label 失败的诊断；历史失败未覆写。对应 fronted-tests.json 的 3 项真实组件/受控 API 单测通过；`phase-three-ui/service-null-browser-final/browser-results.json`：默认 9 个 spec 共 34 项单轮通过，无失败、跳过或重试后通过，completion 的 success/cleanupPassed 均 true。真实 API 与合成 HTTP 范围分列，不计真实 OAuth 登录。                                      |
| 身份与仪表盘边界未完全保持旧输入语义     | 修复省略用户名推导、头像 trim/大小错误、分页整数与默认值、空库发码门禁、OAuth 必传字段及管理员密码冲突；仪表盘局部配置和时间默认值按旧实际处理器恢复。                                                                                                                    | `phase-three-api/identity-boundary-final/junit.xml` 142 项纯测试、`identity-boundary-regression-summary.json` 16 项实库均通过；仪表盘 18 项纯差分另列。受控外部端口不计真实 OAuth/邮件交付。                                                                                                                                                                                                                                                                                      |
| 配对 claim/poll 的拒绝顺序和状态响应不同 | 对齐缺失/过期/已消费、账号归属、错误或缺失令牌、pending/claimed 返回与 serverTime；保留发起端冻结的 serverUrl。                                                                                                                                                           | `phase-three-pairing-boundary/pairing-junit.xml` 12 项纯差分通过；Android 真机仍待环境，纯差分不替代真实配对设备。                                                                                                                                                                                                                                                                                                                                                                |
| 技能编辑器与原页面样式存在差异           | Word/PPT 起点保存为可编辑资源 JSON；补齐多模态工具保留用户匹配内容，支持阶段草稿撤销；智能体弹窗恢复 85vh、64px 文本字段及原选择器外观。工具/技能仍通用配置，不在核心添加 Office 分支。                                                                                   | 当前旧组件与 Vue 的 6 项配对及最终技能 2 项重放通过；完整 Next/Tailwind 构建受限，表单累计间距、图标/箭头及焦点描边仍有微差，逐项保留在 `ui-review.json`，不宣称像素完全一致。                                                                                                                                                                                                                                                                                                    |
| Office 生成内容和版式差异                | 补齐 XLSX 异常来源页/打印与图表、DOCX 真实目录域/书签/页眉页脚、PPT 标题/品牌线/表格/正文布局。来源说明列宽从 90 调为 60，按中英文显示宽度设置换行行高，保留完整 JSON 与计算说明、原方向/缩放/分页；不放宽质量阈值或删除数据。                                            | 最新 25 项真实 LibreOffice 渲染回归通过：成对 DOCX 3/3 页、XLSX 4/4 页、PPTX 3/3 页；最小表格保持 3 页，新端越界字形 19→0。旧版同输入也有 8 个字形越界，保留明确旧缺陷与修复差异（fix-summary.json），不宣称像素等价。原生产 fixture 在 network=none 容器挂载修复模块复验通过；最终重建镜像的真实三类渲染已随 deployment-1794273930660-68ea51ae 的 13 项生命周期通过，原生 Office 待环境。                                                                                        |
| 验证工具曾只能证明结构索引               | 默认 parity 改为本轮实际执行并校验证据，纯差分、实库、真实 PTY/DSH、浏览器、容器分别记录；失败证据保留，不能从历史 JSON 或测试索引推导成功。                                                                                                                              | `phase-three-api/schema-boundary-closure.json` 已复核 67 项边界（18 项实际差异修复、49 项限定结构/语义复核），112 项历史文档投影另列；各条 `fullRouteParity: false`，两项具体自动证据缺口已补 8 项差分、23 项组合通过；这不表示全部输入域已穷举。最终 Docker 生命周期 13 项及默认 parity 已通过；后者包括 8 项门禁、257 项纯差分及真实双服务场景。最终完整 check 退出 0，530 项 Python、120 项 Vue、22 项 Node、25 项 Office 与 34 项浏览器组合通过；本轮归档完整、资源清理成功。 |

本轮新库迁移保留历史数据与稳定身份：`f018e53b27ac` 补账号更新时间，`a139f64c28bd` 补会话活动事实字段，`b2608e7ac391` 将外部会话标识扩为 Text，`c841f50b3ae2` 将内联附件显示名称容量扩为 512；后两项按实际旧输入约束修复，回退不静默截断。最新 10 项实库回归在新增迁移后通过，300 字符外部会话标识已有实测；不修改旧 `apps/admin` 的迁移链。

### 本轮清理与剩余验收限制

最终证据总索引：`phase-three-final-verification.json`。源码 .pyc 数量为 0，本轮 check 容器已清空；用户原有开发前端仍保持运行。

实库专项最新报告均分别记录 cleanup；本轮自动场景使用合成账号/文件/受控模型，不读取用户真实凭据。前文的外部模型实测是单独授权、单独记录的证据。已关闭本任务持有的 PTY、浏览器和临时 UI 服务；用户在 5175 的开发前端未停止。

以下 **9 个临时目录及 2 个已停止容器**的删除被自动审批明确拒绝，返回 `blocked by policy`；未换路径、删除父目录或换工具绕过。终端报告 `cleanupPassed: false` 及 UI 报告 `cleanup.removalBlocked` 保留事实，因此本轮“测试数据全部清理”仍未达成。目录均在 `.superdsh-work/web-admin-validation` 下，包含合成测试 Home/文件、组件 harness 或缓存，不在生产代码目录；两个容器属于中止的隔离检查。日志与报告作为验证证据另行保留。

- `phase-three-terminal/pytest`
- `phase-three-terminal/pytest-rerun`
- `phase-three-terminal/pytest-final`
- `phase-three-terminal/pytest-response`
- `phase-three-terminal/pytest-verified`
- `phase-three-ui/current-source-components/runtime`
- `phase-three-ui/current-source-components/vite-cache`
- `phase-three-ui/current-vite/vite-cache`
- `check-1794214798164-fde0e3c1`

已停止但尚未删除的容器：`web-admin-check-1794214798164-fde0e3c1-pg`、`web-admin-check-1794214798164-fde0e3c1-redis`。本次删除这两个容器及对应目录的整体命令被 `blocked by policy` 拒绝，未执行任何清理动作，也未重试或改用其他方式；`phase-three-infrastructure/recovery.json` 明确 `cleanupPassed: false`。

2026-11-09 晚间 Docker 断开，中止了 `check-1794214798164-fde0e3c1` 的完整检查。2026-11-10 08:34 启动恢复时，旧 Docker `run` 目录中的 AFUnix 端点无法访问导致启动卡住；已将停止状态的 IPC 目录备份至 `C:/Users/zhong/AppData/Local/Docker/run.failed-20261110-0834` 后恢复 Docker，未更改持久卷或 Docker 配置。恢复证据见 `phase-three-infrastructure/recovery.json`；基础设施恢复不等于中止的检查通过。

此前两项**具体自动证据缺口已关闭**，不再登记为未执行项或待环境项：

1. 终端 snapshot 的非零 `fromSeq` 取 7/4096，分别经过规范与兼容入口，新增 4 项真实旧 handler 与新 controller/service/relay 对照。
2. Connector runtime 创建新增 3 项配置拒绝及 1 项实例上限差分；修复拒绝时丢失设备诊断，保留有效 message，缺省沿用旧错误。

`phase-three-terminal-runtime-boundaries/summary.json` 与 `boundaries-junit.xml` 记录新增 8 项、既有响应 15 项，共 23 项通过。测试使用受控 DAO/Socket，未启动运行进程或创建测试数据，不计真实网络、数据库、PTY 或设备覆盖。Schema 的 67 项限定审查现为 18 项观察差异修复与 49 项结构/语义复核；逐项 `fullRouteParity` 仍为 false，`complete: true` 仅表示这一审查清单及上述已知具体缺口关闭，不表示全路由全部输入域已穷举。

最终生产 Docker 生命周期已通过，证据见 `deployment-1794273930660-68ea51ae/results.json`；本轮 cleanupPassed=true 与前述历史清理受阻分别记账。最终默认 `corepack yarn web-admin:parity` 退出码 0，`parity-1794274094351-e2d09d53/parity-report.json` 记录 automaticScopePassed=true、旧包 740 文件指纹一致；该轮双服务资源清理完成。最终完整 `corepack yarn web-admin:check` 退出码 0，`check-report-1794275197144-d6b1433a/summary.json` 的 checksPassed/fullCheckPassed/cleanupPassed/archivePassed/integrityPassed 均为 true，白名单报告已归档，missing/errors 均为空；本轮测试数据库、容器、进程及 Home 已回收。根 `check:layout` 再次退出 0，证据为 `phase-three-layout/layout-final.log`。待环境项继续保留 Android 真机/系统权限、Word/Excel/PowerPoint 原生客户端及未具备真实账号环境的外部 OAuth 验证。完整当前旧 Next/Tailwind 构建受机器内存限制，组件级补证的范围与剩余视觉差异按上述记录保留，不以缩小正文验收要求消除这些缺口。

## 验证边界与共同规则

- 已获用户确认的差异单独登记：新库按配置创建初始管理员，不要求交互式初始化令牌；发布入口与源码目录采用本次 Python/Vue 分层规范。这些是明确需求，不能在差分修复中恢复旧初始化页面或旧平台实现。
- `apps/admin` 是只读参照包；保留其现有未提交修改、未跟踪业务文件及当前缺失文件状态，不以 `HEAD` 替代工作区基准。
- Vue 3 + TypeScript 前端与 FastAPI 后端重新实现；DSH 继续使用固定版本和已有协议，不另建 Agent 执行队列。
- 平台验证通用资源、配置、授权、版本、执行证据和成果合同；Office 是可配置工具/技能的代表测试包，不按助手名称建立核心业务特例。
- 当前盘点观察值为 274 个 HTTP、7 个 WebSocket、合计 281 个入口；这不是未来清单上限，也不是“数量相等即通过”的断言。
- 旧 193 路由契约是历史基线的一部分，必须结合实际路由注册、页面调用、客户端调用和协议资料重新生成完整清单。
- 新端 HTTP/WS 规范入口使用无版本的 `/api`、`/ws` 等路径；旧 `/api/v2` 仅由 `apps/web-admin/deployment/compatibility-routes.json` 集中映射，业务 router 不接收版本前缀、不复制 `v1/v2` 目录。
- 全部测试集中在 `apps/web-admin/tests/{fronted,backend,contracts,integration,e2e,parity,fixtures,tooling}`；固定基线放 `tests/fixtures/baselines`，功能清单固定为 `tests/parity/features.json`，生产 `contracts` 只放契约 Schema。
- 运行证据、截图、trace、日志、缓存、临时参照源码与 Home 统一写入 `.superdsh-work/web-admin-validation/<run-id>`；测试源码/固定 fixture 可入 Git，运行产物不得进入业务目录、Git 或 Docker 上下文/镜像。
- 只有测试数据，可为新实现建立新库；不要求旧数据库结构、历史升级链或旧密文的迁移。对外业务与协议仍需等价。
- 21 个控制台模块以计划二矩阵中的现有 `module.id` 为稳定键；官网、登录、预览、分享、工作台子路由与弹窗另列场景。
- 每个任务记录输入、执行证据、输出和退出条件；前置条件缺失记为“待环境”，不能用跳过测试表示通过。
- 原实现中发现的缺陷进入差异台账，分别记录既有行为和预期契约；不得静默改写基准来消除差异。
- 自动测试使用临时账号、合成数据、临时 Home 和专属依赖；不读取真实用户会话、不复制真实凭据、不使用真实用户资料。
- 本文件中的根命令已由计划一接入；是否通过以实际运行记录为准，计划文字不替代执行证据。

## P3-01 固定可复现的当前工作区基准

**输入：** 当前 `apps/admin` 源码、已存在的未提交变更、根依赖锁文件、DSH/AA pin、产品补丁、计划二模块矩阵。

- 生成来源清单：相对路径、文件状态、SHA256、采集时间、Git 提交与脏工作区说明；同时记录未跟踪业务文件和已删除源文件。
- 缓存、安装目录、构建输出、凭据及运行数据不进入源码快照；排除规则随清单保存，不能借排除规则漏掉业务实现。
- 将基准源码复制至专用临时参照目录，旧系统的安装、构建、Next 生成文件和测试输出均在该目录发生，避免改动原包。
- 记录 Node/Yarn、浏览器、字体、操作系统、依赖锁、Harness 依赖树与安装锚点；快照内容必须能对应本次比较结果。
- 后续用户修改旧包时，保留既有证据并显式建立新基准版本，标记受影响用例；禁止自动覆盖黄金结果。

**证据与输出：** 基准来源清单、源码指纹、排除清单、可重复启动记录、模块及路由目录；固定基线放 `apps/web-admin/tests/fixtures/baselines`，本轮采集证据放统一 `<run-id>` 目录。

**退出条件：** 已覆盖当前工作区而非仅 `HEAD`；参照应用能在隔离环境启动；任何无法启动或缺失来源的部分均有未关闭条目，不能宣称已建立完整基准。

## P3-02 建立同样业务数据的两套隔离环境

**输入：** P3-01 基准、计划一环境变量及端口约定、新旧系统各自的 schema 和测试种子。

- 由同一语义种子分别建立旧库与新库，不通过共用数据库或修改旧表实现对照；账号、角色、设备、会话、资源和成果用显式映射关联。
- 两套环境分别使用独立 PostgreSQL 数据库/账号、Redis 实例或强隔离命名空间、Qdrant 集合/凭据、对象桶/账号、本地文件目录。
- 使用独立 `DSH_HOME`、工作区、Connector 身份、服务密钥、临时目录、进程端口和浏览器用户数据；不得同时写入同一 Home 或运行锁。
- Cookie 不按端口隔离：自动差分必须使用独立浏览器 context；手动并行使用不同 hostname（如旧 `127.0.0.1`、新 `localhost`），同 hostname 则使用隔离 profile，保持原 Cookie 契约。
- 新开发端口按计划一使用前端 `5175`、后端 `8001`；对照环境端口显式分配，不抢占已运行的旧应用。
- 测试启动前检查目标标识及路径归属；拒绝连接用户日常环境。故障注入、终止进程与清理只允许针对本次测试持有的资源。
- 结束时保留失败证据，按资源清单清理明确的临时资源；不使用 `down -v`，不删除旧 Compose 卷或用户目录。

**证据与输出：** 两套环境映射、种子版本/哈希、脱敏连接标识、Home/桶/集合归属检查、启动与清理记录。

**退出条件：** 相同逻辑输入可在两端重放；验证新端写入、撤权、索引、文件删除和进程停止均不会改变旧端数据或运行状态。

## P3-03 建立完整 HTTP 契约差分

**输入：** 实际旧路由清单、现有 OpenAPI/测试、新 FastAPI 路由、浏览器和桌面/Android 的请求样本。

- 每个入口以业务操作、方法、规范路径模板及鉴权条件标识；记录旧入口→集中兼容映射→新规范入口→同一实现，检查映射缺失、重复和歧义，不因路径不同误判业务不等价。
- 新 Vue 请求规范入口；旧桌面/Android 请求通过兼容入口。两组请求独立重放并比较同一业务结果，不能复制两份 handler 或在业务 router 中根据版本分支。
- 兼容映射按 method、path template、transport 精确匹配，保留路径编码与 query；不使用全局字符串替换，不用 301/302 重定向 POST 或 WS 来代替入口适配。
- 比较状态码、响应结构、字段名/类型、缺省值、`null` 与缺失、分页排序、游标、路径编码、查询参数和错误 `detail/code/sessionId`。
- 对合法输入、边界输入、非法 JSON、超限、资源不存在、未登录、失效登录、无权限及跨账号访问分别验证；FastAPI 默认 422 格式不能直接替代原契约。
- 按规范/兼容入口验证 Cookie Path、Location 及响应中的可访问链接；兼容入口保持旧客户端行为，HttpOnly/SameSite/Secure、CORS、Origin、OAuth/PKCE、刷新轮换及撤销语义不被映射削弱。
- 专项检查旧 refresh Cookie 的 `/api/v2/auth`、OAuth-state 的 `/api/v2/auth/oauth` 及新 `/api` 下对应路径均由集中配置派生；覆盖入站发送、出站设置、登出清理、Location、下载链接及 OAuth 回调，外部签名 URI 不重写。
- 文件接口验证二进制字节、类型、下载头、Range、分片提交和取消；模型代理验证流式事件、工具调用及取消传播，不只比较最终文本。
- API 保持对现有客户端可用；不得通过让 Vue 专门规避旧能力、额外包一层响应或忽略错误来制造通过结果。

**证据与输出：** 规范/兼容入口对应矩阵、脱敏请求/响应、逐字段差异、覆盖关联、可重放用例；281 仅作为本次旧端盘点记录，不能把新端兼容别名重复计为功能覆盖。

**退出条件：** 实际基准中的每个入口均有新端映射与适用的正反例证据；路由数一致、OpenAPI 生成成功或返回 200 均不能单独满足条件。

## P3-04 验证 WebSocket、事件游标和流式状态

**输入：** 7 个已观察到的 WebSocket 入口及后续补充入口、只读协议 fixtures、Connector/会话/终端交互用例。

- 覆盖 Connector、dashboard、会话事件与全部终端 relay/stream；检查握手鉴权、票据使用范围、消息类型、错误和关闭行为。
- 对新 `/ws` 等规范入口及集中映射的旧 WS 入口分别验证升级、帧、Origin 和关闭行为；映射不得扩大票据的账号、资源或连接用途范围。
- 对旧端分散的 7 个 WS 地址逐条验证 Upgrade、子协议、关闭码、二进制帧、query/path 编码及 ticket 签名/作用域；不能假设统一改写前缀即覆盖全部流式入口。
- 固定业务事件输入，比较序列号、游标推进、事件类型、版本替换、快照与增量一致性、去重和断线续传。
- 验证重复/乱序事件、连接替换、超时、短暂断网、客户端重连、令牌失效、账号禁用、设备封锁和权限撤销。
- 验证文本增量、工具执行、用户问题、审批、取消与最终状态的先后关系；断开浏览器不应误停 DSH 正在执行的任务。
- 使用有界慢消费者检查缓存和背压；终端分别验证二进制/文本帧、输出快照、resize、关闭与恢复，禁止丢事件后悄悄推进游标。

**证据与输出：** 脱敏事件轨迹、重连时间线、游标一致性报告、每条 WS 路由的用例映射。

**退出条件：** 所有入口及上述异常路径完成验证；HTTP 请求通过不能代替 WS 验收，模拟 Connector 结果须明确标记。

## P3-05 完成 21 模块及非菜单页面的视觉交互差分

**输入：** 计划二的 21 模块矩阵、非菜单场景清单、P3-02 种子、旧页面截图与真实操作轨迹。

- 逐模块建立“角色→路由→状态→操作→可观察结果”的用例；覆盖导航、按钮权限、表单、弹窗、抽屉、搜索筛选、分页、反馈和回退。
- 每页至少检查适用的正常、加载、空、失败、无权限、校验错误、编辑未保存和刷新后状态；模块总数不能替代这些状态覆盖。
- 对官网、登录/恢复/扫码/OAuth、分享、文件预览和工作台嵌套路由独立检查入口与深链，不依赖菜单点击才能访问。
- 使用相同浏览器/视口/DPR/字体/语言/主题及等待条件捕获双端截图；检查布局、间距、密度、文字、图标、焦点和滚动行为。
- 覆盖旧应用实际支持的宽窄视口、键盘路径、输入法、附件拖入、消息发送/取消、草稿恢复和终端操作。
- 保存 headless 浏览器截图、DOM/可访问性快照、网络日志和 trace；逐项解释像素差异，不能用大面积遮罩或降低阈值掩盖布局退化。

**证据与输出：** 以现有 `module.id` 关联的场景矩阵、前后截图/差异图、操作 trace、接口/事件关联和缺陷记录。

**退出条件：** 21 模块及非菜单清单全部有适用状态和交互证据；不能以组件存在、菜单可点、截图首页一致认定同功能同交互。

## P3-06 验证真实 DSH、业务工具与可选工作流边界

**输入：** 固定 Harness/AA 版本与补丁、Python DSH 适配器、独立 TypeScript 引擎适配的预构建产物、真实临时 Home、业务工具/工作流定义。

- 在两端分别启动真实固定版本 Host，记录进程、依赖锚点、就绪握手与 Connector 身份；不得以假 Host 或 HTTP mock 代替真实引擎验证。
- 验证网页登录及访问管理页不启动 DSH，首次进入工作台或显式准备时按基准启动；桌面/Android 保持各自准备时机。继续验证显式目标创建会话、消息与附件、工具调用、用户问题、审批、取消、模型切换和故障诊断/重试入口。
- 注入 Host 启动失败、Connector 未就绪、IPC 中断、子进程退出、模型断流、数据库租约丢失和平台重启，检查错误、状态及子进程回收。
- 两个平台副本争抢同一专用测试租约时，只能一个拥有运行权；不同用户 Home/工作区隔离，不能读取他人会话、文件或终端。
- LangGraph 是可选的业务阶段实现；启用时验证确认后执行、修订重确认、恢复和取消不会绕过 DSH 队列、权限检查或冻结绑定；普通工具/技能不因未选 LangGraph 而失效。
- 平台重启后保留已完成证据，未明确完成的副作用不得自动重放；DSH 的执行队列与审批协议保持唯一来源。
- 受控模型配合真实 Host 的结果标为“真实引擎/受控模型”；真实模型、付费能力和外部授权另列环境条件及证据，未验证不能扩大结论。

**证据与输出：** 固定版本清单、脱敏 Host/RPC 日志、进程树前后状态、租约竞争记录、工作流阶段与成果关联。

**退出条件：** 真实 DSH 核心链路及故障用例全部完成，未遗留重复所有者、孤儿进程、第二队列或越权路径；未满足的外部能力保持待环境状态。

## P3-07 验证幂等、授权与可恢复结果

**输入：** `clientMessageId`、工具运行、模型提交收据、文件提交、方案确认及权限变更契约。

- 对并发相同请求、同键不同参数、发送前失败、发送后超时、回包丢失分别验证；接受结果复用，冲突和未知结果明确报错。
- 检查 `session_create_outcome_unknown` 等既有语义；未知结果不得自动生成新键重发或伪装为已取消。
- 在付费供应商受理后、成果保存前注入故障；只能恢复已接受结果的转存，不允许再次生成收费成果。
- 在请求前、执行中、下载前分别撤权/禁用/封锁，检查 HTTP、WS、后台任务和恢复入口；管理员运维权限不授予他人的内容访问权。
- 验证刷新令牌轮换、旧令牌重放、会话撤销、个人/平台模型默认值和费用来源；冻结配置不能绕过当前撤权。

**证据与输出：** 操作收据、调用次数、状态迁移、权限反例、数据库及对象存储结果核验。

**退出条件：** 重复请求不产生重复执行/收费/成果，未知结果明确可见，所有恢复路径复验授权；不能以最终数据库只有一行推断外部只执行一次。

## P3-08 验证工具、技能与智能体的可扩展性

**输入：** 当前工作区最新 [扩展开发契约](../agent-extension-development.md)、技能/工具 schema、版本记录、通用成果合同及非 Office 扩展 fixture。

- 准备独立的非 Office 工具实现及其 schema，按现有支持契约安装、配置、关联技能并发布智能体；新增工具实现代码可以写在扩展包内。
- 在不修改平台路由、根 UI、DSH 源码的条件下验证动态表单、发现/匹配、输入校验、工具调用、通用证据和成果展示；不能要求每新增助手都加入平台分支。
- 验证 Node/Python 本地工具及 MCP 现有接入合同；平台自有业务在 Python，实现包的受管运行时不被误当成第二执行引擎。
- 逐项检查安装权限与资源编辑权限、owner/会话授权、writeOnly 凭据、工具/来源停用、版本冻结、升级失败保留旧版及恢复为新版本。
- 按最新技能契约验证 `inspect/submit/prepare/execute/review`、辅助工具多次调用、`inspectToolIds`、相邻预检/执行、引用技能和阶段输出 schema。
- 验证新请求才能结束未完成技能、修订次数、旧确认失效、迟到响应、等待确认不计生成超时；技能配置不能关闭工具授权及成果核验。
- 将 Office 示例替换、禁用、复制和重新组合后重复验证；通用平台仍可运行非 Office 工具，LangGraph 不成为不可替换的核心唯一流程实现。
- 默认示例被编辑、禁用或删除后，再次初始化不得覆盖、启用或恢复它们；需要新版示例时走显式复制，不能改变用户配置。

**证据与输出：** 扩展包/配置版本、安装前后核心源码指纹、Schema 与权限反例、技能阶段事件、通用证据/成果和新旧会话版本对照。

**退出条件：** 现有支持合同内的扩展与组合无需修改平台核心；通用能力不依赖特定助手/Office 名称，版本、禁用、授权和成果语义均验证通过。

## P3-09 验证代表工具包、知识和文件的语义与渲染

**输入：** Office 代表工具/技能包的模板与合成案例、Python 工具及知识实现、固定字体/渲染器、两端生成文件；案例不固化为核心平台域。

- XLSX 比较工作表/单元格类型、数值精度、受控公式及计算缓存、图表数据、样式和模板保留；不同币种、非法公式、超限输入分别验错。
- PPTX/DOCX 比较文本、段落/表格/图表、图片来源、可编辑对象、版式关系、原模板内容和修订成果；不能用整页图片替代原生结构。
- 真实渲染两端最终 Office 文件，检查中文字体、分页、溢出、裁切、重叠和图表；解包成功或 PDF 可预览不代表公式已重算。
- 使用适用 Office 客户端检查可编辑性/公式行为时，单列客户端版本及环境证据；只有结构测试不能宣称 Office 客户端验收。
- 知识验证来源解析、页码/段落/表行定位、索引代次、检索证据、授权、Embedding 不可用及外发许可；向量数值差异不得掩盖检索退化。
- 文件验证哈希、私有下载、分片恢复、版本/引用、回收站、local/S3 两种存储及成果预览；失败保留源对象和可恢复状态。

**证据与输出：** 原文件/结果哈希、结构与数值差分、渲染页及差异图、可编辑性记录、检索预期与来源证据。

**退出条件：** 所有适用语义、授权及真实渲染检查通过；字节不同可有合理解释，但内容、公式、结构或权限差异不能仅靠视觉近似豁免。

## P3-10 验证桌面与 Android 兼容

**输入：** 当前桌面/Android 固定版本、其实际 API/WS 客户端、只读共享协议 fixtures、新服务测试地址。

- 先用现有协议 fixtures 和真实客户端请求实现重放，覆盖登录刷新、设备/运行实例、会话、审批、附件、模型目录和终端。
- 由集中兼容映射保留旧客户端访问路径及字段/错误，验证 OAuth callback identity、Android identity 与签名约束；不通过修改旧客户端绕开兼容问题，也不要求新业务路由携带旧前缀。
- 运行适用的桌面 headless 集成及 Android 编译/协议测试；实际设备登录、系统权限、签名和交互另列需要明确核实的环境。
- 有真实桌面/Android 环境时，记录客户端构建、系统、账号类型和操作结果；mock、模拟器或协议重放证据分别标明。

**证据与输出：** 客户端版本矩阵、协议差分、自动测试报告、真实环境验收记录或待环境条目。

**退出条件：** 声明的兼容范围均有对应层级证据；缺少真机/真实系统验证不得宣称已完成真实设备全覆盖。

## P3-11 验证开发命令与生产 Docker 生命周期

**输入：** 计划一根 `web-admin:*` 命令、`compose.web-admin.yml`、新前后端构建、独立测试卷与生成配置。

- 检查 `web-admin:deps:up/deps:down` 只管理新开发依赖；`web-admin:dev`、`fronted:dev`、`backend:dev` 的组合、退出和端口与文档一致。
- 检查 `web-admin:migrate/build/start`；从干净新库安装和启动，验证 Vue 深链、同源 API/WS 反代、静态资源及后端异常展示。
- 按用户后续确认保留 `fronted/package.json` 的独立 `npm run dev` 入口，不加入新的 Yarn workspace、不生成第二份 JS lock；依赖和工具入口仍来自根 Yarn，Python 使用独立 `uv.lock`，后端命令保持 `uv run python main.py`。
- 从干净安装环境构建旧 Docker，确认根依赖变化不破坏旧 manifest 集合下的 immutable install；旧根 `.dockerignore` 和 `apps/admin` 保持不动。
- 检查新 `deployment/Dockerfile.fronted`、`Dockerfile.backend` 及各自专用 `.dockerignore` 的构建上下文；旧 workspace manifest 只用于安装元数据，旧管理端业务源码和启动入口不得进入新运行镜像。
- 检查测试目录、基线、运行证据、trace/logs/cache/Home 被生产构建上下文及最终镜像排除；独立测试阶段可读取测试源。生产 Schema 与构建元信息可以存在，`tests/fixtures/baselines` 与 `tests/parity/features.json` 不得混入生产 `contracts`。
- 检查 `web-admin:up/down/logs` 指向独立 Compose project/卷；旧根 `compose.yml` 默认行为和旧 `admin:*`、`server:*` 命令仍可使用。
- 生产容器执行首次启动、重启、镜像重建、停止后再启动；检查账号、文件、索引、Home、配置及加密密钥持续保留，初始化不重置密码。
- 注入 PostgreSQL/Redis/Qdrant/对象存储不可用、引擎失败和端口占用；区分 live/ready 及功能降级，不能用静态首页 200 代替就绪。
- 验证 SIGTERM、停止宽限期、运行租约释放与子进程回收；旧、新应用并行存在，停止新应用不会停止旧应用或删除其卷。

**证据与输出：** 命令矩阵、构建与 Compose 日志、健康检查、重启前后资源哈希/记录、停止后进程与租约状态。

**退出条件：** 开发及生产路径都完成生命周期验证；仅本机开发成功或镜像构建成功不能代表部署通过，卷与生成密钥不得丢失。

## P3-12 保护旧包并建立 CI 准入

**输入：** P3-01 旧包指纹、根允许变更清单、新包静态检查/测试任务、P3-03 至 P3-11 及 P3-14 证据。

- 在检查前后核对原 `apps/admin` 源码、配置、包脚本、已有脏工作区状态及未跟踪业务文件；除用户后续明确变更外，应与基准逐文件一致。
- 根允许修改新端所需依赖、`web-admin:*` 命令、根锁文件和独立 Compose 接入；当前不新增 Yarn workspace，逐项审查旧依赖解析、旧命令及旧 Docker 干净构建。
- `web-admin:parity` 运行选定基准的差分套件并输出逐场景结果；`web-admin:check` 聚合格式、lint、TS/Python 类型、构建、测试及完整性核验。
- CI 的用例发现仅从集中测试目录收集；静态扫描检查业务目录没有测试、固定基线或运行产物，测试 runner/pytest/浏览器/覆盖率工具输出全部显式指向统一 `<run-id>`。
- `web-admin:check` 必须执行 P3-14 的依赖边界、版本来源、路由来源和产物归属自动检查，并关联中文职责注释的人工复核结果；不能只声明规范而没有门禁。
- CI 将普通自动检查、真实 DSH、浏览器差分、Docker 生命周期及需真实外部环境的验收分层报告；子任务失败、缺证据或被跳过不能被汇总为全绿。
- 继续执行根要求的适用 ownership/layout、协议、补丁及回归检查；新增路径不能绕过检查，旧包与固定上游不因重写产生修改。

**证据与输出：** 旧包指纹对比、允许变更审查、CI 任务/产物索引、失败及待环境列表；报告注明执行的命令、源码版本和环境。

**退出条件：** 旧包未被实施或测试改动；所需自动门槛均有实际通过证据；真实环境门槛独立记账，不能以 CI 自动部分通过代替全部交付准入。

## P3-13 关闭差异台账并发布验收结论

**输入：** 前述所有报告、P3-14 门槛证据、计划二功能矩阵、未关闭差异、环境限制和源基准版本。

- 每条差异记录编号、模块/路由、场景、旧/新结果、影响、证据、原因、负责修复项、复验步骤及基准版本。
- 状态固定区分“缺失、失败、待环境、待确认、已修复待复验、已通过”；修复提交和截图上传本身不改变通过状态。
- 规范化规则逐项白名单化：随机 ID 只能做保持引用一致的映射；时间可比较约定范围/先后关系；不得删除所有 ID、时间、序列或错误字段。
- 权限、所有权、金额、工具次数、事件顺序、游标连续性、超时/有效期等业务值不能被通用规范化隐藏；保留脱敏原始结果供复核。
- 修复后重跑失败用例及相关回归；禁止通过刷新截图基准、放宽 schema、删断言、静默跳过或改变旧包来关闭差异。
- 汇总每个 P3 门槛的输入版本、通过/未通过、证据位置和适用环境；同时列出尚未验收的真实设备、外部模型或 Office 客户端范围。

**证据与输出：** 完整差异台账、修复复验记录、21 模块及非菜单覆盖报告、HTTP/WS 契约报告、DSH/Office/部署/客户端验收矩阵。

**退出条件：** 所有承诺范围的门槛逐项满足且差异有明确结论，才能声明功能、API 和交互等价；任何门槛仍待环境、失败或缺失时，必须明确标为未完成，不得宣称全量无损迁移通过。

## P3-14 验证工程分层、版本来源与健壮性

**输入：** 新管理端 `AGENTS.md`、源码依赖图、规范/兼容路由清单、manifest/锁文件/构建元信息、集中测试配置和故障用例。

- 后端按 RuoYi-FastAPI 风格使用 `modules/<domain>/{controller,service,dao,entity/do,entity/vo}`；检查 controller 只负责协议与授权入口，service 承担业务和事务，dao 只访问本领域数据，DO/VO 分离。
- 自动检查 controller 不直连 dao/ORM/进程，service 不依赖 controller，dao 不调用 service 或提交事务，跨域访问仅通过公开 service；禁止万能 Service、循环依赖及空层级占位。纯业务规则与 VO 不含 I/O 副作用。
- 自动检查 `backend/app` 不含 JS/MJS/TS；独立 `engine-adapter/src` 只做固定引擎注册与传输，TypeScript 源码接受类型检查，`dist` 作为忽略的构建产物，不在运行时编译，不携带 Node 业务服务。
- 前端按若依 Vue3 风格检查 `views/<domain>` 页面装配、`components` 通用交互展示、`composables/<domain>` 状态/行为复用、`api/<domain>` 传输适配、`store/modules` 共享状态、`types/<domain>` 类型和 `utils/<domain>` 纯方法；页面专属组件归对应 `views/<domain>/components`，路由、布局、样式分别归 `router`、`layout`、`assets/styles`。只建立有实际职责的目录，不再使用 `app`、`features` 目录或转发文件。
- 自动检查前端不导入后端实现/凭据，不在页面组件散布请求和领域规则；`utils/request.ts`、`api-config.ts`、`errors.ts` 仅承担集中请求基础适配，其他领域 `utils` 不含 I/O 副作用。依赖图、规模异常和跨层调用作为职责复核线索，不以行数阈值代替判断。
- 对业务路由、服务与前端展示检查版本来源：产品/构建/依赖版本从 manifest、锁文件或生成的构建元信息读取，不硬编码版本字符串、默认版本或分散拼接版本路由。
- 验证无版本的规范入口、生成客户端和 OpenAPI 来自同一契约；集中兼容清单覆盖旧路径，映射仅在入口部署/适配层应用，禁止业务 router 读取该清单后生成版本分支。
- 对版本扫描建立明确语义分类：外部协议要求的 `schemaVersion`、供应商版本路径、DSH/MCP 标识、业务资源 `revision`、历史事实 fixture、依赖 pin/校验哈希保留；不得用“去版本化”删除互操作及重现要求。
- 用不同构建元信息执行同一测试，确认展示/诊断版本随来源变化且业务逻辑无需修改；验证缺少必要元信息会明确失败，不回退到手写旧版本。
- 审查公共接口和关键业务边界的中文注释：说明职责、输入输出、不变量、幂等/取消/失败原因与设计取舍；复杂流程有必要解释，普通语句不逐行复述，不以注释覆盖率凑数。
- 测试 runner、fixture、断言辅助函数、契约差分和检查脚本均位于集中测试目录对应分类；生产模块不得反向导入测试工具、features 基线或 mock。测试源码使用独立配置接受类型检查，不因生产配置排除测试而漏检。
- 以故意违规的隔离 fixture 验证门禁本身：循环导入、硬编码版本、业务版本路由、测试泄入生产等必须被拦截；反例文件不进入生产树。
- 健壮性覆盖输入 schema/长度/大小、非法状态转换、并发冲突、超时、取消、连接释放、进程回收、临时文件清理和日志脱敏；错误可定位且不能泄露密钥或他人内容。
- 对数据库/缓存/对象存储/DSH 的部分失败验证事务边界、清理与恢复；重试有界且只用于已证明可重试的操作，未知副作用仍沿用 P3-07 收据规则。
- 前端验证快速重复操作、过期请求返回、路由离开后回包、令牌刷新竞态、断网重连和组件卸载；不允许旧响应覆盖新状态或后台无限请求。

**证据与输出：** 自动架构检查报告、版本来源追踪、规范/兼容入口差分、测试及镜像文件清单、中文注释职责复核、故障恢复/资源清理记录，统一存入本轮 `<run-id>`。

**退出条件：** 自动规则和违规反例均有效，职责及中文注释复核完成，健壮性用例通过，测试/运行产物未泄入生产；任一项未完成时不得通过 P3-12 或关闭 P3-13 总验收。

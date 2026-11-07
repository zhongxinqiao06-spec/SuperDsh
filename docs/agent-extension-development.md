# 智能体扩展、工具与技能

产品入口与启动命令见根 [README](../README.md)。Node 平台保存配置、凭据、版本和成果；Harness 保留唯一执行队列。工具进程不是另一套 Agent，也不构成操作系统沙箱。

## 资源关系与权限

扩展来源提供实现；工具配置选择实现版本、参数和加密凭据；技能关联配置好的工具及资料；智能体组合知识、模板、技能和工具并发布。四个示例可编辑、复制或删除，没有按助手名称分发的代码。

- `agents.manage` 编辑资源；`extensions.manage` 安装可执行代码、管理 MCP，二者独立。
- 表单来自 JSON Schema；`writeOnly: true` 字符串作为密钥加密保存，读取只返回设置状态。不要把凭据写进技能或工具输出。
- 新会话冻结配置和实现版本。空闲会话可以显式切换助手；旧消息、证据及成果保留版本，撤权仍阻止后续调用。工具/来源停用立即生效。
- 升级必须换版本；健康检查失败不替换现有版本。已引用版本保留，管理员可回滚。MCP 的新增工具或 Schema 变化须重新发现和授权。

## 本地扩展包

ZIP 根目录提供 `superdsh-extension.json`，示例：

```json
{
  "schemaVersion": 1,
  "id": "company.reports",
  "name": "公司报表工具",
  "version": "1.0.0",
  "license": "MIT",
  "description": "根据经过授权的输入生成文件",
  "runtime": "node",
  "entrypoint": "index.mjs",
  "tools": [
    {
      "id": "report",
      "name": "报表",
      "description": "生成公司报表",
      "mode": "action",
      "inputSchema": {
        "type": "object",
        "properties": { "title": { "type": "string" } },
        "required": ["title"],
        "additionalProperties": false
      },
      "configurationSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      },
      "permissions": ["sessions.run"],
      "artifactTypes": ["text/plain"],
      "timeoutSeconds": 30
    }
  ]
}
```

Node/Python 进程从 stdin 读取一个 JSON 请求，stdout 只输出一个 JSON 结果，诊断写 stderr。`operation: health` 返回 `{"ok":true}`；调用请求提供 `operation: invoke`、`toolId`、`arguments`、`configuration`、`context`。上下文仅包含已授权会话身份和资料内容，不接受客户端任意文件路径。结果可返回 `artifacts: [{name, mediaType, contentBase64}]`，平台校验并保存为会话成果。超时、取消会回收所属进程；不会自动重放可能产生费用的调用。

依赖在安装时准备：Node 包使用 `package.json` 和 `package-lock.json`，Python 包使用锁定的 `pyproject.toml`/`uv.lock` 与 Python 3.12。运行不临时安装依赖。包内不能包含 node_modules、虚拟环境、机器配置、绝对路径或符号链接；依赖安装不运行 npm 生命周期脚本。

`runtime: mcp-stdio` 使用包内入口并在安装时发现/校验声明工具。远程 MCP 使用 Streamable HTTP，在工具页面连接、发现、选择工具后保存；地址限制和凭据检查仍生效。没有通用 shell 工具兜底。

## 技能资料

### 自动匹配、阶段与运行记录

「技能管理」的编辑弹窗同时管理执行方法和阶段草稿。可选用 PPT/Word 流程起点，再编辑匹配词、排除词、输入格式、输出类型、各阶段说明、引用的单项技能、工具、输出 Schema、检查项和修订次数。保存草稿不会改变已发布流程，点击「发布阶段配置」后新绑定才使用新版本。「匹配试验」检查候选和规则命中；分数是规则计分，不是模型置信度。

新建或复制的 PPT/Word 示例分别绑定 `presentation-flow`、`document-flow`，采用自动匹配。原有智能体配置与会话不被改写：维护者可在智能体编辑弹窗中选择流程技能，将技能策略设为自动匹配（也可固定一个技能），在空闲会话重新绑定。新流程资源按一次性标记加入，不恢复已删除记录。旧技能指令模式仍可用。

```text
用户请求 → DSH 获取已绑定技能摘要 → match 候选过滤 / DSH 语义选择
  → start 固定技能版本 → 资料检查 → 策划 → 排版
  → 工具方案预检 → 原 userQuestions.ask 确认 → 原工具生成
  → 读取真实成果检查 → review → 会话预览 / 下载
```

平台的 `skills/runtime.ts` 只验证和记录 DSH 的调用，不启动另一轮模型、不执行独立队列。候选只来自本会话已发布且有权使用的技能；格式与排除条件先过滤，词项排序后由当前 DSH 模型选择。歧义应询问用户，普通问答不用强制启动流程。技能正文按当前阶段加载，引用的单项技能也使用冻结版本。

阶段可配置 `inspect`（真实只读工具）、`submit`（结构化策划/设计）、`prepare`（预检与确认）、`execute`（真实生成）、`review`（成果复核）。`prepare`/`execute` 必须相邻并使用同一工具。每个工具阶段记录一次调用；需要多个工具时增加阶段。引用技能只复用方法，不嵌套调度或执行脚本。

检查目录由代码提供：`schema`、`sources`、`plan`、`artifact`、`rendered-quality`。后四项从授权解析器、方案哈希及数据库成果记录取证，模型不能用一句“通过”替代。工具本身的权限、输入和渲染检查不能在技能配置中关闭。最终检查通过表示结构、渲染等报告通过，不代表视觉模型或 Office 客户端已经审美验收。

`agent_skill_runs` 保存账号、会话、绑定版本、原始请求、匹配依据、技能快照、当前阶段、修订和历史；`agent_skill_events` 保存状态变化。工具调用、输入来源、方案与成果通过 `skillRunId` / `skillRevision` 关联。网页与桌面成果区展示相同记录。读取接口为 `GET /api/v2/sessions/{id}/skill-runs` 和 `.../skill-runs/{runId}`，沿用会话归属授权。

每次推进校验版本、请求和工具执行归属；重复请求复用记录，迟到响应不能覆盖新阶段。修订会保留旧阶段、使原确认失效，必须重新确认才能生成。等待确认不计入生成时限。取消、超时、失败、进程中断分别记录；平台重启只标记中断，不重放工具或收费请求。达到修订上限后，用户可明确结束未完成技能再开始新任务；控制工具必须收到新的用户请求，不能自行取消或取消仍在执行的工具。运行记录不是任务调度器。

PPT 默认拆为三个普通技能：`presentation-planning`（内容策划）、`presentation-layout`（版式设计）、`presentation-quality`（质量校验）。在「智能体管理 → 技能管理」可分别编辑指令、依赖工具、启停和查看/恢复版本，再在智能体编辑弹窗中按顺序绑定。三者默认依赖 `presentation_report`；配图工具由智能体另外授权，不在技能中保存模型密钥。旧 `business-presentation` 保留兼容。

Host 使用会话冻结的技能名称、ID、版本和正文，缺失配置会明确失败。修改技能用于新会话或空闲会话重新绑定，历史方案和成果保留原版本；停用技能立即阻止后续工具执行。默认资源按一次性标记增量加入，编辑过、停用或删除的记录不会被覆盖/恢复。未改动的 PPT 示例升级到三个技能，定制示例可手动绑定或复制新版。

技能规定策划、设计与校验方法，工具负责输入授权、结构校验、最终文件渲染和成果存储。技能不能关闭这些检查，也不能把模型自述当作 PowerPoint/视觉验收。工具调用仍走 DSH 原有执行与方案确认链路，不新增队列。

独立技能 ZIP 根目录包含以下文件：

```text
SKILL.md
references/policy.md
templates/company.pptx
```

`SKILL.md` 的 YAML 元数据需要 `name`、`description`，可含 `requiredToolIds`；正文写工作方法。导入时明确选择依赖的工具配置。参考文件支持 Markdown、文本、CSV、XLSX、DOCX、PPTX 模板和文字 PDF；脚本必须另行注册为工具，不能由技能提示词直接执行。

扩展清单可声明 `skills: [{id,name,description,entrypoint,requiredToolIds}]`。技能管理的导入弹窗可选择已安装扩展，读取对应 `SKILL.md` 所在目录的 `references/` 与 `templates/`，不会导出代码和运行依赖。参考资料解析在事务外完成，资料与技能在短事务内整体提交；旧版本仍可查询和恢复。

## JSON 到可靠配图

内置 `illustration_render` 接收办公工具的 `action: plan` 和 `planJson`，示例内容如下：

```json
{
  "title": "交付流程",
  "layout": "flow",
  "nodes": [
    { "id": "input", "title": "核对资料", "detail": "确认来源与使用范围" },
    { "id": "review", "title": "校验交付", "detail": "保留原文件与修订版本" }
  ]
}
```

支持 `flow`、`timeline`、`organization`、`compare`、`metrics`，2–9 个节点。组织图最多三层，使用 `parentId`；指标的 `value` 必须来自资料。配置中的 `designTheme` 可编辑字体、颜色和密度；字体资源由平台管理。工具拒绝脚本、原始 SVG、外部 URL、循环关系与不可读文字溢出。

用户确认后得到 PNG 成果。后续 PPT/Word 通过 `inputsJson: [{artifactId,role:"image"}]` 检查图片，再使用返回的 `imageId`。图片、方案、来源哈希、依赖版本和文档修订归属同一会话。PNG 可用于概念/关系图，精准表格与数据图表仍应使用文档原生对象。

## 验证

扩展测试为 `extensions-runtime.test.mjs`、`extensions-mcp.test.mjs`、`extensions-database.test.mjs`；绘图为 `illustration-render.test.mjs`；真实 Host 链路为 `business-agent-runtime.test.mjs`。集成入口使用临时 PG/Redis/Qdrant。模型 fixture、真实商业模型、最终文件渲染和 Microsoft Office 检查必须分别记录。

依赖固定在 Yarn 锁文件：PptxGenJS、pptx-automizer、docx、resvg-js 使用原许可；字体使用 Noto CJK/OFL，准备脚本保存许可证。PPTAgent 作为逐页渲染校验方法参考，未引入其 Agent 系统或复制其代码。

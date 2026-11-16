# 星桥娱乐第一阶段实施与验收

对应[作品制作方案](starbridge-studio-workflow.md)阶段 A。范围为菜单、作品规格、结构化故事与分镜、素材版本、基础权限、可靠保存及旧工程转换。阶段 B/C/D 的参考图生产、声音试听、统一制作计划、拖动剪辑和正式交付检查仍按原计划推进，不在本阶段宣称完成。

## 用户流程

1. **我的作品**：在“正在创作/已归档”间切换，按名称检索。新建弹窗填写名称、故事构想、画幅、目标时长、视觉风格和语言；默认规格由服务端产品资源加载。创建后进入剧本页，不调用模型、不提交媒体任务。
2. **作品构想**：随时修改规格，独立保存并核对工程修订。历史作品未提供的画幅/时长保持空值，引导补充，不伪造确认结果。
3. **剧本与场次**：保留剧本原文及原文/改编意图，增删、排序、编辑场次。有镜头引用的场次不能从界面直接移除；先重新分配镜头。场次与场景素材是不同对象。
4. **角色与场景**：选择个人库的具体版本或创建本片版本。作品内角色、场景、道具各有身份；个人库版本进入作品时建立派生版本。创建新造型不替换其他作品，不自动覆盖已关联镜头。版本和引用位置可追溯。
5. **分镜设计**：沿用稳定 ID，增删、复制、拆分、排序，编辑所属场次、动作、景别、构图、运镜、时长和逐句台词。导演草案有独立审阅入口，未采用的草案不会覆盖工程。
6. **自动保存**：停止输入后延迟保存，界面显示未保存/保存中/已保存。请求结果未知时，手动重试使用原操作号；同号不同内容冲突。保存期间的新输入继续保留。遇到版本冲突停止自动写入，用户明确确认后才载入远端内容。离开页面、切产品及关闭窗口保护未提交草稿。
7. **试做一镜、批量制作、剪辑与字幕、成片交付**：接入已有分镜候选、媒体任务、剪辑及导出能力。试做复用单镜生成；“成片交付”主菜单仅查询本人已成功导出结果。后续阶段会增强这些业务，不展示虚构进度或假成片。
8. **归档恢复**：归档保留工程、历史和成果；禁止编辑和提交新制作任务，恢复后继续制作。

## 一二级菜单

| 一级       | 二级       | 路径                          | 必需动作权限           |
| ---------- | ---------- | ----------------------------- | ---------------------- |
| 创作工作台 | 我的作品   | `/entertainment`              | `studio.projects.read` |
| 创作工作台 | 制作任务   | `/entertainment/tasks`        | `studio.projects.read` |
| 创作工作台 | 成片交付   | `/entertainment/deliveries`   | `studio.projects.read` |
| 素材中心   | 角色库     | `/entertainment/characters`   | `studio.assets.read`   |
| 素材中心   | 场景与道具 | `/entertainment/environments` | `studio.assets.read`   |
| 素材中心   | 媒体素材   | `/entertainment/library`      | `studio.assets.read`   |

以上页面同时要求娱乐产品资格。编辑分别要求 `studio.projects.write` / `studio.assets.write`；文件、模型、会话继续执行原权限。管理员角色不绕过作品所有权。

作品内使用八个上下文步骤，不扩成全局三级菜单。旧 `section=library/timeline/jobs` 深链分别显示“角色与场景/剪辑与字幕/批量制作”。菜单升级只执行一次，保留自定义名称、隐藏与角色限制；办公菜单不迁移。

## 本阶段数据库落地

本阶段新增 **17 张实际使用的表**，演进现有作品表与任务表；不是提前建立 25 张空表。完整目标字典仍为[数据字典](starbridge-studio-schema-dictionary.md)。

| 表                               | 当前业务与关键关系                                                       |
| -------------------------------- | ------------------------------------------------------------------------ |
| `studio_scripts`                 | 作品唯一剧本：原文、改编意图、剧本修订                                   |
| `studio_story_scenes`            | 作品内场次 ID、标题、摘要、排序、归档时间                                |
| `studio_shots`                   | 作品内镜头 ID、场次复合外键、动作与镜头语言、计划时长、排序、归档        |
| `studio_lines`                   | 作品内台词 ID、镜头复合外键、说话角色版本、文本、音色、排序、归档        |
| `studio_entities`                | 本人角色/场景/道具身份、可选项目、当前版本、修订                         |
| `studio_entity_versions`         | 不可变名称/设定/声音版本、来源版本、可空声音模型配置版本                 |
| `studio_entity_version_assets`   | 设定版本的参考媒体版本、用途和排序，支持多参考关系                       |
| `studio_asset_families`          | 本人媒体身份、可选项目、类型与当前版本                                   |
| `studio_asset_versions`          | 不可变媒体版本、公共文件引用、来源版本与生成任务                         |
| `studio_project_assets`          | 作品关联具体媒体版本与排列位置                                           |
| `studio_project_entity_versions` | 作品显式保留具体设定版本，支持同一角色多个造型                           |
| `studio_shot_references`         | 镜头引用设定或媒体版本，数据库约束二选一                                 |
| `studio_timelines`               | 一作品一工程时基、帧率、采样率、音乐音量偏好                             |
| `studio_tracks`                  | 画面、角色配音、字幕、音乐轨道，作品内排序唯一                           |
| `studio_clips`                   | 当前采用来源、时间与裁剪、字幕文案及音量；镜头、台词、任务同作品复合外键 |
| `studio_commands`                | 作品写入幂等号、输入指纹及提交结果，业务写入同事务提交                   |
| `studio_project_snapshots`       | 工程修订对应的规格、文档、时基和指纹；恢复规格与文档                     |

实际建表 DDL 已冻结到 `backend/migrations/data/studio_foundation_schema.json`；迁移版本为 `fa619c2d804e`。DO 位于 `app/modules/studio/entity/do`，由 Alembic 注册；迁移执行时不导入可变业务 ORM。API 字段以 VO 为准，读写经过 service/dao。

### 对目标字典的阶段性细化

- 保留现有 `studio_projects.owner/updated` 和媒体任务列名，不为改名破坏既有查询。新增规格、生命周期、创建请求号及时间。子对象依作品聚合修订并发，不另建互相竞争的逐行修订协议。
- 老数据允许两部作品使用相同镜头/台词 ID，因此主键是 `(project_id,id)`；引用同样包含作品范围。身份不因重新排序改变。
- 作品可以同时引用同一角色的不同造型，增加 `studio_project_entity_versions` 显式关系。这是对目标字典的补充，不把“家族当前版本”当成所有镜头默认采用。
- `studio_assets` 变为只读兼容视图，映射设定/媒体版本；原表改名为 `studio_assets_legacy` 留作迁移来源。正式写入不再写旧表。
- 当前可编辑工程来自结构化表。为保持旧 DSH、媒体任务和修订查询契约，本阶段每次保存仍追加不可变 `studio_revisions` 文档投影与工程快照；没有两套可变工程。后续切换完整制作/剪辑契约后，再实施快照合并和历史保留策略。
- 接口仍使用毫秒，当前时间线使用工程 tick；旧工程按原渲染时基转换。源媒体独立时基、实际媒体探测、自由多轨编辑在阶段 C/D 实施。
- 新增角色/场景/媒体菜单目前逐版本列示，展示版本序号和来源。参考图生成、声音试听、阶段确认以及“设定已定稿”状态归阶段 B；不以填写字段代替定稿。
- `studio_proposals`、`studio_stage_reviews`、`studio_generation_batches`、`studio_job_attempts`、`studio_candidates`、`studio_validation_runs`、`studio_exports` 的新契约按 B/C/D 建设；现有草案、媒体任务与导出仍可使用。

## 升级与恢复

- 正常入口仍是后端 `uv run python main.py`、前端 `npm run dev`；本次不增加启动器。
- 升级前停止旧后端进程并备份当前数据库和文件目录；部署沿用既有持久卷。启动迁移与媒体执行器争用同一数据库锁，执行器未退出时拒绝升级。
- 升级在 PostgreSQL 事务内完成：建结构 → 转素材 → 建只读视图 → 转当前工程 → 补动作授权和娱乐菜单。旧修订、媒体任务及供应商回执不重写，不重新提交任务。
- 缺失当前修订、不可访问素材、来源环或外键错误导致事务回滚；不得自动跳过、伪造数据或 stamp 版本。
- 迁移后的旧文件与素材 ID 仍保留；本片派生版本有明确来源链。迁移新增记录的创建时间代表转换时间，不能当作旧作品真实创作时间。
- 不提供会丢弃新结构数据的自动 downgrade；回退使用升级前数据库与文件备份，并配套恢复原服务版本。

## 验收记录

状态：2026-11-15 第一阶段完成。所有数据库/账号均由隔离 runner 创建并清理，不连接用户业务库、不读取真实模型配置，不把受控媒体当作真实供应商验收。

| 检查                    | 结果与边界                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 受影响 FastAPI 集成测试 | 16 项通过；覆盖新旧作品、素材版本、真实迁移及回滚、媒体任务、菜单和产品权限。保留 1 条既有 SQLAlchemy `Result.tuples()` 弃用提示，不影响结果。                                      |
| Vue 单元测试            | 146 项验证通过。首次全量为 145 通过、1 项旧菜单预期失败；更新为六菜单后对应文件 6 项复跑通过。                                                                                      |
| 浏览器回归              | 13 个不同场景验证通过：9 个受控接口场景，4 个真实后端场景。首次合并运行的归档恢复断言未等待异步完成，改为轮询最终状态后完整新流程复跑通过；只读交互另行通过。                       |
| 真实账号与权限          | 五种角色及“办公管理员＋娱乐创作者”登录、产品切换及直接越权接口；本人作品和素材作用域保持隔离。                                                                                      |
| 交互与布局              | 新建规格、场次和分镜、自动保存、保存响应丢失后原号重试、版本冲突、归档恢复、只读禁用；390/768/1280/1440px 深浅主题检查，人工审看桌面浅色与手机深色截图。                            |
| 静态检查                | 前端及测试 TypeScript、Python mypy（52 个源文件）、Ruff、Prettier、受影响 ESLint、Python 分层检查通过；Node 架构及配置 11 项通过。既有媒体组件保留 3 条属性排序 warning，无 error。 |
| 旧包保护                | `apps/admin` 的 746 个已有文件内容与任务开始时的 SHA256 基线一致，未修改旧包。                                                                                                      |

主要复现命令（仓库根目录）：

```powershell
node apps/web-admin/tests/tooling/run-backend.ts ../tests/backend/test_studio_foundation.py ../tests/backend/test_studio_foundation_migration.py ../tests/backend/test_studio_projects.py ../tests/backend/test_studio_directory.py ../tests/backend/test_studio_media.py ../tests/backend/test_product_navigation.py ../tests/backend/test_product_members.py ../tests/backend/test_product_capabilities.py ../tests/backend/test_product_role_migration.py ../tests/backend/test_product_session_boundary.py --tb=short -q
node node_modules/vitest/vitest.mjs run --config apps/web-admin/tests/fronted/vitest.config.ts
node apps/web-admin/tests/tooling/browser.ts studio-foundation-live.spec.ts studio-live.spec.ts studio.spec.ts product-roles-live.spec.ts
node node_modules/vue-tsc/bin/vue-tsc.js -p apps/web-admin/fronted/tsconfig.json --noEmit
node node_modules/vue-tsc/bin/vue-tsc.js -p apps/web-admin/tests/tsconfig.json --noEmit
```

修复后的定向复跑：`routing-and-drafts.test.ts`、`studio-foundation-live.spec.ts`，以及 `studio.spec.ts` 的“只读作品”场景。收尾补齐 PostgreSQL 画幅宽高成对约束，避免空值绕过 CHECK；真实迁移保留和失败回滚 2 项再次通过。未在本阶段执行全仓库所有平台测试，也未进行真实供应商收费生成；参考图、音色试听、完整成片体验继续按 B/C/D 验收。

隔离 runner 已删除本轮容器、测试数据库、账号、Home 和临时文件，并停止其后端与前端服务。用户运行中的服务、业务数据及真实配置不清理。

收尾限制：删除截图、日志和测试缓存的命令被自动审批以 `blocked by policy` 拒绝；核对绝对路径且改用明确目录后仍被拒绝。本轮过程文件暂留 `.superdsh-work/web-admin-validation/studio-foundation`、`fronted-tests`、`fronted-e2e`，均在生产源码之外。这里不包含仍在运行的测试数据库或服务。

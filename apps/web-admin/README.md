# Web Admin

新管理端采用 Vue3 + TypeScript 和 Python FastAPI，保持旧 `apps/admin` 独立可用。工程约束见 [AGENTS.md](AGENTS.md)，基础能力和业务迁移进度分别见[计划一](../../docs/plans/web-admin-01-foundation.md)、[计划二](../../docs/plans/web-admin-02-function-and-interaction.md)；完整差异验收见[计划三](../../docs/plans/web-admin-03-parity-validation.md)。所有管理模块均装配独立页面，缺失页面会在启动时明确失败。

## 目录与责任

- `fronted/src`：按若依 Vue3 风格组织；`views/<domain>` 放页面，`api/<domain>` 放接口，`composables/<domain>` 放用例，`types/<domain>` 与 `utils/<domain>` 放类型和纯方法。`components` 放通用组件，页面专属组件归对应 `views/<domain>/components`。
- `fronted/src/router`、`layout`、`store`、`assets/styles`：分别负责路由、公共布局、共享状态与样式。入口为 `main.ts`、`App.vue`；请求封装为 `utils/request.ts`，共享状态为 `store/modules`，不再使用 `app`、`features` 目录。
- 视觉以原管理端为基准，若依仅约束代码分层：`tokens.css` 统一颜色/字体/圆角，`base.css` 负责基础排版，`element.css` 适配通用控件，`console.css`、`management.css`、`dashboard.css`、`workbench.css` 按展示领域组织。共享 `AppIcon` 使用带来源与许可的本地图标；新前端不从旧包加载运行资源。
- `backend/app/modules`：按领域组织 `controller → service → dao`，`entity/do` 为数据库实体，`entity/vo` 为请求和响应模型。后端业务源码仅使用 Python。
- `engine-adapter/src`：固定 DSH 必要的 TypeScript 插件注册及传输，不承载平台业务；编译到被 Git 忽略的 `dist`，Python 仅启动已构建产物。
- `contracts`：生产协议；`deployment/compatibility-routes.json` 是旧入口映射的唯一来源，新前端使用无版本路径。
- `tests`：全部测试、合成输入及冻结的旧端契约。临时数据库、账号、Home、报告和缓存输出到仓库 `.superdsh-work/web-admin-validation`，不进入源码或生产镜像。
- `scripts`：TypeScript 构建、配置及启动入口；全局版本读取现有产品 manifest，镜像和工具链版本集中在 `deployment/runtime.json`。

## 本机开发

推荐在两个终端分别使用 **uv 启动后端、npm run dev 启动前端**，无需先 build。需要根工程要求的 Node/Yarn、可用的 uv，以及已运行的 Docker Linux 引擎。

先执行 `uv --version` 确认安装工具可用。如果找不到命令或 `python -m uv` 报 `No module named uv`，在仓库根目录为当前 Python 安装并验证 uv：

```powershell
$webAdminRuntime = Get-Content apps/web-admin/deployment/runtime.json -Raw | ConvertFrom-Json
python -m pip install "uv==$($webAdminRuntime.uvVersion)"
python -m uv --version
```

若 pip 显示已安装但仍无法导入，可能是该终端未加载用户包目录。将同一固定版本明确安装到当前解释器，再验证：

```powershell
python -m pip install --no-user --ignore-installed --no-deps "uv==$($webAdminRuntime.uvVersion)"
python -s -m uv --version
```

`python -m uv --version` 成功后，若 `uv` 命令仍不在 PATH，可将下方命令的 `uv` 替换为 `python -m uv`。

首次准备在仓库根目录执行；已有前端依赖可跳过安装。`init` 先准备项目管理的 Python 和后端 `.venv`，再生成开发配置并启动 PostgreSQL、Redis，不启动前后端或构建镜像：

```powershell
corepack yarn install --immutable
corepack yarn web-admin:init
```

基础 Python 安装在 `.superdsh-work/web-admin-tools/python`，虚拟环境统一使用 `apps/web-admin/backend/.venv`；原生 uv 命令和根启动命令共用这一个环境。准备流程以项目解释器的实际路径同步依赖，避免旧环境继续引用用户 Roaming 下的 Python。若配置和数据库已就绪，仅需修复 `No Python at ...` 或重新安装依赖，在仓库根目录执行 `corepack yarn web-admin:prepare`，完成后再运行下面的后端命令。

每位开发者拉取代码后都需执行首次初始化，不复制他人的 `.venv` 或 `.superdsh-work`。这些目录被 Git 忽略；Windows 虚拟环境保存本机基础解释器的绝对路径，移动项目目录或删除工具解释器后，应重新执行 `web-admin:prepare`，由当前机器重建可用环境。

终端一，从仓库根目录进入后端：

```powershell
cd apps/web-admin/backend
uv run python main.py
```

uv 复用准备好的本目录 `.venv` 并按 `uv.lock` 同步依赖，无需手动激活。项目设置为直接运行源码，不在启动时构建 Python 包。`backend/main.py` 作为启动入口，读取初始化导出的独立配置、执行新库迁移，启动 `http://127.0.0.1:8001`，默认开启代码热重载；追加 `--no-reload` 可关闭热重载。Python 缓存放到仓库工具目录，不写进业务源码。已有有效环境时，也可在后端目录执行 `uv sync --frozen` 单独同步依赖；环境缺失或基础解释器失效时使用上述 `web-admin:prepare`。`backend/app/main.py` 保持 FastAPI 的 ASGI 应用装配职责，由启动入口调用，不作为另一套开发命令。

缓存统一位于 `.superdsh-work/web-admin-tools`：Python 字节码为 `pycache`，uv 下载/解析为 `uv-cache`，Ruff 与 mypy 分别为 `ruff`、`mypy`。入口在读取业务配置和导入第三方模块前设置缓存路径，热重载与子进程继承同一设置；指向源码或项目工作目录之外的 Python 缓存配置会明确失败。首次 `uv lock` 在运行入口之前解析动态版本时，仅对本项目元数据构建禁用字节码写入，正常服务仍保留外置字节码缓存。Docker 运行时对应使用可写数据卷内的 `/data/runtime/.superdsh-work/pycache`，不向 `/app` 源码目录写缓存。

裸 `uv`、`ruff` 命令在 `apps/web-admin/backend` 目录运行；根工程命令由脚本注入绝对缓存路径。测试缓存继续使用 `.superdsh-work/web-admin-validation/<run-id>`，不混入日常运行缓存。不要把 `PYTHONPYCACHEPREFIX`、`UV_CACHE_DIR`、`RUFF_CACHE_DIR`、`MYPY_CACHE_DIR` 指回源码目录。

终端二，从仓库根目录进入前端：

```powershell
cd apps/web-admin/fronted
npm run dev
```

打开 `http://localhost:5175`。前端 `package.json` 只提供本目录的运行命令，依赖继续使用根 Yarn 和锁文件，不需要在此执行 `npm install` 或产生第二份锁文件；该命令不会启动后端。分别在两个终端 Ctrl+C 关闭服务。

开发配置位于 `.superdsh-work/web-admin-dev/config`，后端读取其中的 `backend-environment.json`，不把密钥复制到源码。修改 `settings.json` 的端口等配置后重新执行 `web-admin:init` 导出配置；两端需重启。`WEB_ADMIN_CONFIG_ROOT` 可显式选择另一开发配置目录，`UV_PROJECT_ENVIRONMENT` 可指定虚拟环境，`UV_PYTHON_INSTALL_DIR` 可指定受管 Python 安装目录；使用自定义值时，准备命令与原生启动终端应保持相同设置。开发 PostgreSQL、Redis 配置 `unless-stopped` 恢复策略；若手动停止过依赖、尚未初始化或正在使用旧容器配置，在仓库根目录重新执行 `corepack yarn web-admin:init`，再启动后端。该命令复用已有配置和数据卷，不需要 build。

`uv run python main.py` 只启动 Python 后端，前提是上述依赖已运行；它不会自行启动 Docker。若出现 `WinError 1225`、连接被拒绝或 PostgreSQL 连接失败，说明迁移阶段尚未连接到数据库，先检查 Docker 和开发依赖容器状态。恢复步骤为：

```powershell
# 仓库根目录：恢复开发 PostgreSQL、Redis 并等待健康
corepack yarn web-admin:init

# 后端目录：独立启动
cd apps/web-admin/backend
uv run python main.py
```

原有合并命令 `corepack yarn web-admin:preview` 仍可用：自动准备同一个后端 `.venv` 后一起启动前后端。安装工具、受管 Python 和缓存位于 `.superdsh-work/web-admin-tools`，应用依赖位于后端 `.venv`。后台管理和登录不会自动启动 Agent。

首次使用工作台 DSH 执行能力时，需要已有固定引擎产物；缺少时显式运行 `web-admin:sync`，该命令在准备 Python 依赖后构建引擎适配。它不是浏览基础管理页面的前置步骤，普通预览不会隐式构建引擎。

完整开发中间件仍用 `web-admin:deps:up`，该命令包含对象存储镜像构建，不是预览的前置步骤。

Office 文档生成与预览需要 LibreOffice 和文档所用字体。Windows 优先使用显式配置或已安装的 LibreOffice，未找到时自动使用固定 DSH 依赖树中已有的 LibreOfficeKit 原生渲染组件，校验安装清单与程序摘要，不在运行时下载。可在启动后端的终端设置 `$env:WEB_ADMIN_OFFICE_EXECUTABLE = '你的 LibreOffice 路径/program/soffice.com'` 指定 CLI，或通过 `WEB_ADMIN_OFFICE_NATIVE_MANIFEST` 指定原生组件的 `prebuilds.json`；显式 CLI 配置优先。Linux 使用 PATH 内的 `libreoffice`，Docker 镜像已声明渲染器及中文字体依赖。缺少渲染器时工具在方案准备阶段明确报错；实际渲染后检查文本、页数和字体，不返回虚假的预览或质量通过结果。临时渲染配置、缓存、PDF 和缩略图归 `.superdsh-work` 的运行目录。

知识检索使用声明的索引配置和独立 Qdrant；本地嵌入资源按校验摘要下载至运行目录，外部模型需要管理员显式配置。MCP 与 Node/Python 扩展在安装时准备依赖并检查健康状态；普通会话始终使用固定 DSH，LangGraph 只可选记录技能状态。Office 示例是可编辑资源包，显式初始化后生成真实资料、知识库和组合，重进页面不会恢复被删除的配置；“复制最新示例”保留已有定制。

模型与连接配置保存在新管理端数据库，凭据加密保存，重启后保留。新建 DSH 会话未手动选模型时，按当前账号可访问的个人默认／平台默认选择；手动选择优先，已有会话保持其选择。授权目录给出的默认模型在 DSH 目录中不可用或尚未同步时明确报错，不自动换供应商。模型页面的“只读检测”只查询供应商模型目录，不发起收费生成；目录返回 404/405 时显示“无法确认”，不能据此判定密钥无效或模型可用，实际对话需要单独验证。

长工具流程需按供应商实际能力填写聊天配置的 `parameters.contextWindow`；它表示上下文容量，`parameters.maxTokens` 表示单次输出上限，两者不可混用。容量应来自供应商模型目录或官方文档，避免 DSH 用不准确的目录容量判断长会话。配置写入 `backend/config/model-defaults.json` 后重启后端和对应服务端 Agent 生效；不按模型名称在业务代码中硬编码容量。

若本机代理使用 Fake-IP DNS（例如把供应商域名解析到 `198.18.*`），或需要连接明确允许的内网模型，可在持久 `settings.json` 配置 `providerAllowedOrigins` 数组，只填写确切来源，例如 `https://api.deepseek.com`、`https://ark.cn-beijing.volces.com`，不带 API 路径、末尾斜杠、凭据或通配符。执行 `yarn web-admin:init` 重新导出配置，再重启后端生效；普通公网环境无需配置。也可显式设置逗号分隔的 `WEB_ADMIN_PROVIDER_ALLOWED_ORIGINS` 环境变量。其他目标仍须通过原有地址校验；该配置不会更改 DNS、代理或模型密钥。

首次启动后端时，自动按 `.superdsh-work/web-admin-dev/config/settings.json` 的 `initialAdmin` 创建管理员，默认用户名 `admin`、密码 `admin123`，直接在登录页登录，无需初始化令牌。默认值集中在 `deployment/initial-admin.json`；`web-admin:init` 为新配置写入该项，旧配置仅补齐缺失字段，保留原有密钥和端口。

`initialAdmin` 包含 `username`、`password`、`displayName`。空库初始化前可修改，再运行 `web-admin:init` 并启动后端；已有任意账号时不再创建或重置管理员，因此以后修改密码或重启均不会被配置覆盖。原生启动和 Docker 使用同一套 `WEB_ADMIN_INITIAL_ADMIN_*` 配置；生产配置位于 `.superdsh-work/web-admin-production/config/settings.json`。部署密钥不可提交或复制到测试报告。新旧站点并行使用不同 hostname 或浏览器 context，Cookie 不按端口隔离。

### 后端启动默认模型

后端每次启动默认读取 **`apps/web-admin/backend/config/model-defaults.json`**，并在提供 API 前以单一事务同步平台连接、能力配置和默认选择。路径由后端源码位置定位，不受当前工作目录影响；初始化只创建空模板，不覆盖已填写的内容。

- 开发和生产默认使用同一后端目录中的实际文件。开发执行 `web-admin:init` 后直接使用 `uv run python main.py`；模型文件不再放在 `.superdsh-work`。
- Docker 由启动脚本导出 `WEB_ADMIN_MODEL_DEFAULTS_SOURCE` 作为宿主机源文件，只读挂载到容器内 `/app/apps/web-admin/backend/config/model-defaults.json`。实际文件被 Git 和 Docker 构建上下文排除，镜像只包含无凭据模板；Linux 部署需保证容器用户 UID 1000 可读取挂载文件。
- 此服务器的原始模型配置只读挂载自 `/etc/superdsh/web-admin/model-defaults.json`。仓库中的 `deployment/model-defaults.json.gpg` 是完整原文的加密备份，解密口令单独保存在服务器的 `/etc/superdsh/web-admin/model-backup.pass`，请随主机密钥备份。恢复时在仓库根目录执行 `(umask 077 && gpg --batch --passphrase-file /etc/superdsh/web-admin/model-backup.pass --output /etc/superdsh/web-admin/model-defaults.restore --decrypt apps/web-admin/deployment/model-defaults.json.gpg)`，校验并设置属组 1000、权限 0440 后再替换挂载文件。
- 模板为 `backend/config/model-defaults.example.json`。`WEB_ADMIN_CONFIG_ROOT` 仍用于数据库、管理员等运行设置，不再改变模型配置的默认位置；旧 `backend-environment.json` 内的模型路径会被原生入口忽略。分环境部署时，可在启动终端显式设置 `WEB_ADMIN_MODEL_DEFAULTS_FILE`，原生 Python 和根启动脚本均支持该覆盖。

文件包含三个部分：

| 字段             | 内容                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `connections`    | 稳定 `id`、`name`、`adapter`、`baseUrl`、`apiKey`、`enabled`，可选 `region`。协议使用现有供应商适配器；不填写交互式 `revision`。 |
| `configurations` | 稳定 `id`、`connectionId`、`name`、`capability`、`modelId`、`enabled`，以及 `parameters`、`roleIds`；连接必须在同一文件声明。    |
| `defaults`       | 能力到配置 ID 的映射，例如 `{"chat":"你的聊天配置ID"}`；这里引用配置 ID，不是供应商模型名称。                                    |

文件中声明的记录以文件为准，页面修改同一记录后会在下次启动重新应用文件值；未声明的个人模型和其他平台记录不受影响。修改后重启后端生效，重复启动不新增记录或无意义修订。已有连接被引用后不能直接换地址/协议，已有模型配置不能改变连接/能力；换连接时使用新的稳定 ID。

供应商连接由聊天和多模态配置共享，可通过页面右上角“供应商连接”查看；`capability: "chat"` 的配置显示在“聊天模型”，视觉理解、图片生成等配置显示在“多模态模型”。只有聊天配置时，多模态列表为空不表示连接或密钥未保存；需按实际模型及接入点支持的能力新增配置，不能仅凭供应商名称自动开通能力。

火山 Agent Plan 的本机启动配置已补充以下两项，复用已有火山连接与密钥，聊天默认仍为原 DeepSeek 配置：

| 能力             | 模型                      | 启动参数                                                   | 默认配置 ID                 |
| ---------------- | ------------------------- | ---------------------------------------------------------- | --------------------------- |
| `vision.analyze` | `doubao-seed-2.1-pro`     | `maxTokens: 4096`、`maxImages: 4`、`thinking: "disabled"`  | `volcengine-vision-default` |
| `image.generate` | `doubao-seedream-5.0-pro` | `imageProfile: "seedream-5"`、`size: "2K"`、`maxImages: 4` | `volcengine-image-default`  |

两项在 `defaults` 中分别声明，后端每次启动同步，新会话的工具按能力冻结默认配置。图片生成与参考图编辑共用 `image.generate`；保留 Agent Plan 专属地址，不自动切到普通后付费地址。接入要求见[火山官方视觉模型文档](https://console.volcengine.com/ark/region:cn-beijing/docs/agent-plan-personal-visual-models)。语音、视频及多模态向量能力尚未由本模型工具接入，不能仅在文件里标记启用。新拉取代码仍需在被 Git 忽略的实际配置文件中填写自己的连接及密钥。

真实供应商验收脚本为 `tests/tooling/live_multimodal_probe.py`，必须指定配置文件、配置 ID、验证目录及 `--allow-external`，只在明确授权后运行；本机代理 DNS 场景需显式传入与部署配置一致的 `--allowed-origin`。脚本通过生产协议构造器发送视觉、单张生成和参考图编辑请求，不重试失败提交，不保存图片或凭据，不纳入自动离线测试。

阿里云 Token Plan 的本机配置使用 `aliyun-token-plan` 连接（`openai-completions`），Base URL 为 `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，聊天配置 `aliyun-token-plan-chat` 对应 `qwen3.8-flash`。密钥仅保存在被 Git 忽略的后端配置文件中，数据库保存密文；新增连接不改变已有默认模型。套餐地址依据[阿里云 Token Plan 接入说明](https://help.aliyun.com/zh/model-studio/token-plan-team-quickstart)，不可与 Coding Plan 或按量付费地址混用。本机代理 DNS 使用开发配置的 `providerAllowedOrigins` 精确放行该 origin；修改并导出配置后，须完整重启已运行的后端加载新值，单纯刷新网页不会更新进程环境。

省略 `apiKey` 或留空保留库中已有密钥，`clearApiKey: true` 才明确清空；省略某个默认能力保留原选择，显式 `null` 清空该能力默认。删除文件内条目不会删除数据库记录，需要停用时保留条目并设置 `enabled: false`。密钥写入数据库时加密，启动不发出模型生成请求；非法文件、重复配置、无效引用或参数会中止启动并整体回滚模型同步。

本机现有 DeepSeek 与火山方舟已迁入该正式文件，保留原连接/配置标识和密钥，聊天默认仍为 `deepseek-flash`。新后端不再依赖 `.superdsh-work/server-dev/model-initialization.json` 或测试导入脚本；旧文件保留供旧平台使用。

开发依赖使用独立 Compose project，默认数据目录为 `.superdsh-work/web-admin-dev`，与旧平台目录及数据库分开。端口、数据库及签名/加密密钥在第一次初始化后保持稳定；发现数据而配置丢失时必须恢复原配置，不生成另一套密钥。

数据库连接超时时，先运行 `docker version`、`docker ps` 检查引擎是否响应，再在仓库根目录执行 `corepack yarn web-admin:init` 恢复开发依赖。本机曾出现 PostgreSQL 容器内部健康、宿主机连接超时，同时 Docker 引擎/API 失去响应的情况；恢复 Docker 后原配置即可使用。若 Desktop 启动日志同时出现 `dockerInference` 与 `The file cannot be accessed by the system`，需排查遗留 IPC socket，相关现象见 [Docker 问题记录](https://github.com/docker/desktop-feedback/issues/460)。这是运行环境故障，恢复过程应保留数据库卷、配置密钥及原有容器运行集。

```powershell
corepack yarn web-admin:migrate
corepack yarn web-admin:build
corepack yarn web-admin:start
corepack yarn web-admin:deps:down
```

`build` 编译 Vue 和固定引擎适配并校验 Python；`start` 用 Python 服务已构建静态站点，不使用 Vite 开发服务器充当生产入口。`deps:down` 保留开发卷。

## Python 依赖清单

- `backend/requirements.txt`：完整运行依赖，包含全部间接依赖。
- `backend/requirements-dev.txt`：运行依赖和全部开发依赖，含测试、格式、类型检查等工具，可单独安装这一份。

两份文件由 `uv.lock` 自动导出，保留固定版本、平台条件及 SHA-256 校验哈希。`pyproject.toml` 和 `uv.lock` 仍是依赖来源，更新依赖后在仓库根目录执行以下命令重新生成，避免手动维护两套版本：

```powershell
corepack yarn web-admin:requirements
```

完成本机开发步骤中的 `web-admin:init` 或 `web-admin:prepare` 后，正常使用 `uv run python main.py` 会自动同步依赖。若希望显式按 requirements 安装，在后端目录执行：

```powershell
uv pip install --python .venv/Scripts/python.exe --require-hashes -r requirements-dev.txt
```

Linux/macOS 将解释器路径换为 `.venv/bin/python`。部署只安装运行依赖时，将文件名换为 `requirements.txt`；已有带 pip 的兼容 Python 虚拟环境也可执行 `python -m pip install --require-hashes -r requirements-dev.txt`。项目依赖统一安装到满足 `pyproject.toml` Python 范围的虚拟环境。uv 本身属于环境安装工具，版本由 `deployment/runtime.json` 管理，按上方首次安装步骤准备；不混入服务运行依赖。

## 独立 Docker 部署

```powershell
corepack yarn web-admin:up
corepack yarn web-admin:logs
corepack yarn web-admin:down
```

根 `compose.web-admin.yml` 使用 `starbridge-web-admin` project，前端 Nginx 与 Python 后端分别构建，PostgreSQL、Redis、Qdrant、对象存储、运行 Home、文件及配置均使用独立卷。只有前端端口公开；反代保留旧 API/WS 入口并交给同一 Python 兼容适配器。

部署配置保存在 `.superdsh-work/web-admin-production/config`。`up --build` 和 `down` 不删除卷、不重新生成密钥。新旧根 Compose 与命令彼此独立。生产域名通过 `WEB_ADMIN_PUBLIC_ORIGIN` 配置，外部 OAuth 回调身份及 HTTPS 环境需对应真实部署设置。

MinIO 使用集中元数据内固定的源码归档、SHA-256 和构建镜像，构建时保留许可证，不依赖已无法匿名拉取的历史公共镜像。独立初始化器创建私有桶并保留已有对象。文件服务支持受管本地存储和 S3，存储页显式配置连接和策略；上传、迁移与物理清理通过持久收据恢复，容器启动本身不代表已经启用某个策略。

本次主机的旧 BuildKit 出现“镜像已导出但 build 不退出”的上游问题（[关联问题](https://github.com/moby/buildkit/issues/6209)）。如环境相同，可选择独立 builder；以下配置不切换全局默认 builder，也不重启现有容器。构建工具镜像摘要仍读取统一元数据，后续 `up` 继承当前终端的 `BUILDX_BUILDER`。

```powershell
$webAdminRuntime = Get-Content apps/web-admin/deployment/runtime.json -Raw | ConvertFrom-Json
docker buildx create --name web-admin-build --driver docker-container --driver-opt "image=$($webAdminRuntime.builder.image)" --driver-opt default-load=true
$env:BUILDX_BUILDER = 'web-admin-build'
corepack yarn web-admin:up
```

已存在同名 builder 时直接设置环境变量并使用；不要重复创建或删除其缓存。独立 builder 的维护方式见 [Docker 官方说明](https://docs.docker.com/build/builders/drivers/docker-container/)。

## 自测与证据

```powershell
corepack yarn web-admin:check
corepack yarn web-admin:parity
```

`check` 核对旧包指纹、目录/语言/版本边界、若依分层、前后端类型和测试；创建本轮专属数据库与 Redis，执行真实 DSH、命令生命周期、Office 容器渲染和浏览器闭环，结束时删除本轮容器、账号、会话与 Home。清理前只归档经过脱敏的白名单报告到 `check-report-*`，清理或证据归档失败同样返回非零。测试源码及审查过的静态契约基线保留在 `tests`，不属于用户运行数据；不把受控模型称为外部模型验证。

浏览器检查默认使用 Playwright Chromium，首次执行 `node node_modules/playwright/cli.js install chromium`；Windows 已安装 Edge 时可设置 `WEB_ADMIN_BROWSER_CHANNEL=msedge`。`check` 包含真实 Python/PostgreSQL/Redis 的页面闭环，使用独立 headless context，不读取日常浏览器账号。

`parity` 实际运行比较器反例、旧新处理器和 Office 语义差分，以及两套独立 HTTP/WS 服务上的选定业务场景，同时输出入口映射、Schema 投影与覆盖索引。套件失败、跳过、缺少本轮证据或清理失败返回非零；退出零只表示列出的自动范围通过，报告中的 `fullParity` 不因此变为 true。`web-admin:parity --report-only` 仅生成结构报告，不启动服务，也不代替行为验证。

报告位于 `.superdsh-work/web-admin-validation/parity-*`，保留脱敏请求和观察值，不保留测试库或有效凭据。Docker 生命周期使用 `tests/tooling/deployment.ts` 对显式指定的新镜像另行验证，结果保存在 `deployment-*/results.json`。原生 Office、Android 真机等环境验收单独记入计划三。旧源码基线包含采集时已有的未提交修改；用户后续调整旧包时需显式复核基准，不自动覆盖或回滚。

## 参考与归属

后端目录借鉴 [RuoYi-FastAPI](https://github.com/insistence/RuoYi-FastAPI) 的 controller、service、dao 和 entity 组织方式，保持 SuperDsh 自有 API、资源归属和授权语义。现有视觉 tokens、模块标识与协议来源记录在 `tests/fixtures/baselines`；固定 Harness 与 AA 的版本、来源及许可证沿用仓库 vendor 清单，不升级固定上游。Office 是可配置工具包与技能实例，不是平台专用业务分支；LangGraph 为可选阶段适配，DSH 是唯一 Agent 执行引擎。

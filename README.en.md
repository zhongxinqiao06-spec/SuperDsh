# SuperDsh

SuperDsh includes a desktop Agent app, a Vue 3 management console with a FastAPI backend, and an Android app. The Agent Workbench uses DeepSeek Harness.

Run `docker compose up -d` at the repository root to start the Vue console, FastAPI and Ollama. Open `http://SERVER_IP:5174`. The initial account is `admin` / `admin123`. Set `WEB_ADMIN_PUBLIC_ORIGIN` for your deployment URL and change the password after signing in. [Deployment guide](apps/web-admin/README.md#独立-docker-部署)

**Use this page for daily development.** [中文](README.md) · [Origins](#upstream-foundations) · [Principles](#design-principles) · [Progress](#current-progress) · [Code](#project-structure) · [Startup](#daily-development) · [Integration](#three-client-integration) · [Checks](#checks-and-packaging)

## Upstream foundations

| Upstream                                                                            | Reused foundation                                                     | SuperDsh changes                                                                                                                |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [Anywhere Labs / dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)         | Desktop / Next Electron shell, native capabilities and interaction    | One desktop product based on Next, consolidated UI / Core, product-owned root, navigation and engine lifecycle                  |
| [DeepSeek / deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)      | Full Host, Agent, tools, workflows, persistence and client components | Owned UI source; `@superdsh/harness` wraps the engine and shares Host startup across desktop and server                         |
| [Anywhere Labs / Agents-Anywhere](https://github.com/anywhere-labs/Agents-Anywhere) | Connector, Bridge, API v2, web UI and mobile clients                  | Imported admin and Android; migrated server APIs, identity, persistence and Connector to Node, extending RBAC and server Agents |

Harness is pinned to `0.1.7-alpha.2` in [upstream.json](upstream.json); AA applications were imported from `f9129757c3ee`, recorded in the [provenance manifest](vendor/agents-anywhere/apps-source.json). Pinned submodules remain unchanged; product adapters and controlled patches provide compatibility changes.

## Design principles

- **Desktop first, product-owned control.** SuperDsh manages windows, navigation, identity and state; Harness owns execution and its queue. There is no second engine.
- **Locate code by responsibility.** Desktop views live in UI, business/native capabilities in Core, and Harness integration in the plugin. Web and Node server live together in `apps/admin`.
- **Separate management from the workbench.** The top-level Agent management menu contains four submenus: Agents, Knowledge bases, Skills and Tools. Configure resources separately, associate them with an Agent, and publish to the same main chat with knowledge, skill and tool versions fixed at conversation creation.
- **One conversation, two execution targets.** All clients use API v2 to access their computers or server Agent. Android does not embed Harness, and server execution does not require a computer online.
- **Separate platform identity and model authorization.** Platform accounts control resources and remote access; DeepSeek / personal keys provide model access. Desktop keeps its local Home, and platform login does not restart the application.
- **Ownership first.** Administrator and member are the built-in roles; custom roles remain supported. Administrators cannot read other users' content. Native Agents have separate directories and authorization, but processes under one OS user are not an OS sandbox.

This release targets **single-company trials, not a complete enterprise multitenant system**. Published Agents and their bound resources are shared within this platform; personal conversations and artifacts remain owner-authorized. Company tenants, employee invitations, tenant-specific knowledge libraries, arbitrary script executions and DingTalk/WeCom integration are not implemented. Shared devices, multiple engines, another queue and a DAG editor remain out of scope.

## Current progress

**2026-11-07 skill foundation update:** skill management now supports automatic matching rules, stage drafts and publication, independent run records and validation against real tool results. Configurable PPT/Word flows reuse DSH execution. Existing Agents and conversations are preserved; opt in by selecting a flow skill and rebinding. A real Agent Plan model generated a six-slide PPT and a five-page Word document in an isolated environment. Web and desktop verified records, previews, downloads and matching hashes in one conversation; Microsoft Office opened both files for page-by-page inspection. Existing data and DeepSeek configuration were unchanged. See [skill development](docs/agent-extension-development.md#自动匹配阶段与运行记录) and the [validation scope](docs/office-assistants-validation.md#2026-11-07通用分阶段技能与真实双端验收).

**2026-11-03 foundation update:** separate chat/multimodal configurations, Ark adapters, frozen capability bindings, unified files and source-pinned MinIO are implemented. Admin production build, Android compatibility checks and Debug APK build passed. DeepSeek returned a real HTTP 200 response. The Ark 401 came from using an Agent Plan key on the pay-as-you-go endpoint; chat on the Plan endpoint returned a real HTTP 200. Image/edit/vision and the full three-device workflow remain unverified. Existing deployments have not been updated. The source-pinned MinIO image and isolated file tests passed; the full platform Linux build remains incomplete after a stalled base-image download. See the [current validation record](docs/office-assistants-validation.md#2026-11-03-模型与文件底座验证).

**2026-10-31 development update:** Configurable extension/MCP tools, skill-package imports, Word, structured PPT layouts and reliable JSON artwork are implemented. DeepSeek tool calls submit JSON; the renderer creates a conversation asset reused by PPT/Word, without requiring another image model. Real Host regression covers confirmation, rendering, embedding, preview and download; 40 deterministic PPT/Word tasks pass. Real DeepSeek, Android device interaction and this revision’s Linux image remain unverified; this does not replace the historical results below.

**2026-10-19: the three general office assistants and their deterministic execution paths are implemented, with input checks, plan confirmation, artifact versions and hybrid knowledge retrieval.** The 34 Excel, 23 PPT and 20 real ONNX/Qdrant retrieval scenarios passed, alongside browser and real Host/Connector regression. The Linux image build, offline embedding/Chinese PPT rendering, 42 container checks and deployment startup/login also passed. Commercial chat models, Office clients and customer production environments remain unverified; see the [complete record and limitations](docs/office-assistants-validation.md). The old Python backend at `apps/server` has been physically deleted and replaced by `apps/admin/server`.

| Area                       | Status and boundaries                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop                    | UI / Core / Harness separated; inline login, fixed Home and main-chat device selection have [stage records](docs/desktop-inline-login-validation.md)                                                                       |
| Management platform        | Independent overview, permission-filtered menus, dialogs and pagination; management pages do not need chat initialization                                                                                                  |
| Node API and data          | Identity, RBAC, menus, devices, conversations, files, terminals, models and persistence moved to `apps/admin/server`; API v2 retained; empty databases and `v2_35` through `v2_46` upgrades supported                      |
| Office Agents              | Excel multi-table processing and controlled calculation, structured PPT plans, source evidence, artifact revisions and publication checks are integrated; real-model and Office-client results require separate acceptance |
| Identity/management checks | Temporary PostgreSQL tests cover rotation, ownership, last administrator, concurrent menus and migration rollback; existing user databases were not used                                                                   |
| Server Agent               | Native Node Connector + full Harness processes, per-user Home and runtime leases; native and Compose deployments retain managed children without separate per-user Agent containers                                        |
| Models and clients         | Three protocols, personal/platform models and defaults implemented; paid providers, current Android UI and complete cross-client interactions require environment-specific revalidation                                    |
| Release                    | Source and temporary-environment checks are not Windows installer, CentOS, macOS/Linux, signing or updater acceptance                                                                                                      |

**Historical validation on 2026-10-15:** headless Next with real API/Host, headless desktop with real Host and a controlled platform API, admin build, Node checks and layout checks passed. Sales examples using a **local model fixture** produced 260 / 777, retained conversation version v2 after restart and returned source excerpts. Temporary resources were removed. This evidence does not cover the current general-office scope, paid providers, real desktop GUI or the new Android entry.

**Model-center follow-up:** unified connections, chat/multimodal configuration and capability authorization are implemented. Desktop shortcuts and 9router / Codex authorization remain future work and are not installed by current startup. See the [historical validation index](docs/README.en.md#validation-records).

## Project structure

| Change                                                        | Location                                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Desktop root, navigation, chat, settings and theme            | [apps/desktop/ui](apps/desktop/ui/): `src/app`, `features`, `components`, `theme`                                                   |
| Desktop business logic, windows, IPC, permissions and updates | [apps/desktop/core](apps/desktop/core/): `src/main`, `preload`, `client`, `services`, `contracts`                                   |
| Harness startup, profiles and protocol adapters               | [apps/desktop/plugins/harness](apps/desktop/plugins/harness/): `src/host`, `host-runtime.ts`, `server-profile.ts`                   |
| Web management, overview and workbench                        | [apps/admin/src](apps/admin/src/): `components/console`, `features/console`, `features/workbench`                                   |
| API, identity, RBAC, devices and database                     | [apps/admin/server](apps/admin/server/): `identity`, `management`, `devices`, `conversations`, `files`, `infrastructure`            |
| Platform/personal models and server Agents                    | Server `models` and `runtime`: Node Connector, model gateway and full Host lifecycle                                                |
| Business Agents, knowledge and Office artifacts               | `apps/admin/server/agents`; web `src/features/agents`, `components/management/agents-panel.tsx`; desktop `ui/src/features/platform` |
| PG / Redis / Qdrant / MinIO and deployment                    | [apps/admin/deployment](apps/admin/deployment/); root Compose deploys the complete platform                                         |
| Android UI, network and Chinese localization                  | [apps/android](apps/android/): `app/src/main/java/com/agentsanywhere/app`; strings in `app/src/main/res/values-zh-rCN`              |

`apps/desktop` assembles and publishes the desktop product. Web modules register in `src/features/console/modules.ts`; the server catalog is `server/management/navigation.ts`. Management modules do not depend on chat's `WorkspaceProvider`. Pinned upstreams remain in `deepseek-harness` and `agents-anywhere`; iOS remains upstream reference only.

## Environment preparation

The following requirements apply to source development. Server-only deployment uses [Docker Compose](apps/admin/deployment/README.md), without host Node, Yarn or submodule initialization. Run development commands from the **repository root**. Windows examples use `corepack.cmd`; use `corepack` on macOS/Linux.

| Area                 | Requirements                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Desktop and platform | Git, Node 24.x, Corepack, Yarn 4.18                                                                                       |
| Local database       | Docker Linux engine for development PG / Redis / Qdrant / MinIO; existing database endpoints can be configured explicitly |
| Android              | JDK 17, Android SDK 36, Build Tools 34.0.0; emulator also needs Emulator, Platform Tools and an AVD                       |

```powershell
git submodule update --init --recursive
node scripts/prepare-aa-source.mjs
corepack.cmd yarn install --immutable
```

Source preparation applies AA sparse checkout and excludes retired application directories; do not restore those paths. The Node platform and server Agent do not require Python. The existing desktop Connector or specific Agent tools may still use Python when needed.

## Daily development

### Desktop

```powershell
corepack.cmd yarn dev
```

Builds first, then starts Electron and the UI watcher. **UI rebuilds restart the backend and interrupt running tasks.** Restart development after changing Core, Preload or Harness. Use `start` for existing artifacts and `build` after source changes. This differs from inline platform account login.

### Web, Node API and server Agent

Prepare dependencies and Harness once, then start the whole platform with one command:

```powershell
corepack.cmd yarn server:sync
corepack.cmd yarn server:deps:up
corepack.cmd yarn server:knowledge:prepare
corepack.cmd yarn server:dev
```

`server:deps:up` **starts only PostgreSQL / Redis / Qdrant / MinIO containers**. `server:dev` runs Next.js, Node API and Agent lifecycle management on the host. Full Harness children start when a user needs a server Agent; no Supervisor, Python API or extra Agent command is required. `admin:dev` is an alias for the same entry; do not run both.

`server:knowledge:prepare` downloads and verifies the pinned `bge-small-zh-v1.5` ONNX model in advance, reusing valid files. Chat-only use can skip this preparation. Models live under the Agent data directory's `models` folder; `SUPERDSH_EMBEDDING_MODEL_DIR` overrides it. Native development can use this command as needed. The root Compose stack downloads and verifies the Chinese embedding model when building the Ollama image, then installs it in the `ollama-data` volume at startup.

| Service                                               | Default address                                           |
| ----------------------------------------------------- | --------------------------------------------------------- |
| Web and API                                           | [http://127.0.0.1:5174](http://127.0.0.1:5174)            |
| Compatibility API listener, same backend and database | `http://127.0.0.1:8000`                                   |
| Readiness                                             | `http://127.0.0.1:5174/api/v2/health/ready`               |
| PostgreSQL / Redis / Qdrant, loopback only            | `127.0.0.1:15432` / `127.0.0.1:16379` / `127.0.0.1:16333` |

The empty managed `superdsh-dev` database and fresh default Compose deployments get **`admin` / `admin123`**. Compose accepts an optional initial password override and saves the initial credentials in its configuration volume. Older Compose initial credentials are upgraded once at startup; passwords changed by users and account state are retained. Change the default password after signing in. Explicit databases and empty production databases in native mode use the startup **setup token** to initialize an administrator. Web login opens the overview and prepares an Agent only on entering the workbench; native clients retain preparation after login.

Development configuration is Git-ignored at `.superdsh-work/server-dev/aa-dev.env`. Repeated `server:deps:up` skips healthy dependencies. If another program occupies a default port, the script selects and persists a free port; explicitly specified ports are not changed. Qdrant defaults to `http://127.0.0.1:16333`; override `SUPERDSH_DEV_QDRANT_PORT`, or connect an existing instance with `SUPERDSH_QDRANT_URL` / `SUPERDSH_QDRANT_API_KEY`. Follow command output. If volumes exist but configuration is lost, restore the original file instead of generating replacement keys.

Use `Ctrl+C` to stop web, API and their native Agents, then `corepack.cmd yarn server:deps:down` to stop only PG / Redis / Qdrant / MinIO while retaining volumes. `server:dev:agents` is only a compatibility alias. `server:down` explains terminal/system-service shutdown rather than operating application containers.

Existing databases require both `AGENT_SERVER_DB_URL` and `AGENT_SERVER_REDIS_URL`, plus original authentication/model keys; no development account is created. `SUPERDSH_SERVER_PORT` controls the web port and `AGENT_SERVER_PORT` the compatibility API. The unified entry needs no `AGENTS_ANYWHERE_API` proxy configuration; clear obsolete `NEXT_OUTPUT=export`. See the [server guide](apps/admin/server/README.md).

### New Vue and Python admin

The new implementation lives in `apps/web-admin/fronted` and `apps/web-admin/backend` and runs independently of the existing admin. Its Python backend follows RuoYi-style `controller → service → dao` layering while keeping the fixed DSH engine. See [Web Admin development](apps/web-admin/README.md) for startup, separate Docker deployment, initialization and test cleanup, and [phase one](docs/plans/web-admin-01-foundation.md) for implementation status.

```powershell
corepack.cmd yarn web-admin:sync
corepack.cmd yarn web-admin:deps:up
corepack.cmd yarn web-admin:dev
```

Run `web-admin:deps:up` to start PostgreSQL, Redis, Qdrant, MinIO and Ollama in one Docker project and verify the bundled model. Run `web-admin:dev` to debug Vue and FastAPI on the host.

### Android

Open `apps/android` in Android Studio. With SDK / AVD prepared:

```powershell
corepack.cmd yarn android:build
corepack.cmd yarn android:start --server http://127.0.0.1:8000
```

The launcher installs an existing Debug APK and opens the app; it does not build or start services. `--server` only checks health and configures emulator forwarding; **it does not change the app's saved address**. Enter the same address on login. Keep the original signing key to preserve account and language settings. See the [Android guide](docs/android-local-development.md).

## Three-client integration

```text
Desktop local: Core → backend child → Harness → local conversations
Computer execution: web / Android / desktop → Node API v2 → computer Connector → Harness
Server execution: clients → same Node API v2 → Node Connector → native Harness child
```

**Computer mode:** start the platform and desktop, then enter platform address and credentials in the desktop account menu. It connects the computer and synchronizes conversations automatically. Android/web use the same account and select that computer. Phone login sessions are not execution devices and need no extra QR scan. Remote files and terminals always target the selected computer.

**Server mode:** `server:dev` includes the runtime. The web workbench prepares and reuses an instance, exposing diagnostics and retry on failure. Personal center → Personal models → Add provider prefills DeepSeek; configure a key and default before sending. Existing conversations keep their selected model and require explicit replacement when invalid. An online Agent or successful provider check does not prove a generated reply.

Desktop can use local DeepSeek / API keys independently. Platform login/logout/switch does not restart Harness; switching during execution requires confirmation. Server tasks do not depend on a phone token; closing the phone or leaving the workbench does not end tasks. Stopping the platform reaps its Agents.

| Client                            | Platform address and network                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Local desktop / web               | `http://127.0.0.1:5174`; existing clients on `8000` reach the same backend                          |
| Android emulator                  | `http://127.0.0.1:8000` with `adb reverse tcp:8000 tcp:8000`; map `5174` instead if using that port |
| Physical phone / another computer | Reachable LAN or HTTPS platform address; another computer's `127.0.0.1` is not reachable            |

Web module switches retain account-scoped in-memory drafts, pending files and send results while releasing workbench subscriptions; reload/account switch clears temporary state. Android can view cached history and save drafts offline, with manual sending after reconnect.

Update the checkout with `git pull --ff-only`, then run `docker compose up -d --build`. Keep the production volumes and the server’s plain JSON model configuration. Existing Next.js deployments use `docker compose -f compose.legacy.yml`. [Vue deployment guide](apps/web-admin/README.md#独立-docker-部署)

## Agent demo and development entry

1. Start the platform as above. Configure a working key and default in Personal center → Personal models, or use the administrator's platform default. The model must support tool calls; initializing demo content neither supplies model credits nor configures a key.
2. An account with `agents.manage` gets four editable Excel, PPT, knowledge and Word assistants and sanitized resources on its first resource-management visit. Pristine old examples upgrade in place by version; edited and deleted records keep their state. Copy latest examples creates four separate unpublished drafts without replacing existing records. Example data is used only when explicitly selected by the user.
3. Configure Knowledge bases, Skills and Tools in their separate Agent management submenus. In Agents, associate resources, purpose, suggested prompts, input requirements and output examples. Configuration check lists missing resources and warnings. Try opens the main workbench with a draft, without sending or replacing existing drafts. See [supported constraints](apps/admin/server/README.md#智能体资料与-office-模板).
4. In web, desktop or Android main chat, select a server target and assistant, then upload or explicitly select your own resources. Excel/PPT/Word and JSON artwork first present sources, calculation rules, fields or slide arrangements in the shared confirmation card; revised plans require confirmation again. Knowledge questions return evidence directly. Preview, download or request changes in chat; revisions retain the original file, and existing conversations keep frozen configuration.

| Sanitized example           | Example request                                                                         | Sources and output                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Excel office assistant      | Summarize my uploaded expenses by department, retaining details and calculation rules   | Multiple files/sheets, cleaning and joins, exact calculations, controlled formulas and editable charts |
| PPT presentation assistant  | First propose a client presentation outline using my uploaded company documents         | Confirm audience, slide count, outline and template regions; editable PPT and page previews            |
| Company knowledge assistant | Explain reimbursement rules from our policies, cite the text and state missing evidence | Hybrid retrieval with document titles, paragraphs, PDF pages or table rows                             |
| Word document assistant     | Create a formal proposal from my approved company documents                             | A4 chapters, contents, editable tables, images, citations and revision history                         |

All three clients have Agent selection, plans, artifacts and downloads. Android adds preview and system sharing; device acceptance is recorded separately. Product Agents execute on the server. Inputs are limited to 4 MiB each and must be authorized resources, attachments or prior artifacts for the current conversation; arbitrary paths are rejected. Excel calculations are programmatic, without inventing costs or combining currencies. Supported template scope and incompatible objects must be checked before execution; arbitrary Office files are not guaranteed lossless editing.

Knowledge accepts text, Markdown, DOCX, CSV, XLSX and text PDFs; scanned-document OCR is unsupported. PostgreSQL stores source text and locations; Qdrant combines dense vectors and keywords through RRF. The default pinned embedding model runs locally, with a separately configurable external compatible API. External destinations require a deployment-side trust list, and configuration requires both model and Agent management permissions; see the [deployment guide](apps/admin/deployment/README.md). There is no automatic provider fallback. Knowledge pages show document indexing status and retry. Missing models or unavailable Qdrant produce explicit errors. Skills import SKILL.md, references and templates. Executable scripts must be separately installed and authorized as tools; prompts cannot bypass that boundary.

## Model and file foundation

- **Model management → Chat models / Multimodal models:** configure a provider connection once, then its model ID, capability, parameters and default. Ark and speech use separate credentials; speech/video/embedding contracts are unavailable in this new service. Existing knowledge Embedding remains independent.
- Authorize `image_generate` or `vision_analyze` in Tool management and bind it to an assistant. Keys stay encrypted on the server. A session freezes the configuration version; changing defaults affects new bindings. JSON `illustration_render` remains available without a paid image model. Accepted results can be transferred again without repeating a generation request.
- **Personal center → My files** supports uploads, versions, authenticated downloads and recycle bin. **System → File storage** manages connections and policy; storage administration does not grant access to other accounts' content. File policy defaults to 32 MiB, staged uploads to 24 hours and recycle bin to 30 days; Office parsers have independent limits.
- Development MinIO API / console: `http://127.0.0.1:19000` / `http://127.0.0.1:19001`. New environments use private buckets; existing environments retain their backend. See [storage upgrade and recovery](apps/admin/deployment/README.md#minio-与文件存储升级) before switching.
- `server:files` checks legacy attachments and knowledge originals; `--apply` imports references without removing sources. Stop the platform first. `server:models:init` checks a private initialization JSON; `--apply` adds missing connections without overwriting credentials or defaults. Keep the file in ignored `.superdsh-work/server-dev/model-initialization.json`, never in source or images.

## Checks and packaging

Append these commands to `corepack.cmd yarn` at the repository root:

| Scope                         | Commands                                               | Purpose                                                                |
| ----------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Desktop                       | `build` / `start` / `workspace @superdsh/ui build`     | Full build / run artifacts / UI only                                   |
| Quality                       | `typecheck` / `lint` / `format:check` / `test`         | Desktop types, shared conventions and tests                            |
| Desktop integration           | `check` / `check:ui`                                   | Engineering and Host / headless UI                                     |
| Web                           | `admin:check` / `admin:build`                          | Web types, tests, protocol / web build                                 |
| Node server                   | `server:check` / `server:test`                         | Types, tests, lint / tests                                             |
| Database and Host integration | `server:test:integration`                              | Temporary PG / Redis / Qdrant, API and native runtime; Docker required |
| Platform release              | `server:build` / `server:start`                        | Harness + Next build / native production start                         |
| Android                       | `android:check` / `android:test` / `android:build`     | Static constraints / JVM / Debug APK                                   |
| Desktop release               | `package:dir` / `dist:win` / `dist:mac` / `dist:linux` | Unpacked app / platform artifacts                                      |
| Layout                        | `sources:check` / `check:layout`                       | Pinned sources and ownership boundaries                                |

Root `dev/build/start/check` still targets desktop and does not replace other application checks. Database tests explicitly skip without a temporary database; skips are not integration passes. Headless UI checks need Chromium installed and existing builds. Desktop packages are in `apps/desktop/dist`; Android APK is `apps/android/app/build/outputs/apk/debug/app-debug.apk`.

## Conventions and data

- UI imports only Core's public `client/*` and `contracts/*`; web components must not import server credentials, database or process implementations. Legacy third-party UI uses a separate compatibility container.
- Two spaces, single quotes, no ordinary semicolons; PascalCase components and kebab-case modules, with Prettier authoritative. Owned work uses root Yarn. Do not edit generated types or pinned upstreams.
- Desktop development Home defaults to `.superdsh/home`; installed Home is system application data `SuperDsh/home`. Account switching keeps Home while separating platform credentials, bindings and checkpoints by stable account.
- Development Agent data is `.superdsh-work/server-dev/native`; Compose uses `/data/runtime` in its `platform-data` volume, while native production defaults to `.superdsh-work/server-native`, configurable with `SUPERDSH_SERVER_DATA_DIR`. Files retain `AGENT_SERVER_FILES_LOCAL_ROOT`. Old container Homes are not merged automatically.
- Migrations preserve IDs, passwords, ownership and ciphertext. Product versions `v2_35` through `v2_46` are supported; `v2_40–42` add resources, definitions, conversation bindings, artifacts and four management menus. `v2_43` adds office plans, conversation evidence and source locations; `v2_44` adds extension/resource versions, protected credentials and conversation binding history; `v2_46` adds skill runs and stage events. Older databases must first upgrade using their original release, never by changing the version stamp.
- Imports require empty targets and preserved sources/backups. Authorization, keys, environment variables, `.credentials.yaml` and device bindings are not copied. Back up database volumes together with authentication/encryption keys.
- Native Agents share host OS permissions without container sandboxing. Model keys are not sent to clients, and operational admin rights do not bypass ownership. See [AGENTS.md](AGENTS.md).

## Troubleshooting and validation

| Symptom                           | Check                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing Docker pipe               | Compose deployment, development databases and temporary integration tests need Docker; confirm the Linux engine with `docker info`                                   |
| Web unreachable / port collision  | Run one `server:dev`; `5174` is web/API, `8000` compatibility API; do not wait for the old `15174` container                                                         |
| Login failure                     | Confirm database and environment; development defaults do not replace passwords; Compose stores the initial password, while native empty databases use a setup token |
| Agent preparation fails           | Build Harness with `server:sync`, inspect diagnostics and directory permissions; do not start the retired Python/Supervisor                                          |
| Online but no reply               | Check personal/platform models, conversation selection and execution errors; bundled model names do not imply authorization                                          |
| Non-public provider address       | Check the exact origin in [server configuration](apps/admin/server/README.md#模型与网络); avoid broad allowlists                                                     |
| Tool failures under Chinese paths | Use Node-based workspace entry points instead of encoding-sensitive batch wrappers                                                                                   |
| Android still uses an old address | Check the saved address, signing and corresponding `adb reverse`; launcher flags do not overwrite the address                                                        |

Source checks, temporary databases, fixture models, real Host, headless UI and physical phones are recorded separately. Historical reports keep their original paths and outcomes. Current signing, clean-system and real multi-client regressions need separate acceptance.

## Topics and licenses

- [Desktop component index](apps/desktop/ui/README.md): chat, settings and device components.
- [Server deployment and configuration](apps/admin/server/README.md): Node modules, migrations, models and deployment entry.
- [Android environment and emulator](docs/android-local-development.md): SDK, AVD, Gradle and device access.

Retain the [MIT license](LICENSE) and upstream/third-party licenses and attribution. SuperDsh is an independent community project with no official DeepSeek affiliation or endorsement.

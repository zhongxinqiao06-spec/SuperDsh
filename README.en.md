# SuperDsh

SuperDsh includes a desktop Agent application, a full-stack Next.js + Node.js management platform, and an Android application. The platform centers on overview, access, models, devices and system management; chat is its Agent Workbench module. DeepSeek Harness is a required engine plugin managed by the product.

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

This is a **single-platform demo, not a complete enterprise multitenant system**. Published Agents and their bound resources are shared within this platform; personal conversations and artifacts remain owner-authorized. Company tenants, employee invitations, tenant-specific knowledge libraries, arbitrary skill uploads and DingTalk/WeCom integration are not implemented. Shared devices, multiple engines, another queue and a DAG editor remain out of scope.

## Current progress

**As of 2026-10-15: Agent management, actual resource uploads, main chat and Office artifacts have passed temporary-environment validation.** The old Python backend at `apps/server` has been physically deleted and replaced by `apps/admin/server`; releases still require target-system checks.

| Area                       | Status and boundaries                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop                    | UI / Core / Harness separated; inline login, fixed Home and main-chat device selection have [stage records](docs/desktop-inline-login-validation.md)                                                  |
| Management platform        | Independent overview, permission-filtered menus, dialogs and pagination; management pages do not need chat initialization                                                                             |
| Node API and data          | Identity, RBAC, menus, devices, conversations, files, terminals, models and persistence moved to `apps/admin/server`; API v2 retained; empty databases and `v2_35` through `v2_42` upgrades supported |
| Business Agents            | Real Node API, PG/Redis, Connector and full Host with a local tool-calling model fixture verified uploads, generation, downloads, knowledge citations and version retention after restart             |
| Identity/management checks | Temporary PostgreSQL tests cover rotation, ownership, last administrator, concurrent menus and migration rollback; existing user databases were not used                                              |
| Server Agent               | Native Node Connector + full Harness processes, per-user Home and runtime leases; neither development nor production uses Agent containers                                                            |
| Models and clients         | Three protocols, personal/platform models and defaults implemented; paid providers, current Android UI and complete cross-client interactions require environment-specific revalidation               |
| Release                    | Source and temporary-environment checks are not Windows installer, CentOS, macOS/Linux, signing or updater acceptance                                                                                 |

Separate checks passed: a headless Next browser with real API/Host for management actions and main chat; headless desktop with real Host and a platform API fixture for selection, frozen versions and downloads; admin production build, Node server checks and layout checks. Runtime tests used a **local model fixture**: an uploaded CSV produced Excel/PPT revenue of 260; after restart, the existing conversation retained v2 and a new chat attachment produced 777 rather than the bound sales data. Knowledge answers included source excerpts. Temporary resources were cleaned up; paid models, real desktop GUI and the new Android entry were not verified.

**Model-center roadmap, not implemented:** unify provider connections, model catalogs and access grants, with desktop shortcuts. 9router / Codex authorization remains future work and is not installed by current startup. See the [historical validation index](docs/README.en.md#validation-records).

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
| PG / Redis / Qdrant and deployment                            | [apps/admin/deployment](apps/admin/deployment/); only database dependencies use Docker                                              |
| Android UI, network and Chinese localization                  | [apps/android](apps/android/): `app/src/main/java/com/agentsanywhere/app`; strings in `app/src/main/res/values-zh-rCN`              |

`apps/desktop` assembles and publishes the desktop product. Web modules register in `src/features/console/modules.ts`; the server catalog is `server/management/navigation.ts`. Management modules do not depend on chat's `WorkspaceProvider`. Pinned upstreams remain in `deepseek-harness` and `agents-anywhere`; iOS remains upstream reference only.

## Environment preparation

Run all commands from the **repository root**. Windows examples use `corepack.cmd`; use `corepack` on macOS/Linux.

| Area                 | Requirements                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| Desktop and platform | Git, Node 24.x, Corepack, Yarn 4.18                                                                         |
| Local database       | Docker Linux engine, only for PG / Redis / Qdrant; existing database endpoints can be configured explicitly |
| Android              | JDK 17, Android SDK 36, Build Tools 34.0.0; emulator also needs Emulator, Platform Tools and an AVD         |

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
corepack.cmd yarn server:dev
```

`server:deps:up` **starts only PostgreSQL / Redis / Qdrant containers**. `server:dev` runs Next.js, Node API and Agent lifecycle management on the host. Full Harness children start when a user needs a server Agent; no Supervisor, Python API or extra Agent command is required. `admin:dev` is an alias for the same entry; do not run both.

| Service                                               | Default address                                           |
| ----------------------------------------------------- | --------------------------------------------------------- |
| Web and API                                           | [http://127.0.0.1:5174](http://127.0.0.1:5174)            |
| Compatibility API listener, same backend and database | `http://127.0.0.1:8000`                                   |
| Readiness                                             | `http://127.0.0.1:5174/api/v2/health/ready`               |
| PostgreSQL / Redis / Qdrant, loopback only            | `127.0.0.1:15432` / `127.0.0.1:16379` / `127.0.0.1:16333` |

The empty managed `superdsh-dev` database gets **`admin` / `admin123`**; existing passwords and account state are unchanged. Explicit databases and empty production databases use the startup **setup token** to initialize an administrator; they have no default account. Web login opens the overview and prepares an Agent only on entering the workbench; native clients retain preparation after login.

Development configuration is Git-ignored at `.superdsh-work/server-dev/aa-dev.env`. Repeated `server:deps:up` skips healthy dependencies. If another program occupies a default port, the script selects and persists a free port; explicitly specified ports are not changed. Qdrant defaults to `http://127.0.0.1:16333`; override `SUPERDSH_DEV_QDRANT_PORT`, or connect an existing instance with `SUPERDSH_QDRANT_URL` / `SUPERDSH_QDRANT_API_KEY`. Follow command output. If volumes exist but configuration is lost, restore the original file instead of generating replacement keys.

Use `Ctrl+C` to stop web, API and their native Agents, then `corepack.cmd yarn server:deps:down` to stop only PG / Redis / Qdrant while retaining volumes. `server:dev:agents` is only a compatibility alias. `server:down` explains terminal/system-service shutdown rather than operating application containers.

Existing databases require both `AGENT_SERVER_DB_URL` and `AGENT_SERVER_REDIS_URL`, plus original authentication/model keys; no development account is created. `SUPERDSH_SERVER_PORT` controls the web port and `AGENT_SERVER_PORT` the compatibility API. The unified entry needs no `AGENTS_ANYWHERE_API` proxy configuration; clear obsolete `NEXT_OUTPUT=export`. See the [server guide](apps/admin/server/README.md).

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

For production, obtain source with Git, build, set `SUPERDSH_SERVER_ENV` to the native service configuration, and run `server:start`. Web/API still defaults to `5174`. `server:up` aliases this command; the old `15174` container no longer starts automatically. See [server deployment](apps/admin/deployment/README.md#服务器首次部署).

## Agent demo and development entry

1. Start the platform as above. Configure a working key and default in Personal center → Personal models, or use the administrator's platform default. The model must support tool calls; initializing demo content neither supplies model credits nor configures a key.
2. An account with `agents.manage` automatically gets persisted “Xinghe Trading” examples on its first resource-management visit: three Agents, three knowledge bases, three skills and three tools. Later visits reuse records without overwriting edits or recreating intentionally deleted examples.
3. Expand Agent management, then open Knowledge bases (`#/knowledge`) to upload documents and templates, Skills (`#/skills`) to edit instructions and required tools, and Tools (`#/tools`) to configure enabled status and execution parameters. In Agents (`#/agents`), associate the resources and publish. Each submenu has its own searchable, paginated list and configuration dialogs. Download and adapt demo templates first; see [supported constraints](apps/admin/server/README.md#智能体资料与-office-模板).
4. In a new web Agent Workbench conversation, choose Server Agent and a published Agent. On desktop, sign into the same platform and choose that server target and Agent in the **existing main chat**. Download real `.xlsx` / `.pptx` files from Generated artifacts in chat; the same account can continue the conversation in either client. Existing conversations retain their bound version; create a new conversation to use updated configuration.

| Sanitized example              | Example request                                                                         | Sources and output                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Business analysis assistant    | Generate an Excel sales report comparing regional revenue and gross profit              | Bound sales data and Excel template; programmatic totals and formulas in an editable workbook |
| Company presentation assistant | Use the company introduction and sales data to produce a presentation with our template | Bound knowledge, sales data and controlled PPT template; editable presentation                |
| Company knowledge assistant    | What services and after-sales policies does the company provide? Cite sources           | Bound resources with file/paragraph references; missing evidence is not invented              |

This iteration adds selection and artifacts to web and desktop; an Android-specific Agent selector is not yet integrated. Product Agents run only on the server; local and other-computer capabilities remain unchanged. Chat sales attachments accept CSV/XLSX up to 4 MiB, selected by an already-consumed filename; conflicting names require hash disambiguation. Attachment errors never fall back to demo data. Tools calculate sales figures; model-written numbers alone are not accounting results.

PostgreSQL stores source documents; Qdrant stores a rebuildable chunk index using sparse English-word and Chinese-bigram retrieval, without a separate embedding key. Dense semantic-vector retrieval is not implemented. The knowledge page exposes index status and rebuild. An unavailable Qdrant does not block management pages; actual knowledge retrieval reports an explicit error. Skills contain editable instructions and tools use registered implementations; uploaded arbitrary scripts are not executed as trusted tools.

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
- Development Agent data is `.superdsh-work/server-dev/native`; production defaults to `.superdsh-work/server-native`, configurable with `SUPERDSH_SERVER_DATA_DIR`. Files retain `AGENT_SERVER_FILES_LOCAL_ROOT`. Old container Homes are not merged automatically.
- Migrations preserve IDs, passwords, ownership and ciphertext. Product versions `v2_35` through `v2_42` are supported; `v2_40` adds Agent resources, definitions, conversation bindings and artifact records; `v2_41` adds independent knowledge-base, skill and tool configuration; `v2_42` groups the existing related menus under Agent management. Older databases must first upgrade using their original release, never by changing the version stamp.
- Imports require empty targets and preserved sources/backups. Authorization, keys, environment variables, `.credentials.yaml` and device bindings are not copied. Back up database volumes together with authentication/encryption keys.
- Native Agents share host OS permissions without container sandboxing. Model keys are not sent to clients, and operational admin rights do not bypass ownership. See [AGENTS.md](AGENTS.md).

## Troubleshooting and validation

| Symptom                           | Check                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Missing Docker pipe               | Only database dependencies and temporary integration tests need Docker; confirm the Linux engine with `docker info`                      |
| Web unreachable / port collision  | Run one `server:dev`; `5174` is web/API, `8000` compatibility API; do not wait for the old `15174` container                             |
| Login failure                     | Confirm database and environment; development defaults do not replace existing passwords, production requires setup-token initialization |
| Agent preparation fails           | Build Harness with `server:sync`, inspect diagnostics and directory permissions; do not start the retired Python/Supervisor              |
| Online but no reply               | Check personal/platform models, conversation selection and execution errors; bundled model names do not imply authorization              |
| Non-public provider address       | Check the exact origin in [server configuration](apps/admin/server/README.md#模型与网络); avoid broad allowlists                         |
| Tool failures under Chinese paths | Use Node-based workspace entry points instead of encoding-sensitive batch wrappers                                                       |
| Android still uses an old address | Check the saved address, signing and corresponding `adb reverse`; launcher flags do not overwrite the address                            |

Source checks, temporary databases, fixture models, real Host, headless UI and physical phones are recorded separately. Historical reports keep their original paths and outcomes. Current signing, clean-system and real multi-client regressions need separate acceptance.

## Topics and licenses

- [Desktop component index](apps/desktop/ui/README.md): chat, settings and device components.
- [Server deployment and configuration](apps/admin/server/README.md): Node modules, migrations, models and deployment entry.
- [Android environment and emulator](docs/android-local-development.md): SDK, AVD, Gradle and device access.

Retain the [MIT license](LICENSE) and upstream/third-party licenses and attribution. SuperDsh is an independent community project with no official DeepSeek affiliation or endorsement.

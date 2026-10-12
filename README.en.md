# SuperDsh

SuperDsh includes a desktop Agent app, unified management console, Python server, and Android app. The console organizes overview, permissions, models, devices, and system settings; chat is an Agent workspace module. DeepSeek Harness runs tasks as a required engine plugin.

**Use this page for everyday development.** [中文](README.md) · [Origins](#upstream-foundations) · [Design](#design-principles) · [Progress](#current-progress) · [Code locations](#project-structure) · [Startup](#daily-development) · [Integration](#cross-client-development) · [Checks](#checks-and-packaging)

## Upstream foundations

| Upstream project                                                                    | Reused foundation                                                               | SuperDsh changes                                                                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [Anywhere Labs / dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)         | Electron shell, desktop capabilities, and interactions from Desktop / Next      | Uses Next as the basis for one desktop product, consolidates UI / Core, and owns the application root, navigation, and engine lifecycle |
| [DeepSeek / deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)      | Full Host, Agents, tools, workflows, session persistence, and client components | Moves UI source into the product UI; wraps the engine in `@superdsh/harness`, sharing Host startup between desktop and server           |
| [Anywhere Labs / Agents-Anywhere](https://github.com/anywhere-labs/Agents-Anywhere) | Connector, Bridge, API v2, admin web, and mobile clients                        | Moves admin, server, and Android into `apps`; extends unified login, RBAC, device controls, personal models, and Server Agent           |

Harness is pinned to `0.1.7-alpha.2`; see [upstream.json](upstream.json). AA apps were imported from `f9129757c3ee`; see the [application provenance manifest](vendor/agents-anywhere/apps-source.json). Both upstream submodules stay pinned; protocol compatibility changes live in product adapters and controlled patches. Retired desktop directories are no longer development or build inputs.

## Design principles

- **Desktop first, with the product shell in control.** SuperDsh owns windows, navigation, accounts, devices, and state. DSH is the required internal execution plugin. Keep Harness queues rather than building another execution engine.
- **Find code by responsibility.** Desktop views belong in UI, business and native capabilities in Core, and Harness integration in the plugin. Admin, server, and Android have separate development and build entry points.
- **Separate console management from the workspace.** The console owns menus, permissions, and routes; chat loads only inside its module. Future Agent product management can register another module; publication, assignment, and version management are outside this change.
- **One main chat, two execution targets.** Users choose their own computer or Server Agent. Mobile, web, and desktop reuse API v2 and the same owned session. Server execution does not require an online computer; Android does not embed Harness.
- **Separate platform identity from model authorization.** Platform accounts manage resources and remote access; DeepSeek or personal keys authorize model calls. Desktop retains local Home and model settings; platform login neither restarts the app nor opens another chat window.
- **Preserve ownership isolation and compatibility.** Administrator and member are the two built-in roles, with custom roles supported. Management permissions do not grant access to other users' content. Server instances are isolated per user; pinned protocols and third-party plugin compatibility remain.

This phase excludes organizations/tenants, device sharing, multiple engines, a second task queue, and a new workflow DAG editor. Prioritize reliable existing capabilities, consistent interaction, and clear development entry points.

## Current progress

**As of 2026-10-12: the core architecture and management console refactor are implemented; feature integration and stability work continue. Release acceptance is incomplete.** The table separates implemented code from verification; historical tests do not certify the current version.

| Area                         | Status                                           | Evidence and remaining limits                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository and desktop shell | Migrated and separated                           | Four apps under `apps`, desktop UI / Core / Harness responsibilities, retired desktop source removed; see the [migration record](docs/superdsh-migration-validation.md)                                                                        |
| Desktop login and main chat  | Implemented, stage validation                    | Inline password login, fixed local Home, automatic computer connection, device switching in the main chat; real Host / Connector and headless UI verified separately in the [record](docs/desktop-inline-login-validation.md)                  |
| Platform identity and RBAC   | Implemented, stage validation                    | Multiple roles, login refresh/revocation, ownership checks, device blocking, and audit; see the [identity record](docs/platform-identity-validation.md), whose old account-space design is superseded by inline login                          |
| Management console           | Refactored, regression checked                   | Overview and seven navigation areas, persistent permission-filtered menus, workspace loaded on demand; future Agent publication and assignment are excluded                                                                                    |
| Server Agent                 | Implemented, integration ongoing                 | Per-user execution, preparation upon web workspace entry or native login, real Host / Connector online verification; [historical integration](docs/server-agent-validation.md) used local model fixtures, not complete real-client UI coverage |
| Personal and platform models | Implemented, partial verification                | Three protocols, encrypted keys, defaults, and DeepSeek presets; recent real-key connection verification passed, while complete chat replies and error feedback still need work                                                                |
| Android and shared sessions  | Implemented, current-client revalidation pending | Chinese UI, login, server entry, offline history/drafts have source and build records; [older emulator connectivity](docs/apps-migration-validation.md) does not certify the current physical-phone experience                                 |
| Packaging and release        | Stage builds, not released                       | Windows Chinese-path, Docker, desktop directory, and Debug APK builds have records; latest full installer, clean OS, macOS/Linux, signing, and updates still need acceptance                                                                   |

**Next priorities:** investigate missing server chat replies and missing errors, improve empty-model guidance and selectable-model checks, then validate real DeepSeek and shared-session operation across mobile/web/desktop, reconnection, and target switching. Historical evidence is linked from the [documentation index](docs/README.en.md#validation-records).

**Model center proposal (not implemented):** unify provider connections, the model catalog, and usage permissions, with simpler desktop presets. Evaluate a separate Docker gateway for 9router / Codex authorization, serving the three clients first and reserving an external API. Keep local, personal-account, and platform-provided sources distinct and isolate personal authorization by user. The current deployment does not include 9router or a Codex authorization shortcut.

## Project structure

| What to change                                    | Location and entry points                                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop root, navigation, UI, and theme           | [apps/desktop/ui](apps/desktop/ui/): `src/app`, `src/features`, `src/components`, `src/theme`                                                                         |
| Desktop chat, history, composer, workflows        | UI `features/chat`, `conversation`, `workspace`, `workflows`                                                                                                          |
| Desktop platform login, devices, remote chat      | UI `features/platform`; reuses the main sidebar, messages, and composer                                                                                               |
| Desktop logic, windows, IPC, permissions, updates | [apps/desktop/core](apps/desktop/core/): `src/main`, `preload`, `client`, `services`                                                                                  |
| Backend lifecycle, imports, cross-process types   | Core `src/backend`, `application`, `contracts`                                                                                                                        |
| Harness startup, Profiles, protocol adaptation    | [apps/desktop/plugins/harness](apps/desktop/plugins/harness/): `src/host`, `host-runtime.ts`, `profiles.ts`                                                           |
| Admin web, users, roles, device pages             | [apps/admin](apps/admin/): `src/app`, `src/features`, `src/components`; Next.js / React / TypeScript                                                                  |
| API, authentication, RBAC, relay, database        | [apps/server](apps/server/): `agent_server/api`, `services`, `infra`, `migrations`; Python 3.12 / FastAPI                                                             |
| Server Agent and container coordination           | Server `agent-runtime`, `agent-supervisor`; a separate Harness / Connector per user                                                                                   |
| Android UI, logic, networking, Chinese strings    | [apps/android](apps/android/): `ui`, `feature`, `api` under `app/src/main/java/com/agentsanywhere/app`; strings in `app/src/main/res/values-zh-rCN`; Kotlin / Compose |

`apps/desktop` assembles and releases the product; UI and Core are its two main business packages. Pinned upstreams are in `deepseek-harness` and `agents-anywhere`. AA retains Connector, Bridge, shared protocols, and iOS reference source; iOS migration is outside this phase.

Console development entry points: `apps/admin/src/components/console` contains the shell and menu editor; `src/features/console/modules.ts` registers pages, permissions, and loading entries; `src/features/console/routes.ts` owns Hash routing. Existing chat is assembled in `components/demo.tsx`; `features/workbench` holds account-scoped transient interaction state. Management modules do not depend on `WorkspaceProvider`.

## Prerequisites

Run all commands from the **repository root**. Examples use Windows PowerShell; replace `corepack.cmd` with `corepack` on macOS/Linux.

| Work                                | Requirements                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Desktop and admin web               | Git, Node 24.x, Corepack, Yarn 4.18                                                                                      |
| Python API                          | `server:sync` uses uv to prepare Python 3.12 and locked dependencies; `UV_PATH` can select uv                            |
| Local databases and full deployment | Docker Desktop with its Linux engine; an existing PostgreSQL / Redis installation lets the native API run without Docker |
| Android                             | JDK 17, Android SDK 36, Build Tools 34.0.0; emulation also needs Emulator, Platform Tools, and an existing AVD           |

After obtaining the source:

```powershell
git submodule update --init --recursive
node scripts/prepare-aa-source.mjs
corepack.cmd yarn install --immutable
```

Source preparation applies sparse checkout to AA, excluding the old application directories now owned under `apps`. Do not restore those paths or add forwarding links.

## Daily development

### Desktop

```powershell
corepack.cmd yarn dev
```

This builds the product, then starts Electron and the UI watcher. **A successful UI rebuild restarts the backend and refreshes the page, interrupting running tasks.** Restart `dev` after Core, Preload, or Harness integration changes. Use `corepack.cmd yarn start` for existing artifacts; run `build` first after source changes.

### Admin web and Python API (recommended development mode)

Start both applications manually on the host. `server:deps:up` runs **only PostgreSQL and Redis**; `server:dev` then prepares the Supervisor, API relay container, and runtime image required by Server Agent. Open Docker Desktop, then prepare dependencies once:

```powershell
corepack.cmd yarn server:sync
corepack.cmd yarn server:deps:up
```

Terminal one starts the API, applies incremental migrations, ensures the development administrator, prepares Agent dependencies, then enables reload. The first startup builds the Harness runtime image if it is missing:

```powershell
corepack.cmd yarn server:dev
```

Terminal two starts the web application:

```powershell
corepack.cmd yarn admin:dev
```

Web login opens Overview. Permission-filtered navigation includes Users and permissions, Models, Device operations, Agent workspace, System, and Personal center. Configure two-level groups, order, and role visibility at `#/access/menus`; hiding a menu does not change authorization. Apply API migration `v2_39` before updating the web app; existing administrators receive menu permissions. Deployment updates remain manual.

| Service                                                | Default address                                  |
| ------------------------------------------------------ | ------------------------------------------------ |
| Admin web                                              | [http://127.0.0.1:5174](http://127.0.0.1:5174)   |
| API                                                    | `http://127.0.0.1:8000`                          |
| API readiness                                          | `http://127.0.0.1:8000/api/v2/health/ready`      |
| PostgreSQL / Redis (default, loopback only)            | `127.0.0.1:15432` / `127.0.0.1:16379`            |
| Development Agent Supervisor (internal authentication) | `127.0.0.1:18090`                                |
| Full Docker deployment (separate mode)                 | [http://127.0.0.1:15174](http://127.0.0.1:15174) |

The local `superdsh-dev` database automatically creates the administrator **`admin` / `admin123`**; an existing `admin` keeps its password, roles, and status. Development and deployed databases do not share accounts. Full Docker and production deployments still use a **setup token** to initialize an administrator for an empty database and provide no default account.

Development dependencies belong to the isolated `superdsh-dev` project. Credentials and model encryption keys live in the Git-ignored `.superdsh-work/server-dev/aa-dev.env`; keep this file with its volumes. Stop the native API and web application with `Ctrl+C` first, then use `corepack.cmd yarn server:deps:down` to stop databases, control services, and managed Agents while preserving all volumes. A running API may schedule Agents again.

For computer-only development, set `$env:SUPERDSH_DEV_AGENT_ENABLED='0'` in the API terminal. Use `SUPERDSH_DEV_AGENT_PORT` to change the Supervisor port and `AGENT_SERVER_PORT` to change the API port. Development Agents reach the native API through Docker Desktop's `host.docker.internal`; this route is not yet verified on native Linux hosts, where full Docker deployment is available instead.

Repeated `server:deps:up` calls skip healthy dependencies owned by this project. If another process occupies a port, the command selects a free port and saves it to `.superdsh-work/server-dev/aa-dev.env` for subsequent API startup. Use the actual ports printed by the command. Explicit shell port overrides are not changed automatically; restart any existing API process to load new ports.

The web application proxies `/api/v2` to local port `8000` by default. Clear any previous `NEXT_OUTPUT=export` setting before development; use `AGENTS_ANYWHERE_API` to change the API target. To use existing databases, set both `AGENT_SERVER_DB_URL` and `AGENT_SERVER_REDIS_URL` in the API terminal and skip `server:deps:up`. An explicit database URL disables automatic development account creation; initialize an empty database with its setup token. See the [server guide](apps/server/README.md) for full configuration.

### Android

Open `apps/android` in Android Studio. With the SDK and an AVD available:

```powershell
corepack.cmd yarn android:build
corepack.cmd yarn android:start --server http://127.0.0.1:8000
```

`android:start` installs an existing Debug APK and opens the app; it does not build or start services. Double-clicking `start-android.cmd` uses local configuration. Updating an installation preserves its account and language settings and requires the original signing key.

`--server` controls the health check and emulator port mapping; **it does not replace the server address saved in the app**. Enter `http://127.0.0.1:8000` on the login page. See the [Android guide](docs/android-local-development.md) for SDK, AVD, and build options.

## Cross-client development

```text
Local desktop: SuperDsh Core → backend process → Harness plugin → local sessions
Remote access: web / Android / desktop → Python API v2 → target Connector → Harness
Execution target: your computer, or your Server Agent container
```

**Computer execution:** start the development services and desktop. Enter the API address, username or email, and password in the desktop account menu. Successful platform login automatically connects this computer and synchronizes sessions. Sign in with the same account on Android and web, then select the computer and session. The device is online only after Connector and Harness are ready; a signed-in phone does not need another QR scan.

Desktop also works independently with DeepSeek / a personal API key. Platform login, logout, and account switching keep the app and Harness running, using the existing local Home and main chat. Remote files and terminals always address the selected device. Switching accounts with running tasks requires confirmation to stop them; cancellation preserves the account and tasks. In-place login and development UI rebuilds have different lifecycle behavior.

**Server Agent mode:** `server:dev` prepares runtime dependencies. Web login and management pages do not start an Agent; entering Agent workspace prepares or reuses the instance, with explicit retry after failure. Desktop and Android retain preparation after login. Personal center → Personal models → Add provider preselects DeepSeek: enter a key and save. With no existing default, the default-model option is checked; custom providers remain available. **An online Agent or successful connection check does not prove model replies work.** Explicitly select the configured model in existing sessions before sending again.

To run both the admin web application and API in containers, follow the [Git-to-Docker server deployment guide](apps/server/docker/README.md#服务器首次部署) for first-time Linux / CentOS setup, administrator initialization, HTTPS, and updates. The following commands assume the environment and source are already prepared:

```powershell
corepack.cmd yarn server:build
corepack.cmd yarn server:up --no-build
```

Open `15174` and sign all clients into that deployment; web prepares its Agent upon entering the workspace. Stop the full deployment with `corepack.cmd yarn server:down`, retaining volumes and their environment file. Its database, accounts, and Agents are separate from development on port `8000`.

| Integration target     | Platform login address   | Emulator mapping                  |
| ---------------------- | ------------------------ | --------------------------------- |
| Native development API | `http://127.0.0.1:8000`  | `adb reverse tcp:8000 tcp:8000`   |
| Full Docker service    | `http://127.0.0.1:15174` | `adb reverse tcp:15174 tcp:15174` |

The launcher sets the matching mapping for loopback addresses passed through `--server`; use the commands above for manual connections. Physical phones need a reachable LAN or HTTPS address and cannot use the computer's `127.0.0.1`.

Administrator and member are the only built-in roles; custom roles are supported. Administrative operations do not grant access to other users' chats, files, or terminals. Platform provider keys and server-side personal keys are encrypted and write-only. New server sessions prefer the personal default, then the platform default; existing sessions do not silently change model or billing source. Desktop personal models stay on that computer.

Offline phones can read previously loaded history and save drafts, then send manually after reconnecting. Closing the phone client does not stop server tasks. Account and target switches must not mix history, subscriptions, or credentials.

Switching web modules releases workspace subscriptions and polling while retaining the current account’s drafts, pending files, selections, and send results in memory. Leaving the workspace or signing out does not stop submitted tasks. Reloading the document loses transient files; logout or account switching clears memory state.

## Checks and packaging

Append these commands to `corepack.cmd yarn`, still from the repository root:

| Area                | Command                                                | Purpose                                                        |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| Desktop             | `build` / `start`                                      | Build the product / start existing artifacts                   |
| UI only             | `workspace @superdsh/ui build`                         | Rebuild UI; perform a full build first                         |
| Desktop quality     | `typecheck` / `lint` / `format:check` / `test`         | Types, code rules, formatting, tests                           |
| Full desktop checks | `check` / `check:ui`                                   | Engineering and real Host checks / separate headless UI checks |
| Admin web           | `admin:check` / `admin:build` / `admin:start`          | Types, tests, protocol / build / start a build                 |
| Python server       | `server:check` / `server:test`                         | Protocol and layering / isolated tests                         |
| Android             | `android:check` / `android:test` / `android:build`     | Static constraints / JVM tests / Debug APK                     |
| Desktop release     | `package:dir` / `dist:win` / `dist:mac` / `dist:linux` | Unpacked app / platform artifacts (Linux: unpacked directory)  |
| Source layout       | `sources:check` / `check:layout`                       | Pinned upstream and product ownership boundaries               |

Root `dev/build/start/check` target desktop by default; use separate Admin, Server, and Android checks as well. Before the first `check:ui`, install Chromium with `corepack.cmd yarn workspace @superdsh/desktop exec playwright install chromium`. UI checks require built artifacts.

Desktop packaging outputs to `apps/desktop/dist`; the Android APK is at `apps/android/app/build/outputs/apk/debug/app-debug.apk`. Full Docker deployment build, startup, and shutdown are separate operations; source edits do not automatically update running containers.

## Code and data conventions

- UI imports only Core's public `client/*` and `contracts/*`, never Node, Electron, or upstream internals. Legacy third-party UI stays in a separate compatibility container with module IDs, Remote, and Slots semantics preserved.
- Use two spaces, single quotes, and no ordinary statement semicolons; PascalCase components and kebab-case modules, with Prettier authoritative. Product code uses root Yarn; upstream Harness keeps pnpm. Do not edit generated types, build artifacts, or pinned upstream source.
- Development Home defaults to `.superdsh/home`; installed apps use `SuperDsh/home` in system application data. `SUPERDSH_HOME` or saved directory settings can override the default.
- Platform accounts do not change local Home. Credentials, device bindings, and sync checkpoints are separated by platform origin and stable user ID. Different accounts on one computer receive separate cloud copies of the same local history; old platform Homes are not automatically merged.
- Imports require the source app to be stopped, an empty destination, and a backup. Failures roll back without overwriting the source. Authorizations, keys, environment variables, `.credentials.yaml`, and device bindings are excluded and must be configured again.
- Do not commit local configuration, signing material, or keys. Database backups must include their original environment file and encryption keys. Configure your own updater and signing before release, retaining attribution. See [AGENTS.md](AGENTS.md) for repository rules.

## Troubleshooting and validation

| Symptom                                                        | First checks                                                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing `DockerDesktopLinuxEngine` pipe                        | Ensure Docker Desktop's Linux engine is ready; check `docker info` before dependency or deployment commands                                                               |
| Web UI unreachable                                             | Development web uses `5174`, API uses `8000`, full deployment uses `15174`; confirm the matching process is running                                                       |
| Login fails or device is offline                               | Check the environment and empty-database setup, then API readiness and Connector status; a login session is not an execution device                                       |
| Agent online but chat has no reply                             | Check personal/platform models, the session selection, and execution errors; a built-in DeepSeek label does not prove authorization. See [progress](#current-progress)    |
| Official model verification reports a non-public address       | A local Fake-IP proxy may trigger the check; review the exact origin in [server configuration](apps/server/README.md), restart the API, and avoid duplicate API instances |
| Tool module not found in a Chinese path                        | Workspace scripts use tools' Node entry points; avoid batch wrappers that corrupt path encoding                                                                           |
| First dependency install or web compilation runs out of memory | Retain diagnostics, free memory, and reduce concurrent work before retrying; unverified heap flags are not a universal fix                                                |
| Android fails to open or still uses an old endpoint            | Build the APK first, then check SDK/AVD/signing, the saved app address, and the matching `adb reverse`                                                                    |

This progress summary separates the current console regressions from historical cross-client integration evidence. Static checks, model fixtures, real Host tests, headless UI, and physical-device verification have separate scopes and do not substitute for one another.

## Further reading and license

Use these three guides when you need more detail:

- [Desktop component index](apps/desktop/ui/README.md): specific chat, settings, and device components.
- [Server deployment and configuration](apps/server/README.md): databases, keys, authentication, full deployment, and Server Agent.
- [Android environment and emulator](docs/android-local-development.md): SDK, AVD, Gradle, signing, and device connections.

Preserve the [MIT license](LICENSE) and the licenses and attribution of upstream and third-party components. See [upstream foundations](#upstream-foundations) for provenance. SuperDsh is an independent community project without official DeepSeek affiliation or endorsement.

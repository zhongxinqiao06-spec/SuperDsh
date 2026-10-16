# SuperDsh repository rules

## Product ownership

- Product applications: `apps/desktop`, `apps/admin` (Next.js pages and Node.js API v2), and `apps/android` (Kotlin/Gradle). Admin inherits root Yarn; Android retains Gradle. The retired Python backend is not a runtime dependency or fallback.
- Platform backend: `apps/admin/server`. HTTP/WebSocket, identity, RBAC, SQL repositories, models and native Agent supervision share a Node entry. Browser code must not import server implementation or credentials. `server:dev` starts Next.js and Node API together on the host. Root `compose.yml` deploys the unified platform and its managed Harness child processes with PostgreSQL, Redis and Qdrant; the development dependency Compose remains database-only. Preserve persistent volumes and generated deployment secrets on updates.
- Agent execution remains a managed child process with a per-user Home and workspace in development and production. PostgreSQL leases prevent duplicate ownership. Product ownership checks are not an operating-system sandbox; never describe same-user processes as container-equivalent isolation. Preserve Harness's existing queue and protocols.
- Desktop product entry: `apps/desktop`. Its assembly manifest preserves `@superdsh/desktop` and selects runtime assets.
- `apps/desktop/ui`: product root/navigation, components, features, theme and browser build. Own the product root; never let a DSH root slot choose it.
- `apps/desktop/core`: main/preload, application lifecycle, browser-safe client models, services and contracts. UI can import only public Core `client/*` and `contracts/*`; never Electron, Node implementations or upstream internals.
- `apps/desktop/plugins/harness`: required fixed engine, Host/Profile/CLI and runtime dependency tree. The product starts/stops it. No second execution queue or multi-engine registry.
- `dsh-community-market` retains optional plugin metadata/build entry; implementation is in Core services/contracts and UI features. Keep its production runtime dependency tree independent of Core.
- `deepseek-harness` and `agents-anywhere` remain pinned upstream submodules. Do not edit them as part of product work.
- The migrated AA apps are owned source; the former server app is now the Node port under `apps/admin/server`. `yarn sources:prepare` applies the pinned AA sparse checkout that physically excludes `web-next`, `server`, and `android`; do not restore old paths or create forwarding links. Import provenance is in `vendor/agents-anywhere/apps-source.json`. Shared AA protocol fixtures remain read-only under its `contracts` directory.
- Retired desktop source is not an active workspace or fallback command. The pre-refactor source snapshot is under `.superdsh-work`; never depend on retired files.

## Runtime boundaries

- Preserve Electron main, sandboxed preload, product renderer, compatibility renderer and backend process isolation. A failed required engine exposes diagnostics/retry/recovery, not business UI.
- Third-party legacy modules run in a product-controlled compatibility WebContentsView. Browser access uses a separate window without an opener. Preserve module IDs, Cordis/Remote/Slots semantics and per-context React singletons.
- `ui/source-manifest.json` selects owned modules; `client-manifest.json` identifies compiled resources. Missing owned artifacts must fail. No fallback to old vendor UI.
- Product navigation owns builtin screens. Protocol adaptation belongs in compatibility/Harness integration; ordinary views consume product props/models.
- Keep `runProfile` and its installation anchor in the same Harness dependency tree. Browser dependencies are build inputs, never a second Host.
- Preserve backend-enforced management protection for Harness, desktop and webserver. Markets, AA and Computer Use remain optional.
- Generate product patches against pristine pinned vendor archives and preserve earlier patch behavior. Engine changes require a dedicated fork/pin and protocol/patch checks.

## Style and checks

- Root Yarn 4.18 / Node 24.x. Harness upstream retains pnpm. Use `corepack yarn install --immutable` for a settled lockfile.
- Two spaces, single quotes, no ordinary statement semicolons; Prettier is authoritative. Component names use PascalCase; ordinary modules use kebab-case. Preserve established protocol IDs and generated filenames.
- `yarn lint`, `yarn format:check`, `yarn typecheck`, `yarn test` and `yarn check:layout` enforce ownership. Complete UI source must typecheck; do not add blanket `any`/`ts-nocheck` exclusions to silence migration errors.
- Do not manually reformat generated codecs/contracts, vendored archives or third-party/submodule source.
- Use `node node_modules/<tool>/<entry>` in workspace scripts: generated Windows wrappers may corrupt Chinese paths in CP936 terminals.
- `dev/build/start/package:dir/dist:*` target this product only. `check:ui` runs headless browser integration, including third-party root isolation.
- `admin:*`, `server:*`, and `android:*` target the platform and mobile applications. Node database migrations preserve the existing `alembic_version` revision chain and support product v2_35 through v2_39 without changing owner IDs, password hashes or encrypted model credentials. Older pre-product databases require their original release's upgrade; never auto-stamp an unknown schema. Preserve API v2, OAuth callback identities, database volume names, Android app identity and signing. Never copy real credentials or machine caches into source.
- Keep automated tests headless with temporary Home/user data. Real GUI, phone/account login, platform permissions and signing need explicit environment verification; never describe mocks as real device coverage.
- Data import accepts an empty target, backs up/copies the source, checks active locks and rolls back on failure. Never test against real user profiles.
- Preserve licenses/attribution. Before release verify AA provenance, configure own updater URLs and signing; do not silently refresh a custom bridge or publish upstream release artifacts.

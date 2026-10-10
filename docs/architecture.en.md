# SuperDsh desktop architecture

SuperDsh owns the product shell and starts Harness as a required builtin plugin. Product development is under `apps/desktop`. The DSH root slot no longer chooses the product UI. Admin web, the Python server and Android live in the sibling directories `apps/admin`, `apps/server` and `apps/android`.

Admin web and Android connect to the Python server through API v2; the server reaches desktop Harness through Connector. Admin web builds and runs independently during development. Docker deployment serves its static files from Python, preserving same-origin authentication and the existing address. Shared protocol fixtures, Connector and Bridge remain in the pinned AA submodule. Sparse checkout physically excludes the three migrated applications from that upstream working tree. Root `sources:prepare` establishes this layout; `sources:check` prevents the old paths from becoming development entry points again.

## Control and processes

Electron/Core manages a local backend process, which loads the fixed Harness Host. Required engine readiness gates the product UI. Failure exposes diagnostics, retry and recovery. DSH remains authoritative for Agent execution, session persistence and its existing queue, cancellation and approval semantics.

Platform identity is independent of the local Host lifecycle. Normal startup loads the product RuntimeBridge and local model gateway. In-place login changes credentials, Connector and the model catalog without restarting Host or switching Home. Safe mode disables platform connections; platform failures do not close local DeepSeek chat. Core explicitly selects product-managed Python 3.12 for Connector instead of using the system default.

The main chat uses Core's `ConversationTarget` / `ConversationSource` to distinguish local and remote targets while sharing messages and the composer. Native DSH logs and API v2 timelines have separate adapters. Remote calls, subscriptions and attachments carry the account generation and complete device target, preventing old responses or subscriptions from updating a new target. Platform bindings and sync checkpoints are scoped by server origin and user ID; history always comes from the same local Home.

## Source responsibilities

| Package                        | Responsibility                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `apps/desktop/ui`              | React root, product navigation, feature components, theme and compatibility entry                            |
| `apps/desktop/core`            | main/preload, backend lifecycle, services, browser-safe models and process contracts                         |
| `apps/desktop/plugins/harness` | Fixed Host, Profiles, protocol adapters and runtime dependencies                                             |
| `apps/desktop`                 | Product identity, injected asset manifest and build/release entry                                            |
| `dsh-community-market`         | Optional plugin identity and dependencies; implementation resides in UI features and Core services/contracts |

UI may import only Core's public `client/*` and `contracts/*`. Core/client cannot import Node/Electron or platform implementations. Harness may bundle pure contracts at build time but cannot depend on Core at runtime. Upstream engine, mobile and third-party source retain their dependency boundaries.

## Product and third-party UI

`ui/src/app` creates the product root and owns navigation. Builtins use a fixed admission manifest; third-party old clients do not activate in the product context. A compatibility container preserves module IDs, Cordis, Slots, Remote and desktop bridges. Its legacy root affects only that container.

Electron uses another sandboxed WebContentsView at `dsh-app://compat`; ordinary browsers use a separate window without an opener. Closing it, reloading the product or renderer failure releases resources. The compatibility document retains Host authentication and the browser-access gate. React/Cordis remain singletons in each context.

Existing protocol calls in owned components are progressively adapted through the compatibility layer while preserving event order, reconnect, cancellation and approval behavior.

## Build and data

Root Yarn builds market → Harness → Core → UI → assembly. The pinned upstream Harness retains pnpm. UI emits the product document, compatibility document, native utility document and 70 builtin dynamic modules with source manifests. Missing owned artifacts fail explicitly; no fallback to upstream UI is allowed.

Installed data uses the system application-data `SuperDsh/home`; development uses repository `.superdsh/home`. Import requires an empty target, source backup and rollback without rewriting the source. The AA Bridge continues inside Harness with compatible mobile protocols and persisted data.

See the [README](../README.en.md#project-structure) for concrete files and commands, and the [validation record](superdsh-migration-validation.md) for tested coverage.

# SuperDsh desktop product

This directory owns the product. UI and Core are the two business packages; Harness is the required builtin engine plugin.

| Development area                                                                | Entry                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------- |
| Product root/navigation, chat, workflows, settings, plugins and utility windows | [ui/src](ui/src/)                           |
| Product state, services, Electron, Preload and lifecycle                        | [core/src](core/src/)                       |
| DSH startup, Profiles and runtime protocol                                      | [plugins/harness/src](plugins/harness/src/) |
| Build, regression checks and platform packaging                                 | [scripts](scripts/)                         |

Use the repository [README](../../README.en.md#daily-development) for setup and development commands, [checks and packaging](../../README.en.md#checks-and-packaging) for validation, and the [UI component index](ui/README.md) to find views. The [architecture](../../docs/architecture.en.md) explains readiness, compatibility and dependency boundaries.

Retired desktop editions, former workspace directories, the unused `shared` copy and obsolete build configuration were physically removed on 2026-09-28. Source snapshots and the cleanup record remain under repository `.superdsh-work`; see the [migration record](../../docs/superdsh-migration-validation.md). Development and release use the current product only.

[中文](README.zh.md) · [Anywhere Labs MIT](LICENSE) · [DeepSeek MIT](LICENSE.upstream)

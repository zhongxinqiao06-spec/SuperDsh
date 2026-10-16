# SuperDsh Documentation

[中文文档](README.md)

Start development with the root [README](../README.en.md), which owns [upstream foundations](../README.en.md#upstream-foundations), [design principles](../README.en.md#design-principles), [current progress](../README.en.md#current-progress), project structure, startup, integration, and check commands. See [CONTRIBUTING](../CONTRIBUTING.en.md) for the contribution workflow.

## Development topics

| Document                                                  | Covers                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| [Desktop UI index](../apps/desktop/ui/README.md)          | Components, feature directories, and edit locations          |
| [Server guide](../apps/admin/server/README.md)            | Node API, database migrations, native Agents and deployment  |
| [Local Android development](android-local-development.md) | SDK, Gradle, AVD, startup options, and emulator connectivity |

## User documentation

[User guide](user-guide.en.md) · [FAQ](faq.en.md) · [Privacy Policy](../PRIVACY.md)

## Design references and historical RFCs

Design references retain their stated scope. Historical imports, API examples, and RFC drafts are not current product dependencies or completed capabilities.

- Desktop references: [architecture](architecture.en.md), [design rationale](why-desktop.en.md), and [Desktop service archive](legacy-desktop/README.md).
- Plugin references: [ecosystem manifesto](plugin-ecosystem.en.md) and [plugin development](plugin-development.en.md).
- Fabric: [community Draft](../dsh-community-fabric/README.md), [feedback disposition](../dsh-community-fabric/docs/research/community-issue-23-review.md), [framework and plugin-needs research](../dsh-community-fabric/docs/research/mature-plugin-frameworks.md), and [VS Code extension-model research](../dsh-community-fabric/docs/research/vscode-extension-model.md).
- Market: [design](../dsh-community-market/README.md) and [catalog provider contract](../dsh-community-market/docs/catalog-provider-contract.md).

## Validation records

- Source migrations: [desktop](superdsh-migration-validation.md) and [admin, server, and Android](apps-migration-validation.md).
- Platform capabilities: [identity and RBAC](platform-identity-validation.md), [desktop inline login](desktop-inline-login-validation.md), and [server Agent](server-agent-validation.md).
- Windows installation: [NSIS A/B methodology](evidence/windows-nsis-ab-methodology.md) and [upgrade validation](evidence/windows-installer-upgrade-2026-08-25.md).

Validation records describe their original environments, results, and limits; original paths and conclusions remain intact. Use the [README](../README.en.md#troubleshooting-and-validation) for current startup and validation boundaries. Documentation in pinned upstream submodules belongs to those projects.

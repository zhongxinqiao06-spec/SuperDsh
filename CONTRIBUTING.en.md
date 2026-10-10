# Contributing

[中文](CONTRIBUTING.md) | English

Contributions to SuperDsh can fix bugs, improve features, or clarify documentation. Reports should include the application version, operating system, reproduction steps, and redacted logs. Describe the goal and scope before making a large change.

## Getting started

Read the root [README](README.en.md) and [repository rules](AGENTS.md) first. The README maintains [project structure](README.en.md#project-structure), [prerequisites](README.en.md#prerequisites), [daily development](README.en.md#daily-development), and [cross-client development](README.en.md#cross-client-development). Choose the code entry and development workflow that match the scope of your change.

Keep each contribution focused on a clear problem. Confirm the reproduction conditions or expected behavior before changing the application that owns the code. Follow the repository boundaries for source ownership, process isolation, and pinned upstream versions. See [plugin development](docs/plugin-development.en.md) for plugin integration.

## Validation before submitting

See [checks and packaging](README.en.md#checks-and-packaging) in the README for check commands and packaging entry points. Complete the repository checks relevant to your change. Desktop UI changes also need headless browser integration and third-party compatibility container checks. Admin, server, and Android changes use the corresponding application's check workflow.

Keep automated tests headless and use temporary Home and user data directories, never real user Profiles. Data imports and migrations follow [code and data conventions](README.en.md#code-and-data-conventions). Acceptance checks involving the real desktop GUI, physical phones, account login, platform permissions, or signing must record the actual environment and results. Do not describe simulated tests as real device coverage. See [troubleshooting and validation](README.en.md#troubleshooting-and-validation) for diagnostics and validation boundaries.

## Style and submissions

- Use two spaces, single quotes, and no ordinary statement semicolons; Prettier is authoritative. Components use PascalCase and ordinary modules use kebab-case.
- Do not manually format generated files, vendor files, or upstream source. Windows workspace scripts use `node node_modules/<tool>/<entry>` to avoid generated command wrappers corrupting Chinese paths.
- Use Conventional Commits, such as `fix(desktop): ...` or `docs: ...`. PR descriptions explain the problem, resulting behavior, verification, and anything not verified.
- Update both languages when a document has a translation. If a corresponding `.i18n.yaml` exists, refresh the Git blob hashes for both files.
- Preserve the [MIT license](LICENSE) and upstream and third-party notices. Check licensing and packaging ownership when adding or updating dependencies. See [further reading and license](README.en.md#further-reading-and-license) for related topics and license details.

Follow the [Code of Conduct](CODE_OF_CONDUCT.en.md) and discuss concrete issues with kindness and respect.

---
created: 2026-09-23
updated: 2026-09-23
---

# Contributing

Use Node 24.15.0 and Bun 1.3.3. Clone the repository, run `bun install --frozen-lockfile`, then `bun run check` and `bun run test:install`. Tests use a local Decisions fixture and recording answer adapters; no provider account or API key is required. Do not use `bun test`: Harness runs on Node.

The plugin selects a model once per user turn. Changes must preserve tool/retry pinning, manual selection, cancellation, credential redaction, and session replay. Add behavior tests for changes to these rules. Keep classifier-quality tests distinct from deterministic policy tests: mocked Jev answers cannot demonstrate real classification accuracy.

`node scripts/prepare-harness.mjs --dir .cache/harness --build` creates a separate pinned upstream checkout with the compatibility patch. Never copy another machine's `node_modules` or edit installed packages manually. See [compatibility](docs/compatibility.md) before updating Harness dependencies or the patch.

Use Conventional Commits, such as `fix(router): retain the task anchor after restart`. Separate independent changes. Include the problem, resulting behavior and validation in pull requests. Use synthetic test conversations; do not attach real session logs, credentials, local account state or provider responses containing private prompts.

Keep creation and updated dates in Markdown frontmatter. Update the README and examples when configuration changes. The public package is scoped; the unscoped npm name belongs to another project. Changes are contributed under the repository's MIT license.

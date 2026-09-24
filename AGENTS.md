---
created: 2026-09-24
updated: 2026-09-24
---

# Repository boundaries

Implement routing, configuration and UI in this repository through public Harness plugin APIs. Do not modify Harness source code, replace its installed modules, monkey-patch its internals, or require a modified Host to run this plugin.

If a required feature cannot be implemented through a public extension point, describe the missing capability and the specific proposed Host changes, then obtain the user's explicit confirmation before making them. This applies to `~/code/deepseek-harness` and test Host checkouts alike. Fetching and building an unmodified Host in this repository's cache is allowed.

Run tests against unpatched published dependencies and a clean Host composition. Keep plugin state in its own storage domain, and use existing supported session events for model selection.

---
created: 2026-09-23
updated: 2026-09-23
---

# Security and privacy

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/yurushao/dsh-model-router/security/advisories/new). Do not put keys, private prompts, session archives or working exploits in a public issue. Include the plugin version, Harness revision, affected configuration fields with secrets removed, and a minimal synthetic reproduction.

The current experimental release is the supported line. Fixes are published as new releases; older experimental versions do not receive a separate maintenance promise.

Routing sends the current request and task anchor to the configured Jev endpoint; optional history adds selected prior conversation messages. The chosen answer provider receives the normal Harness model input. Provider retention and account policies are outside this plugin. Jev decisions and request text are not a trusted source of configuration: model IDs and endpoints come from operator configuration.

Supply credentials through the launch environment or private Cordis configuration. Do not commit `.env`, credential files, profile homes or real session logs. Diagnostic events intentionally omit prompt text and keys, but ordinary Harness sessions retain conversation content. Review any logs before sharing.

The compatibility script downloads a fixed public Harness commit and checks the bundled patch hash. Its build step executes that revision's package scripts. It refuses to replace unrelated tracked changes in an existing checkout. Keep the plugin and compatible host versions together; the startup compatibility check is required to protect session reloads.

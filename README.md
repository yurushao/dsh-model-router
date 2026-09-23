---
created: 2026-09-22
updated: 2026-09-23
---

# DSH Model Router

**Automatic model selection for DeepSeek Harness, powered by Jev.**

An experimental community plugin that chooses between your configured economy and frontier models. It evaluates each user turn, retains the selected model through tools and retries, and avoids downgrading a frontier task for a short follow-up. Choose **Auto · Jev** to enable routing or a concrete model to bypass it.

The project is independent of DeepSeek, Jev and OpenRouter. The package is **`@yurushao/dsh-model-router`**. The unrelated unscoped npm package `dsh-model-router` is not this project.

## Compatibility

This release requires the **bundled compatibility patch** against Harness `0.1.7-alpha.1`, commit `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`. An unmodified Harness installation is not supported: its Session API cannot safely persist external informational events. The patch also supplies Auto/manual UI state, actual-model labels, and OpenRouter session affinity. The plugin checks Session compatibility before enabling routing.

Use Node **24.15.0**, Bun **1.3.3**, Git, and native build tools (Xcode Command Line Tools on macOS; a C/C++ toolchain and Python on Linux). The preparation script invokes pnpm **11.7.0**. Windows is not yet verified. Bun installs dependencies and invokes scripts; Harness and Vitest run on Node, not `bun test`.

## Quick start

Clone this repository and prepare the compatible host. This downloads the pinned public upstream commit, verifies and applies the bundled patch, and builds from source. It does not read or modify another Harness checkout.

```sh
git clone https://github.com/yurushao/dsh-model-router.git
cd dsh-model-router
bun install --frozen-lockfile
bun run check
node scripts/prepare-harness.mjs --dir .cache/harness --build
bun pm pack
```

Alternatively, download the prebuilt plugin `.tgz` from [Releases](https://github.com/yurushao/dsh-model-router/releases), verify its SHA-256 against the accompanying `SHA256SUMS`, and use it with the same compatible host. The plugin tarball does not contain Harness or replace the host build.

Install into an isolated Harness home first. From this repository root:

```sh
export DSH_HOME="$PWD/.cache/demo-home"
export DSH_ROUTER_ROOT="$PWD"
cd .cache/harness
npx --yes pnpm@11.7.0 dsh plugin --profile web add "$DSH_ROUTER_ROOT/yurushao-dsh-model-router-0.4.0.tgz"
```

The bundle is initially disabled. Configure two tool-capable OpenRouter model IDs and your key in the environment of the process that launches Harness; the plugin does not read `.env` files. Replace the placeholders with models available to your account:

```sh
export OPENROUTER_API_KEY='<your OpenRouter key>'
export JEV_ECONOMY_MODEL='<economy-model-id>'
export JEV_FRONTIER_MODEL='<frontier-model-id>'
npx --yes pnpm@11.7.0 dsh --profile web --patch "$DSH_ROUTER_ROOT/examples/openrouter.patch.yml"
```

This example configures both the answer provider and Jev. Sending a request incurs Jev and answer-model charges. The frontier output limit is 8192 tokens and economy is 2048; adjust both to your budget and models. OpenRouter model availability and capabilities depend on your account; the example does not guarantee access.

For providers already configured in Harness, use [the provider-neutral overlay](examples/router.patch.yml). Jev still needs an OpenRouter key. A configured DeepSeek account route uses the host's existing login; the router does not require an additional DeepSeek API key for that route. Copying an overlay over an existing provider configuration can replace entries; merge it deliberately or keep the isolated home.

## Verify it works

1. In a new conversation, select **Auto · Jev** and ask for a simple translation. The response footer should show the actual chosen model and automatic selection.
2. Ask for a new, complex reasoning task. Inspect the actual model and the prompt-free `jev-router/routing` session event; the event records the choice, reason, confidence signals, and task starting turn.
3. Ask a brief follow-up, then a clearly independent translation task. A continuation retains frontier; a confidently recognized independent easy task can downgrade.
4. Select a concrete model. That user turn bypasses Jev.

Classification is probabilistic; these are useful checks, not guaranteed choices for every wording. If a model rejects a request, its authentication, region, quota or transport error remains visible. The router does not silently replay failed tool actions on another model.

## How routing works

- Jev's Decisions API (`typesafe/jev-1.13`) classifies required capability and task relationship once per user turn. Tool continuations, retries and steering retain that turn's selection.
- Economy requires `economyThreshold` (default 0.8). A downgrade from frontier also requires a new-task result meeting `newTaskThreshold` (default 0.9). These are policy signals, not calibrated success probabilities.
- The default classifier context is the current request plus the original request anchoring the current task. Intermediate answers are omitted to reduce historical interference. Optional recent history excludes system messages, injected user-role notices and hidden reasoning.
- Jev failure retains an eligible current model, otherwise the eligible fallback. Cancellation does not invoke fallback. Capability and configured input limits are checked before paid calls.
- Images/files or oversized classifier input retain an eligible current route, or prefer frontier without one. Jev itself is text-only.
- The compatible host sends a stable `x-session-id` to the official OpenRouter HTTPS origin. This improves affinity but does not share caches between models or guarantee savings.

The answer model still receives the normal Harness conversation history. Selecting Auto after manual mode starts a fresh routing task context. Saved route identifiers remain `jev-router/auto`, `jev-router/routing` and `jev-router/decision` for compatibility with earlier local releases.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `models.economy`, `models.frontier` | Required | Registered Harness provider/model, optional capability description and reasoning effort |
| `apiKey` | Required | OpenRouter key, supplied through Cordis config |
| `endpoint` | OpenRouter Decisions endpoint | HTTPS endpoint accepting the Decisions format |
| `jevModel` | `typesafe/jev-1.13` | Classifier model |
| `economyThreshold` | 0.8 | Economy confidence policy, 0.5–1 |
| `newTaskThreshold` | 0.9 | New-task confidence required to downgrade, 0.5–1 |
| `timeoutMs` | 3000 | Classification request/response deadline |
| `maxRoutingBytes` | 16000 | UTF-8 classification input limit; maximum 24000 |
| `historyMessages` | 0 | Optional recent conversation message count; zero omits history |
| `fallbackTier` | frontier | Used when no eligible incumbent can be retained |
| `includeSubagents` | true | Route subagents as well as the main agent |
| `enabled` | true | Routing switch after valid configuration |

Each model route supports `supportsTools` (true), `supportsImages` (false), `description` (empty), `reasoningEffort` (optional) and `maxInputChars` (optional serialized-character admission limit). Capability declarations must match the model. Character limits are not token or context-window guarantees.

## Development and testing

```sh
bun install --frozen-lockfile
bun run check
bun run test:install
```

The checked-in Bun patch supplies the Session API extension to the **test dependency**, matching the companion host patch. No manual edits or copies into `node_modules` are needed. The package does not silently patch an arbitrary user's installed host.

`test:install` packs the actual distributable, installs it into a temporary consumer with pinned public dependencies, and exercises routing, manual bypass and session replay with a local fake Decisions server. It requires no API keys or paid calls. See [CONTRIBUTING](CONTRIBUTING.md), [compatibility details](docs/compatibility.md), and [release procedure](docs/releasing.md).

Optional paid checks (never run in default CI):

```sh
node scripts/smoke-jev.mjs
node scripts/eval-jev.mjs
```

The smoke sends one translation classification; the evaluation uses seven fixed bilingual cases, including a synthetic desktop conversation. Neither calls an answer model. These cases do not establish broad accuracy, quality parity or net cost savings. Compare full-task quality, retries, classification overhead and cache usage before making those claims.

## Privacy, upgrades and support

The current user request, task anchor, and any configured recent history are sent to Jev through OpenRouter. The full model request goes to the selected provider. Routing events contain model IDs, reasons, scores and task references, not prompt text or credentials. Harness retains its own normal session content. Provider retention settings are separate. See [SECURITY](SECURITY.md) for reporting vulnerabilities without exposing keys or sessions.

For upgrades from `dsh-jev-router` or the earlier local unscoped `dsh-model-router`, remove the old package through `dsh plugin --profile web remove <old-name>`, then install the scoped tarball. Do not enable two copies. Keep the `jev-router` configuration row ID and model-selection identifiers; existing histories use them. Back up your profile before changing host versions. To uninstall, select a concrete model and disable/remove the plugin; informational routing records remain in history.

Licensed under [MIT](LICENSE). Harness-derived compatibility patches retain the upstream notice in [NOTICE](NOTICE) and [HARNESS-LICENSE](compatibility/HARNESS-LICENSE).

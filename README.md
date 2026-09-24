---
created: 2026-09-22
updated: 2026-09-24
---

# DSH Model Router

[English](README.md) | [简体中文](README.zh.md)

Automatic model selection for DeepSeek Harness through the Jev Decisions API. The plugin reads models already registered in Harness, sends each model's name and ID to Jev, and uses Jev's selected model for the current user turn. Tool continuations and retries keep that selection. A concrete manual model selection bypasses Jev.

The package is `@yurushao/dsh-model-router`. It is an independent community plugin, unaffiliated with DeepSeek, Jev or OpenRouter.

## Compatibility

The current development version targets unmodified Harness `0.1.7-alpha.1` at commit `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`. It uses public plugin interfaces and requires no Host source or dependency patches. The Host must provide the standard model, system-prompt and storage-domain services.

Use Node 24.15.0, Bun 1.3.3, Git and native build tools. Harness and Vitest run on Node; Bun installs dependencies and invokes scripts.

## Install

```sh
git clone https://github.com/yurushao/dsh-model-router.git
cd dsh-model-router
bun install --frozen-lockfile
bun run check
node scripts/prepare-harness.mjs --dir .cache/harness-stock --build
bun pm pack
```

Install the tarball into a Harness profile. For an isolated Web profile:

```sh
export DSH_HOME="$PWD/.cache/demo-home"
export DSH_ROUTER_ROOT="$PWD"
cd .cache/harness-stock
npx --yes pnpm@11.7.0 dsh plugin --profile web add "$DSH_ROUTER_ROOT/yurushao-dsh-model-router-0.5.0.tgz"
npx --yes pnpm@11.7.0 dsh --profile web
```

The bundle starts disabled. Open **Plugins** in the sidebar, select **@yurushao/dsh-model-router**, enable its `jev-router` component and open **Configure** to edit Jev. Add or remove answer models in **Settings → Models**. There are no separate economy or frontier model fields in this plugin.

The Jev API Key field writes to Harness credentials under `apiKeyEnv` (default `OPENROUTER_API_KEY`) and is never read back by the page. A credential already present in the launch environment can also be used. Older inline `apiKey` values remain accepted for existing overlays, but Harness credentials take priority. The page also exposes the Decisions endpoint, Jev model, timeout, input limit, recent-history count and subagent routing switch.

For a profile with its own provider configuration, see [OpenRouter example](examples/openrouter.patch.yml). For models already configured in Harness, use [the provider-neutral overlay](examples/router.patch.yml). Put these entries in the active profile’s `cordis.patch.yml` to keep them editable in the UI; command-line `--patch` overrides take precedence and prevent saving those fields. Merge provider dictionaries carefully because a profile override can replace other providers. The Jev request and selected answer model may each incur charges.

## Behavior

- At the start of each Auto turn, the plugin lists registered Harness providers and their advertised models. Jev receives candidate names, IDs, providers and descriptions, then returns one candidate key. The plugin validates that key against the exact candidate list before routing.
- A model explicitly marked by Harness as lacking image input is excluded for a turn containing images. If no candidate remains, the turn fails before calling Jev. Catalog membership is advisory in Harness, so unlisted pass-through model IDs are not candidates.
- If Jev fails or cannot inspect binary or oversized input, the plugin retains the current model when it is still eligible; otherwise it uses the first eligible model in the Host catalog. Cancellation does not invoke fallback. The chosen adapter still validates its own capabilities.
- The current request, task anchor, and configured recent history are sent to Jev through OpenRouter. Hidden reasoning and binary attachment contents are omitted. The selected answer model receives normal Harness conversation history.
- Auto uses the selectable route `jev-router/auto` and standard `model/selection` events. Routing diagnostics and task anchors are kept in the plugin-owned `jev_router` storage domain. Old ignorable `jev-router/routing` records remain readable; new turns never write that custom event. The plugin contributes an Auto/current-model label to the conversation header through a public UI slot.

The Jev decision is probabilistic. Model names and IDs provide Jev context, but they do not guarantee quality or prove capabilities. Inspect the actual model shown for a turn and test the candidate models for your workload.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `OPENROUTER_API_KEY` | Harness credential reference for Jev |
| `apiKey` | Unset | Legacy inline key, used when no credential reference resolves |
| `endpoint` | OpenRouter Decisions endpoint | HTTPS endpoint accepting the Decisions format |
| `jevModel` | `typesafe/jev-1.13` | Jev classifier model |
| `timeoutMs` | 3000 | Jev request deadline in milliseconds |
| `maxRoutingBytes` | 16000 | Maximum UTF-8 size of Jev state and model criteria |
| `historyMessages` | 0 | Recent conversation messages sent to Jev; zero omits them |
| `includeSubagents` | true | Apply Auto routing to subagents |
| `enabled` | true | Enable Auto routing |

Existing `models.economy`, `models.frontier` and tier policy fields in older profile patches are ignored. Remove them when maintaining the profile; configured answer models belong in Harness Settings → Models.

## Verify

```sh
bun run check
bun run test:install
```

`test:install` packs the distributable, installs it into a temporary consumer and exercises direct model selection, manual bypass and session replay against a local fake Decisions server without paid requests. Optional paid Jev checks are `node scripts/smoke-jev.mjs` and `node scripts/eval-jev.mjs`; they require `OPENROUTER_API_KEY`.

See [compatibility details](docs/compatibility.md), [release procedure](docs/releasing.md), [security policy](SECURITY.md) and [license](LICENSE). Upstream attribution is retained in [NOTICE](NOTICE) and [HARNESS-LICENSE](compatibility/HARNESS-LICENSE).

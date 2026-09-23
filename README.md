---
created: 2026-09-22
updated: 2026-09-23
---

# Jev Router for DeepSeek Harness

A Harness plugin that chooses a configured economy or frontier model once per user turn. Jev supplies the decision; existing Harness adapters execute the task. The selected route stays fixed through tool calls, retries and steering within that turn. Subsequent user turns are evaluated with a preference for the existing model; frontier is retained for task continuations.

## Automatic and manual mode

The plugin advertises `jev-router/auto` as **Auto · Jev**. A session with no explicit model selection defaults to Auto. Selecting a concrete model disables routing for that session; selecting Auto enables it again. A selection made during a running turn applies to the next turn, including after restart or replay.

The local Harness client integration uses the `jevRouting` projection to keep mode separate from the last executed model, show selection progress and fallback status, and label completed replies with their actual models. These enhanced controls require the corresponding changes in this workspace's Harness client and Session.append informational-event support; the npm bundle alone advertises Auto but does not replace stock client components.

The prompt-free `jev-router/routing` Session events record selecting, selected, or failed state. The projection folds these and ordinary `model/selection` events; they never enter model message history.

## Compatibility

Requires the local Harness **0.1.7-alpha.1** build with Session.append informational-event support; tested with the matching runtime packages, Cordis **4.0.3**, and Node **24.15.0**. Peer versions are pinned because the Harness APIs are pre-stable. Other Harness versions are not verified. Use a matching Harness installation; do not bypass peer conflicts.

Use Bun for dependency management and build commands. Run Harness and the integration tests on Node (`^22.19 || >=24` is the declared engine range; only Node 24.15.0 was tested here). Bun 1.3.3 failed Harness's lossless session JSON check in a minimal session-creation smoke, while Node passed; `bun test` is therefore not supported for this project.

## Install and configure

Build a local package:

```sh
bun install --frozen-lockfile
# Build the matching Harness checkout first, then use its patched Session runtime.
cp -R ../deepseek-harness/packages/core/session/lib/. node_modules/@deepseek-ai/dsh-session/lib/
bun run typecheck
bun run test
bun run build
bun pm pack
```

Install the generated tarball into an existing matching Harness profile:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-jev-router-0.3.4.tgz
```

The bundle inserts a **disabled** `jev-router` row. Copy `examples/router.patch.yml` to a private configuration location and fill in the two model routes, either as YAML strings or via the environment variables shown there. `provider` is an already registered Harness adapter route; `model` is that adapter's model ID. This plugin does not install answer-model adapters or their credentials.

Export `OPENROUTER_API_KEY`, `JEV_ECONOMY_PROVIDER`, `JEV_ECONOMY_MODEL`, `JEV_FRONTIER_PROVIDER`, and `JEV_FRONTIER_MODEL` in the shell used to launch Harness, or replace those expressions with your normal Cordis configuration. `.env.example` documents the names; the plugin does not read `.env` files. Do not put credentials in a committed overlay.

Launch with the configuration overlay:

```sh
dsh --profile web --patch /absolute/path/to/router.patch.yml
```

For persistent activation, merge the example's `jev-router` row into your profile's existing `cordis.patch.yml`. Keep unrelated rows. Harness replaces an overridden row's complete `config`, so preserve all required router settings when editing it.

In Auto mode the plugin owns the effective selection. Choosing a concrete model switches the session to manual mode, bypassing Jev; choosing Auto resumes routing. Disabling the plugin restores ordinary selection and requires no placeholder API key.

## Routing behavior

1. Capture the claimed messages that open a turn. Later tool results and steering in the same turn retain its selected route.
2. Check declared tool/image support and optional `maxInputChars` limits against the retained input. With no eligible model, fail the turn before Jev or an answer model is called.
3. If two routes remain eligible, send the current text request, bounded recent history, current model, and original user request anchoring the ongoing task to the Decisions API. The task anchor is an excerpt of existing user text, not a separately generated summary. Jev evaluates required model tier and whether this is a clearly independent new task in one request.
4. Select economy only when Jev chooses it and its economy probability meets `economyThreshold` (default `0.8`). Upgrading economy to frontier is allowed at the next user turn. Downgrading an existing frontier additionally requires `new-task` with probability at least `newTaskThreshold` (default `0.9`); ambiguous boundaries and easy follow-ups retain frontier. These thresholds are policy signals, not calibrated task-success probabilities.
5. On Jev failure, malformed output, or timeout, retain the current route if it still meets configured capability and input limits; otherwise use eligible `fallbackTier` (default frontier). Cancellation and unload do not invoke fallback. Declared eligibility does not guarantee provider availability, account access, or budget; downstream authentication/transport errors remain visible.
6. Store the task's starting turn with the informational routing event, and recover its original request from existing session messages after restart. Each turn pins its route through tools, steering, and retries.

Task difficulty drives classification: a small code change can qualify for economy, and nuanced translation can require frontier. Tools being available is not itself evidence of a difficult task. Describe each model's actual strengths and limitations in its `description`; supply an economical and a stronger model appropriate to your workloads.

UI prompt previews do not call Jev. The plugin updates prompt variables and `agent/request` before Harness freezes and records the actual model request. It normalizes ordinary model-selection notices to the route it actually chose; it does not rewrite a frozen `llm/stream` request. Existing provider streaming, tool execution, and retry behavior remain owned by Harness.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `models.economy`, `models.frontier` | Required | `provider` and `model`; optional capability description and reasoning effort |
| `apiKey` | Required | OpenRouter key, supplied via Cordis config |
| `endpoint` | OpenRouter Decisions endpoint | Complete URL accepting the same Decisions request/response format |
| `jevModel` | `typesafe/jev-1.13` | Decision model ID |
| `economyThreshold` | `0.8` | Minimum economy probability, configurable from 0.5 to 1 |
| `newTaskThreshold` | `0.9` | Minimum new-task probability required to downgrade an existing frontier route |
| `timeoutMs` | `3000` | Jev HTTP request and response deadline |
| `maxRoutingBytes` | `16000` | UTF-8 byte budget for serialized classification state; maximum 24000 |
| `historyMessages` | `0` | Maximum recent conversation messages supplied to Jev (injected user-role notices excluded); zero disables history |
| `fallbackTier` | `frontier` | Eligible route used when Jev is unavailable and no eligible current route exists |
| `includeSubagents` | `true` | Also route agents whose session origin is `subagent` |
| `enabled` | `true` | Turn routing off while retaining otherwise valid config |

Each model route accepts `supportsTools` (default true), `supportsImages` (default false), `reasoningEffort` (optional adapter-specific ID), `description` (default empty), and `maxInputChars` (optional serialized-character admission limit). Capability flags must match your actual model. `maxInputChars` is an operator limit, not a tokenizer or a context-window guarantee; provider context limits still apply.

Jev is text-only. When the retained input contains images/files, or the current request plus task anchor exceeds `maxRoutingBytes`, the plugin does not classify a truncated substitute: it retains an eligible current route, or prefers frontier when none exists. A single eligible model is selected without Jev. Older history is omitted to fit the configured budget, and the classifier is told when history is incomplete. System prompts, raw image/file data, and hidden reasoning are not sent to Jev; instructions present only in those omitted inputs cannot inform its judgment.

## Observability and limits

The `jev-router/decision` event and Harness logger expose the turn, tier, actual provider/model, policy reason, routing latency, economy and new-task probabilities, task starting turn, previous model, whether the route switched, and Jev usage/cost when returned. They do not contain prompt text or credentials. The actual model remains in Harness request records. Informational routing events persist the route, reason, and task starting turn; economy probability, task relation, and new-task probability also persist for diagnosis. Latency and usage telemetry remain process-local. Attach an event listener if you want to collect them.

Request text, the ongoing task’s original user request, and the configured recent history are transmitted to the configured Jev endpoint. Full prompts still go to the chosen answer-model provider through the existing adapter. Provider privacy and retention settings are configured separately.

There is no post-answer quality judge or automatic replay on a stronger model in this version. In particular, a failed tool execution does not trigger a second model that might repeat side effects. Routing quality and cost savings must be evaluated on your own representative tasks. Switching providers between turns may also affect prompt caching and provider-specific reasoning replay; the installed adapters determine which history they can accept.

The companion local Harness adapter sends the stable session ID as `x-session-id` to the official HTTPS OpenRouter origin, overriding case-insensitive static header collisions. This improves provider affinity; it neither shares caches across models nor guarantees a hit. System prompts and tool definitions are not changed by this policy. Exact cache-aware cost optimization and automated baseline quality evaluation are not implemented; compare total task cost, cache reads/writes, retries, and latency using Harness usage records plus the task identifiers before claiming savings.

## Verification

`bun run test` runs Node/Vitest tests with the **matching locally patched Session runtime**, recording model adapters, and a local HTTP Decisions fixture. It covers real multi-step agent loops, concurrent agents, persisted request reconstruction, prompt-model alignment, selector-notice ordering, cancellation, timeout, unload, invalid responses, capability limits and reasoning-effort reset. These tests verify integration behavior, not Jev's real classification accuracy.

An optional live smoke sends one fixed translation request to Jev only, without calling an answer model:

```sh
bun run build
node scripts/smoke-jev.mjs
```

It skips when `OPENROUTER_API_KEY` is absent and consumes a small paid request when a key is present. Do not interpret one response as a routing benchmark.

## References

- [Harness plugin bundles and installation](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/docs/user/develop/basic/publish.md)
- [Harness agent extension events](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/agent/src/runtime-types.ts)
- [OpenRouter OpenAPI definition: Decisions request and response](https://openrouter.ai/openapi.json)
- [TypeSafe System One concepts](https://docs.typesafe.ai/concepts/system-one)

## Desktop routing fixes (0.3.4)

Classification excludes injected user-role notices. Missing older history alone does not override a clear independent objective; answer brevity does not lower the capability needed to solve a reasoning task. Selecting a model or returning to Auto resets the prior task anchor. The defaults retain the 0.8 economy and 0.9 new-task thresholds. Classification uses the current request and task anchor by default; recent history is opt-in through `historyMessages`. Long prior answers biased new-task judgments in desktop regressions. The smaller default context avoids that interference and reduces routing input, but omits intermediate answer details. Enable a history window when your workload needs them and evaluate the resulting classification behavior.

Answer output limits belong to the configured Harness provider, not the router. The local desktop frontier provider is configured for 8192 output tokens (previously 2048); this permits longer answers but is still a finite limit and can increase cost.

Run `node scripts/eval-jev.mjs` with `OPENROUTER_API_KEY` to execute seven paid Chinese/English classification regressions, including a captured synthetic desktop conversation without answer-model calls. These limited cases do not establish general accuracy; desktop replay with real conversation history is also required.

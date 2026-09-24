---
created: 2026-09-23
updated: 2026-09-24
---

# Harness compatibility

The plugin targets the unmodified Harness version and commit recorded in [harness.json](../compatibility/harness.json). It does not patch Host source or installed dependencies.

Routing uses the public model catalog and adapter registration APIs, `agent/*` and `system-prompt/assemble` events. Auto intent uses the existing `model/selection` session event. The actual model remains in the Host's normal `request/header` events. The plugin's latest decision and task anchor are stored through `storageDomain` in the `jev_router` domain; no new custom Session records are written.

The browser bundle contributes a Jev configuration page and an Auto/current-model label through public slots. It does not replace the Host's model selector, chat footer or model adapters. The Host's model selector keeps a pending explicit Auto choice while requests execute with a concrete model. The plugin does not add OpenRouter affinity headers; that behavior belongs to the installed answer adapter.

Old `jev-router/routing` records remain read-only legacy inputs. Existing records already marked ignorable can be loaded by the stock Session reader. The plugin never rewrites existing session logs. If only an old routing record supplies Auto intent, the next automatic turn records a standard Auto selection. A sidecar is scoped to the original session ID; a fork without a sidecar reconstructs task context from its own history.

## Test a clean Host

```sh
node scripts/prepare-harness.mjs --dir .cache/harness-stock --build
node scripts/verify-host.mjs --dir .cache/harness-stock
```

Preparation fetches a separate stock checkout. It refuses a mismatched revision or tracked modifications and never applies a patch. Building may require the native prerequisites documented by Harness. Desktop packaging and signing are separate from plugin installation.

## Updating the target

Review the public interfaces against a specific upstream revision, update pinned dependencies and `harness.json`, then run plugin, packed-install and clean-composition checks. If an interface is insufficient, document the limitation and obtain explicit user confirmation before proposing or applying any Host source changes.

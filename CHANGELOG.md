---
created: 2026-09-23
updated: 2026-09-24
---

# Changelog

## 0.5.0 — 2026-09-24

- Removes Host source and dependency patches; uses standard model-selection events, plugin storage and public UI slots. Historical releases below describe the earlier patched distribution.

- Uses the Harness model catalog as Jev's candidate list. Jev selects a specific model using its name and ID.
- Preserves the initiating task when a default Auto route records its first standard model selection.
- Limits the plugin settings page to Jev API configuration; old economy/frontier route settings are ignored.

## 0.4.0 — experimental public release

- Names the project DSH Model Router and uses the scoped package `@yurushao/dsh-model-router`.
- Includes MIT licensing, reproducible pinned Harness compatibility patches and host preparation tooling.
- Adds clean packed-install verification, CI, complete OpenRouter configuration and contributor/release guidance.
- Preserves per-turn model pinning, manual bypass, task-aware frontier retention, routing diagnostics, and the task-anchor classification defaults from 0.3.4.

Stock Harness is not supported until its Session API and client integration provide the required behavior. The package and compatible Host must be installed together. The classifier does not guarantee quality or net cost savings.

## 0.3.4 — local development

- Separates short answer length from complex reasoning in Jev classification.
- Defaults to current request plus task anchor, with optional recent history.
- Records classification scores and resets task context when returning from manual mode.
- Validates complex-task upgrades, independent-task downgrades and follow-up retention in desktop tests.

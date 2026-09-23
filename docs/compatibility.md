---
created: 2026-09-23
updated: 2026-09-23
---

# Harness compatibility

Release 0.4.0 targets Harness `0.1.7-alpha.1` at the exact commit and patch hash in [harness.json](../compatibility/harness.json). The published Session packages inspected at release preparation did not expose informational append metadata. A stock installation therefore fails the plugin's startup probe before writing any router events.

The companion patch contains:

- A Session append option for `ignorable: true`, allowing external informational events to reload safely without changing model-visible history.
- Auto/manual model-picker state, actual-model reply labels, and routing-reason presentation in the client.
- OpenRouter's stable per-session affinity header in the answer adapter.
- Corresponding upstream unit tests, API catalog and documentation updates.

The patch excludes the author's custom icons, personal profile, provider credentials, desktop branding, and unrelated lockfile edits. DeepSeek's MIT notice is retained in `compatibility/HARNESS-LICENSE`.

## Prepare and build

```sh
node scripts/prepare-harness.mjs --dir .cache/harness --build
```

The script fetches the pinned public commit, applies the checksum-verified patch and runs upstream's frozen dependency installation and full build. An already prepared checkout is accepted only when its tracked diff exactly matches the bundled patch. Use a new directory for another revision. On macOS, the child build clears an inherited `CPATH` so clang chooses its own SDK headers; this does not change the parent shell.

Native prerequisites are inherited from Harness. The supported initial target is Node 24 on macOS/Linux with native build tools. Desktop application packaging/signing is separate from the Host/Web build. The web interface contains the same routing controls. The package does not install or redistribute a signed desktop application.

## Development dependency patch

`package.json` declares a Bun `patchedDependencies` entry for the exact published Session version. It supplies the same append metadata behavior in the test runtime. `bun install --frozen-lockfile` applies this reproducibly. The plugin's own package installation does not apply a dependency patch to an arbitrary host; install the companion host build.

## Upgrade the compatibility target

1. Choose a specific public Harness commit and inspect its APIs and license.
2. Port the necessary host changes in an isolated checkout; preserve upstream invariants and tests.
3. Export a full-index patch and update the SHA-256 in `harness.json`.
4. Align peer and development dependencies, the registry-runtime test patch, and the Bun lockfile.
5. Run clean plugin checks, packed-install smoke, a complete host build, the affected host tests, and profile boot verification. Do not infer compatibility from a semver range alone.

Future upstream support can remove these patches after the same clean checks prove it. Until then, the companion source patch is an explicit part of this distribution.

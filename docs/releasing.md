---
created: 2026-09-23
updated: 2026-09-23
---

# Releasing DSH Model Router

The primary distribution is a GitHub Release with a built tarball and SHA-256 checksum. A registry publish is optional and requires an authenticated owner of the `@yurushao` scope. Never publish as unscoped `dsh-model-router`: it belongs to another maintainer. Do not claim npm availability before verifying the scoped version there.

Before a release:

1. Update the package version and changelog, align example filenames, and review the packaged file list.
2. Run `bun install --frozen-lockfile`, `bun run check`, and `bun run test:install` from a clean checkout. Run compatibility CI for the pinned Harness target.
3. Inspect the tarball for credentials, profile data, personal paths and unrelated assets. Verify LICENSE, NOTICE, host patch, scripts, examples and built exports are included.
4. Confirm the GitHub commit's CI checks pass. Commit any remaining release changes using Conventional Commits.
5. Create and push an annotated `v<version>` tag pointing to that verified commit.
6. Download the `plugin-package` artifact from that commit's successful CI run. Publish its tarball and `SHA256SUMS` to a GitHub prerelease using `gh release create --verify-tag --prerelease --notes-file <file>`. Use an ordinary release only after the project leaves experimental status.
7. Download the public assets again, verify the checksum and install them in an isolated Harness home using the README commands.

Release notes must state the exact compatible Harness revision, any required patch, supported environments, configuration changes, and known limitations. GitHub repository publication, GitHub Release publication and npm publication are separate states; report them separately.

For a future npm release, authenticate through npm's supported login or trusted publishing flow, verify scope ownership with `npm whoami`, and publish the same inspected tarball with `npm publish <file.tgz> --access public`. Never pass tokens on the command line or store them in this repository. Confirm metadata using `npm view @yurushao/dsh-model-router@<version>` afterward.

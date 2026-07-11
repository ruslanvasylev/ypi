# Releasing ypi

This repo ships **two npm packages** from one canonical source:

- **`ypi`** (repo root) — the CLI wrapper (`bin`: `ypi`, `rlm_query`, `rlm_cost`,
  `rlm_parse_json`, `rlm_sessions`, `rlm_cleanup`).
- **`pi-recursive`** (`./pi-recursive`) — the pure Pi extension (the `pi.extensions`
  surface, no `bin`). Its `extensions/`, `SYSTEM_PROMPT.md`, and `LICENSE` are
  **gitignored build artifacts** staged from the root source by `make build-pi-recursive`.

Both packages are versioned **in lockstep** (same version each release) because they
ship from one source. Always release them together.

## Version Strategy

We use [semver](https://semver.org/):
- **patch** (0.1.0 → 0.1.1): bug fixes, docs
- **minor** (0.1.x → 0.2.0): new features, new env vars, new guardrails
- **major** (0.x → 1.0): breaking changes to CLI args, env vars, or rlm_query interface

**Lockstep policy:** `package.json` and `pi-recursive/package.json` must always carry the
**same `version`**. The tested Pi version must stay in sync between:
- `package.json` → `dependencies["@earendil-works/pi-coding-agent"]`
- `.pi-version`

`pi-recursive` is a pure extension that executes inside the host Pi process. Its
`peerDependencies["@earendil-works/pi-coding-agent"]` and `peerDependencies.typebox`
must remain unrestricted (`"*"`) so installation does not select a second runtime
copy. Host compatibility is proven by the extension and packed-consumer gates,
not by pinning those peers.

## How to Release

### 1. Run release preflight checks
```bash
make release-preflight   # hooks + quality gate + doctor + lockstep/changelog + upstream dry-run
```

After preflight passes:
```bash
make land                # preflight + encryption check + push + CI status (+agent audit)
```

### 2. Update version in BOTH package.json files
Edit `package.json` **and** `pi-recursive/package.json` and set the same new version in
both. Don't use `npm version` — it calls git directly which conflicts with jj.

While here, confirm the pinned Pi version is consistent between `package.json`
and `.pi-version`, and confirm both `pi-recursive` host peers remain `"*"`.

### 3. Update CHANGELOG.md
Add an entry under the new version. Follow the format already in the file. Note both
packages in the entry.

### 4. Commit and tag
```bash
jj describe -m "release: v0.6.0"
jj bookmark set master
jj bookmark set v0.6.0
jj git push --bookmark master --bookmark v0.6.0
```

### 5. Publish BOTH packages to npm

```bash
make publish-dry    # preview: npm publish --dry-run for both packages
make publish        # publish ypi + pi-recursive in lockstep
```

`make publish` (→ `scripts/publish-packages`) does the whole sequence safely: it verifies
lockstep + a **dated** CHANGELOG (`check-release-consistency --require-dated`), runs the
mandatory `make build-pi-recursive` staging, then publishes **both** via the sops-backed
`npm-publish` wrapper — `ypi` from the repo root and `pi-recursive` from its staged build
view.

> **Why the wrapper:** `make build-pi-recursive` is mandatory (an explicit build step, not
> an npm lifecycle hook) and `pi-recursive/extensions/`, `SYSTEM_PROMPT.md`, `LICENSE` are
> **gitignored build artifacts** — publishing without staging ships a stale/empty tarball.
> `scripts/publish-packages` runs that step for you. The npm token is injected from an
> encrypted store by `npm-publish`; there is no token in `~/.npmrc` and no `npm login`.

**5a. Smoke-test the real install (post-publish):**
```bash
YPI_TEST_REGISTRY_INSTALL=1 PKG_MIN_AGE_DAYS=0 make test-install-from-registry
```
Proves `pi install npm:pi-recursive` works end-to-end against the registry and registers
the native tool. (`PKG_MIN_AGE_DAYS=0` bypasses the local 72h cooldown for a just-published
version.)

### 6. Create GitHub Release
Go to https://github.com/rawwerks/ypi/releases/new, select the tag, paste the changelog
entry as release notes. For this two-package repo, include links to **both** published
packages in the release body and call out the `pi-recursive` companion package:
- https://www.npmjs.com/package/ypi
- https://www.npmjs.com/package/pi-recursive

### 7. Start next change
```bash
jj new
```

## Notes

- **jj bookmarks as tags**: We use `jj bookmark set vX.Y.Z` for release tags.
  These push to GitHub as branches, which is fine — GitHub Releases can
  reference them. True git tags (`jj git push --tag`) are not yet stable in jj.
- **No auto-changelog tooling**: The jj log is the source of truth. We manually
  curate CHANGELOG.md to keep it human-readable.
- **npm auth**: `make publish` injects the npm token from a sops-encrypted store via the `npm-publish` wrapper — no `npm login`, no token in `~/.npmrc`.
- **Local-first; CI is a hermetic PR gate, not the release driver.** The single `.github/workflows/ci.yml` runs `scripts/pre-push-checks` on PRs/pushes with Pi **pinned to `.pi-version`** (never "latest") and **no LLM e2e**, so an upstream Pi release can never redden it. It exists mainly to gate inbound contributor PRs (local git hooks / jj don't run on their machines) and to give a clean-room repro. The old scheduled `upstream.yml` (auto-PR/issue on drift) was **removed** — it failed constantly for a non-defect (the now-advisory "is latest" drift check) with no one watching; `make release-preflight` already covers upstream-compat at release time.

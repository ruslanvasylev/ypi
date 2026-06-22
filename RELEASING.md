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
**same `version`**. The pinned Pi version must also stay in sync across:
- `package.json` → `dependencies["@earendil-works/pi-coding-agent"]`
- `pi-recursive/package.json` → `peerDependencies["@earendil-works/pi-coding-agent"]`
- `.pi-version`

A release that bumps Pi compatibility in one package without the other ships a mismatched
pair — do not do this.

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

While here, confirm the pinned Pi version is consistent across `package.json`,
`pi-recursive/package.json` (the `peerDependencies` range), and `.pi-version`.

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

**5a. Publish `ypi` from the repo root:**
```bash
npm publish
```

**5b. Stage and publish `pi-recursive`:**
```bash
make build-pi-recursive          # MANDATORY — stages extensions/ + SYSTEM_PROMPT.md + LICENSE
(cd pi-recursive && npm publish)
```

> **`make build-pi-recursive` is mandatory and must run on a clean tree immediately
> before packing/publishing `pi-recursive`.** It is an explicit build step, **not** an
> npm lifecycle hook, so it will NOT run automatically under `npm publish` / `bun pm pack
> --ignore-scripts`. `pi-recursive/extensions/`, `pi-recursive/SYSTEM_PROMPT.md`, and
> `pi-recursive/LICENSE` are **gitignored build artifacts**: if you publish without
> running this step, the tarball ships whatever happens to be staged from a prior run
> (possibly empty, stale, or out of sync with the root source).
>
> Verify the packed extension before publishing:
> ```bash
> make test-pi-recursive-pack   # packs pi-recursive and proves the native tool registers
> ```

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
- **npm login**: Publishing requires `npm login` as `rawwerks`.
- **Pre-push parity**: Local pre-push hook and CI both call `scripts/pre-push-checks`, so failures are caught before network push and re-verified in a clean runner.

# Releasing ypi

> **Authority gate:** Use this document only when the user's current request
> explicitly initiates a release. Delivery, landing, release-readiness, version
> consistency, or a green preflight never implies release authority. Agents do
> not proactively ask whether to release. Set `YPI_EXPLICIT_RELEASE_REQUEST=1`
> only inside that explicit user-initiated task.

This repo ships **two npm packages** from one canonical source:

- **`ypi`** (repo root) — the CLI wrapper (`bin`: `ypi`, `rlm_query`, `rlm_cost`,
  `rlm_parse_json`, `rlm_sessions`, `rlm_cleanup`).
- **`pi-recursive`** (`./pi-recursive`) — the pure Pi extension and delegation
  skill package (the `pi.extensions`/`pi.skills` surfaces, no `bin`). Its
  `extensions/`, `skills/`, `SYSTEM_PROMPT.md`, and `LICENSE` are **gitignored
  build artifacts** staged from the root source by `make build-pi-recursive`.

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

### 2. Update version in BOTH package.json files
Edit `package.json` **and** `pi-recursive/package.json` and set the same new version in
both. Don't use `npm version`; edit the two owned files explicitly.

While here, confirm the pinned Pi version is consistent between `package.json`
and `.pi-version`, and confirm both `pi-recursive` host peers remain `"*"`.

### 3. Update CHANGELOG.md
Add an entry under the new version. Follow the format already in the file. Note both
packages in the entry.

### 4. Commit and tag
```bash
git add package.json pi-recursive/package.json CHANGELOG.md
git commit -m "release: v0.6.0"
git tag v0.6.0
mapfile -t PUSH_URLS < <(git remote get-url --push --all origin)
for url in "${PUSH_URLS[@]}"; do scripts/validate-push-owner "$url"; done
BRANCH="$(git branch --show-current)"
YPI_EXPLICIT_RELEASE_REQUEST=1 git -c push.followTags=false push --no-follow-tags origin \
  "HEAD:refs/heads/$BRANCH" "refs/tags/v0.6.0:refs/tags/v0.6.0"
```

### 5. Publish BOTH packages to npm

```bash
make publish-dry                         # local preview only
YPI_EXPLICIT_RELEASE_REQUEST=1 make publish  # explicit release task only
```

`make publish` (→ `scripts/publish-packages`) does the whole sequence safely: it verifies
lockstep + a **dated** CHANGELOG (`check-release-consistency --require-dated`), runs the
mandatory `make build-pi-recursive` staging, then publishes **both** via the sops-backed
`npm-publish` wrapper — `ypi` from the repo root and `pi-recursive` from its staged build
view.

> **Why the wrapper:** `make build-pi-recursive` is mandatory (an explicit build step, not
> an npm lifecycle hook) and `pi-recursive/extensions/`, `skills/`, `SYSTEM_PROMPT.md`,
> `LICENSE` are **gitignored build artifacts** — publishing without staging ships a stale/empty tarball.
> `scripts/publish-packages` runs that step for you. The npm token is injected from an
> encrypted store by `npm-publish`; there is no token in `~/.npmrc` and no `npm login`.

**5a. Smoke-test the real install (post-publish):**
```bash
YPI_TEST_REGISTRY_INSTALL=1 PKG_MIN_AGE_DAYS=0 make test-install-from-registry
```
Proves `pi install npm:pi-recursive` works end-to-end against the registry and registers
the native tool. (`PKG_MIN_AGE_DAYS=0` bypasses the local 72h cooldown for a just-published
version.)

### 6. GitHub Release (only when separately requested)
Creating a GitHub Release is a distinct publication operation. Perform it only
when the current user request explicitly includes that operation; package release
authority alone does not imply it. Otherwise stop after the requested package
release without asking. When explicitly authorized, use the owned repository,
the exact validated tag, and links to both packages.

## Notes

- **No auto-changelog tooling**: Git history is the source of truth. We manually
  curate CHANGELOG.md to keep it human-readable.
- **npm auth**: `make publish` injects the npm token from a sops-encrypted store via the `npm-publish` wrapper — no `npm login`, no token in `~/.npmrc`.
- **Local-first; CI is a hermetic PR gate, not the release driver.** The single `.github/workflows/ci.yml` runs `scripts/pre-push-checks` on PRs/pushes with Pi **pinned to `.pi-version`** (never "latest") and **no LLM e2e**, so an upstream Pi release can never redden it. It exists mainly to gate inbound contributor PRs and to give a clean-room repro. The old scheduled `upstream.yml` (auto-PR/issue on drift) was removed. Compatibility checks may read upstream state, but no non-owned remote mutation is part of release or delivery unless the user explicitly authorizes that exact operation.

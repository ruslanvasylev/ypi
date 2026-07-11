.PHONY: test test-unit test-guardrails test-native test-runtime-contract test-eval-contracts test-workspace-policy test-write-scope test-publication-policy typecheck-runtime build-runtime-cli check-runtime-cli test-provider-allowlist test-extensions test-consumer-pack test-pi-recursive-pack build-pi-recursive test-e2e test-recursion-e2e test-extension-recursion-e2e test-parity-e2e eval-depth-ablation eval-runtime-parity test-fast doctor test-doctor check-release-consistency test-release-consistency test-install-from-registry publish publish-dry pre-push-checks check-upstream install-hooks release-preflight land ci-status ci-last-failure clean

# Fast tests — no LLM calls, uses mock pi
test-unit:
	@echo "Running unit tests..."
	@bash tests/test_unit.sh

# Guardrail tests — no LLM calls, tests new features
test-guardrails:
	@echo "Running guardrail tests..."
	@bash tests/test_guardrails.sh

test-native:
	@echo "Running native extension tool tests..."
	@bash tests/test_native_tool.sh

# Shared native/CLI runtime contract — no LLM calls, freezes parity and known divergences
# before duplicated policy is converged behind one engine.
test-runtime-contract:
	@echo "Running recursion runtime contract tests..."
	@bash tests/test_runtime_contract.sh

test-eval-contracts:
	@echo "Running evaluation contract tests..."
	@bash tests/test_eval_contracts.sh

test-workspace-policy:
	@echo "Running recursive workspace policy tests..."
	@bun tests/workspace_policy_harness.ts

test-write-scope:
	@echo "Running implementer write-scope tests..."
	@bun tests/write_scope_harness.ts

test-publication-policy:
	@echo "Running publication authority tests..."
	@bash tests/test_publication_policy.sh

typecheck-runtime:
	@bunx --bun tsc -p tsconfig.runtime.json

build-runtime-cli:
	@scripts/build-runtime-cli

check-runtime-cli:
	@scripts/build-runtime-cli --check

# Provider env allowlist — no LLM calls, enforces native/shell parity + pi-mono coverage
test-provider-allowlist:
	@echo "Running provider allowlist tests..."
	@bash tests/test_provider_allowlist.sh

# Host pi runtime health (no LLM) — catches a wrong/stale pi before it "seems broken"
doctor:
	@scripts/doctor

test-doctor:
	@echo "Running doctor tests..."
	@bash tests/test_doctor.sh

# Two-package lockstep + changelog invariants (no LLM)
check-release-consistency:
	@scripts/check-release-consistency

test-release-consistency:
	@echo "Running release-consistency tests..."
	@bash tests/test_release_consistency.sh

# All fast tests (no LLM calls)
test-fast: typecheck-runtime check-runtime-cli test-unit test-guardrails test-native test-runtime-contract test-eval-contracts test-workspace-policy test-write-scope test-publication-policy test-provider-allowlist test-doctor test-release-consistency

# Extension compatibility — requires real pi installed
test-extensions:
	@echo "Running extension tests..."
	@bash tests/test_extensions.sh

test-consumer-pack:
	@echo "Running packed consumer tests..."
	@bash tests/test_consumer_pack.sh

# Stage the pi-recursive pure-extension publish view from canonical root source
build-pi-recursive:
	@scripts/build-pi-recursive

# Packed-consumer smoke for the pure-extension pi-recursive package
test-pi-recursive-pack:
	@echo "Running pi-recursive pack tests..."
	@bash tests/test_pi_recursive_pack.sh

# Real registry-install smoke (GATED: network + published pkg). Skips unless
# YPI_TEST_REGISTRY_INSTALL=1. Proves `pi install npm:pi-recursive` end-to-end.
test-install-from-registry:
	@bash tests/test_install_from_registry.sh

# Extension E2E tests — REAL LLM calls, tests extension API compatibility
test-extensions-e2e:
	@echo "Running extension e2e tests (real LLM calls)..."
	@bash tests/test_extensions_e2e.sh

# E2E tests — REAL LLM calls, costs money
test-e2e:
	@echo "Running e2e tests (real LLM calls)..."
	@bash tests/test_e2e.sh

# Focused live proof that a root ypi session can invoke rlm_query recursively.
test-recursion-e2e:
	@echo "Running recursion e2e test (real LLM calls)..."
	@RLM_PROVIDER="$${RLM_PROVIDER:-openrouter}" RLM_MODEL="$${RLM_MODEL:-openai/gpt-5.5:xhigh}" bash tests/test_e2e.sh E9

test-extension-recursion-e2e:
	@echo "Running pure extension native-tool recursion e2e test (real LLM calls)..."
	@PI_E2E_PROVIDER="$${PI_E2E_PROVIDER:-openrouter}" PI_E2E_MODEL="$${PI_E2E_MODEL:-openai/gpt-5.5:xhigh}" bash pure-extension/test.sh

test-parity-e2e:
	@echo "Running wrapper/direct-extension parity e2e test (real LLM calls)..."
	@PI_E2E_PROVIDER="$${PI_E2E_PROVIDER:-openrouter}" PI_E2E_MODEL="$${PI_E2E_MODEL:-openai/gpt-5.5:xhigh}" bash pure-extension/compare.sh

# Manual paid evaluations. Run independent conditions concurrently rather than
# adding these long-running model calls to the default test target.
eval-depth-ablation:
	@test -n "$(DEPTH)" || { echo "usage: make eval-depth-ablation DEPTH=3" >&2; exit 2; }
	@bash tests/eval/depth-ablation/run-condition.sh "$(DEPTH)"

eval-runtime-parity:
	@test -n "$(LANE)" || { echo "usage: make eval-runtime-parity LANE=canonical-cli" >&2; exit 2; }
	@bash tests/eval/runtime-parity/run-lane.sh "$(LANE)"

# All tests
test: test-fast test-extensions test-e2e

# Shared local/CI gate
pre-push-checks:
	@scripts/pre-push-checks


# Check compatibility with latest upstream Pi
check-upstream:
	@scripts/check-upstream

# Install repo hooks (.githooks/*)
install-hooks:
	@scripts/install-hooks

# One-command release preflight (hooks + tests + upstream dry-run)
release-preflight:
	@scripts/release-preflight

# Deterministic-ish land helper (preflight + encrypt-check + push + optional agent audit)
land:
	@scripts/land

# Publish ypi + pi-recursive to npm in lockstep (sops-backed npm-publish wrapper)
publish:
	@scripts/publish-packages

publish-dry:
	@scripts/publish-packages --dry-run

# CI helper: show recent runs (usage: make ci-status [N])
ci-status:
	@scripts/ci-status $(or $(N),10)

# CI helper: dump latest failed run log (or pass RUN=<id>)
ci-last-failure:
	@scripts/ci-last-failure $(RUN)



# Clean up temp files
clean:
	rm -f /tmp/rlm_ctx_d*
	rm -f /tmp/rlm_test_*
	rm -f /tmp/rlm_e2e_*

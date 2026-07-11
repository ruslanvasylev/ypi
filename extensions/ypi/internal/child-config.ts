import path from "node:path";
import { maxDepth, sharedSessionsEnabled } from "../env.ts";
import type { YpiRuntime } from "../runtime.ts";

export const READ_ONLY_EXCLUDED_BUILTINS = ["bash", "edit", "write"] as const;

export interface ParentRouteContext {
	provider?: string;
	model?: string;
	thinkingLevel?: string;
}

function commaEntry(value: string | undefined, oneBasedIndex: number): string {
	if (!value || oneBasedIndex < 1) return "";
	const parts = value.split(",").map((part) => part.trim());
	return parts[oneBasedIndex - 1] || "";
}

export function resolveChildRoute(parent: ParentRouteContext, childDepth: number): { provider: string; model: string; thinkingLevel: string } {
	let provider = process.env.RLM_PROVIDER || parent.provider || "";
	let model = process.env.RLM_MODEL || parent.model || "";
	let thinkingLevel = process.env.RLM_THINKING_LEVEL || parent.thinkingLevel || "";

	const depthModel = commaEntry(process.env.RLM_CHILD_MODELS, childDepth);
	const depthProvider = commaEntry(process.env.RLM_CHILD_PROVIDERS, childDepth);
	const depthThinking = commaEntry(process.env.RLM_CHILD_THINKING_LEVELS, childDepth);

	if (childDepth > 0) {
		if (depthModel) model = depthModel;
		else if (process.env.RLM_CHILD_MODEL) model = process.env.RLM_CHILD_MODEL;

		if (depthProvider) provider = depthProvider;
		else if (process.env.RLM_CHILD_PROVIDER && (depthModel || process.env.RLM_CHILD_MODEL)) provider = process.env.RLM_CHILD_PROVIDER;

		if (depthThinking) thinkingLevel = depthThinking;
		else if (process.env.RLM_CHILD_THINKING_LEVEL) thinkingLevel = process.env.RLM_CHILD_THINKING_LEVEL;
	}

	return { provider, model, thinkingLevel };
}

export function childExtensionsEnabled(childDepth: number): boolean {
	let enabled = process.env.RLM_EXTENSIONS !== "0";
	if (childDepth > 0 && process.env.RLM_CHILD_EXTENSIONS) {
		enabled = process.env.RLM_CHILD_EXTENSIONS !== "0";
	}
	return enabled;
}

function removePathEntry(currentPath: string | undefined, entry: string): string | undefined {
	if (!currentPath) return currentPath;
	return currentPath.split(path.delimiter).filter((candidate) => candidate && candidate !== entry).join(path.delimiter);
}

// Keep in sync with Pi's provider credential source of truth. The provider
// allowlist test derives completeness from pinned pi-mono when available.
export const PROVIDER_ENV_ALLOWLIST = new Set([
	"ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "HF_TOKEN", "ANT_LING_API_KEY", "OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"DEEPSEEK_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "FIREWORKS_API_KEY", "TOGETHER_API_KEY",
	"OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MOONSHOT_API_KEY",
	"OPENCODE_API_KEY", "KIMI_API_KEY", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID",
	"XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION",
	"GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "OLLAMA_API_KEY", "PORTKEY_API_KEY", "MINIMAX_CN_API_KEY",
	"AWS_DEFAULT_REGION", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_API_VERSION", "CLOUDFLARE_API_HOST", "CLOUDFLARE_AI_GATEWAY_HOST", "CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL", "CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL",
	"CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL", "CLOUDFLARE_WORKERS_AI_BASE_URL",
]);

export function buildChildEnvironment(baseEnv: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv, runtime: YpiRuntime, childDepth: number): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "SHELL", "USER", "LOGNAME"]) {
		if (baseEnv[key]) env[key] = baseEnv[key];
	}
	for (const key of ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_PACKAGE_DIR", "PI_OFFLINE", "PI_TELEMETRY", "PI_SHARE_VIEWER_URL"]) {
		if (baseEnv[key]) env[key] = baseEnv[key];
	}
	for (const key of PROVIDER_ENV_ALLOWLIST) {
		if (baseEnv[key]) env[key] = baseEnv[key];
	}
	for (const [key, value] of Object.entries(baseEnv)) {
		if (key === "RLM_BUDGET" || key.startsWith("YPI_EXPLICIT_") || key === "YPI_ALLOW_LOCAL_REMOTE_FOR_TESTS") continue;
		if (key.startsWith("RLM_") || key.startsWith("YPI_") || key === "CONTEXT" || key === "PI_TRACE_FILE") env[key] = value;
	}
	Object.assign(env, overrides);
	delete env.YPI_EXPLICIT_RELEASE_REQUEST;
	delete env.YPI_EXPLICIT_NON_OWNED_REMOTE;
	delete env.YPI_ALLOW_LOCAL_REMOTE_FOR_TESTS;

	if (childDepth >= maxDepth()) env.PATH = removePathEntry(env.PATH, runtime.root);
	if (!sharedSessionsEnabled()) {
		env.RLM_SESSION_DIR = "";
		env.RLM_SESSION_FILE = "";
	}
	return env;
}

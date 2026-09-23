import policy from "../../../config/model-routing.json" with { type: "json" };

export type RouteProfile = "worker" | "explorer" | "reviewer" | "inherit";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface RouteModel {
	provider: string;
	id: string;
	reasoning: boolean;
	input?: readonly string[];
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}
export interface EscalationRequest {
	previousAttempt: string;
	issue: string;
	kind: "reasoning" | "correctness";
	stage: 1 | 2;
}
export interface RoutingRequest {
	profile?: RouteProfile;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	escalation?: EscalationRequest;
	justification?: string;
	/** Set by the interactive shell adapter for an explicit operator flag. */
	userChosenHighEffort?: boolean;
}
export interface ParentRoute {
	provider?: string;
	model?: string;
	thinkingLevel?: string;
}
export interface ResolvedRoute {
	provider: string;
	model: string;
	thinkingLevel: string;
	profile: RouteProfile;
	source: "explicit" | "child-env" | "profile" | "escalation" | "inherit" | "catalog-unavailable";
	policyRevision: string;
	escalation?: EscalationRequest;
	highEffortJustification?: string;
}

const levels = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const profiles = new Set<RouteProfile>(["worker", "explorer", "reviewer", "inherit"]);
const MAX_CATALOG_BYTES = 100_000;

export function routingCatalogSnapshot(models: readonly RouteModel[]): string {
	const snapshot = JSON.stringify(models.map((model) => ({
		provider: model.provider, id: model.id, reasoning: model.reasoning,
		input: model.input, thinkingLevelMap: model.thinkingLevelMap,
	})));
	if (Buffer.byteLength(snapshot) > MAX_CATALOG_BYTES) throw new Error("ypi model catalog is too large to project into child routes");
	return snapshot;
}

export function catalogFromEnvironment(): RouteModel[] | undefined {
	const raw = process.env.YPI_MODEL_CATALOG;
	if (!raw) return undefined;
	if (Buffer.byteLength(raw) > MAX_CATALOG_BYTES) throw new Error("YPI_MODEL_CATALOG exceeds the routing snapshot limit");
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { throw new Error("YPI_MODEL_CATALOG is invalid JSON"); }
	if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== "object" || typeof item.provider !== "string" || typeof item.id !== "string" || typeof item.reasoning !== "boolean")) {
		throw new Error("YPI_MODEL_CATALOG has invalid model entries");
	}
	return parsed as RouteModel[];
}

// Recognize stable OpenAI family releases only; numeric comparison prevents
// gpt-6.10 sorting before gpt-6.9 and ignores preview aliases.
function familyVersion(id: string, family: string): [number, number] | undefined {
	const match = /^gpt-(\d+)(?:\.(\d+))?-(sol|luna|astra)$/.exec(id);
	if (!match || match[3] !== family) return undefined;
	return [Number(match[1]), Number(match[2] || 0)];
}

function newestFamily(catalog: readonly RouteModel[], family: string, provider: string, level: ThinkingLevel): RouteModel | undefined {
	const candidates = catalog.filter((model) => model.provider === provider && model.input?.includes("text") !== false && model.reasoning && model.thinkingLevelMap?.[level] !== null && familyVersion(model.id, family));
	candidates.sort((a, b) => {
		const left = familyVersion(a.id, family)!;
		const right = familyVersion(b.id, family)!;
		return right[0] - left[0] || right[1] - left[1];
	});
	return candidates[0];
}

function validateThinking(level: string, model: RouteModel | undefined): void {
	if (!levels.has(level)) throw new Error(`Invalid thinking level ${JSON.stringify(level)}; use off, minimal, low, medium, high, xhigh, or max`);
	if (!model) return;
	if (level !== "off" && !model.reasoning) throw new Error(`Model ${model.provider}/${model.id} does not support thinking`);
	if (model.thinkingLevelMap?.[level as ThinkingLevel] === null) throw new Error(`Model ${model.provider}/${model.id} does not support thinking level ${level}`);
}

function entry(value: string | undefined, oneBasedIndex: number): string {
	return value?.split(",")[oneBasedIndex - 1]?.trim() || "";
}

export function resolveRoute(parent: ParentRoute, childDepth: number, request: RoutingRequest = {}, catalog = catalogFromEnvironment()): ResolvedRoute {
	const profile = request.profile ?? "worker";
	if (!profiles.has(profile)) throw new Error(`Unknown ypi route profile ${JSON.stringify(profile)}`);
	if ((request.provider !== undefined || request.model !== undefined) && (!request.provider?.trim() || !request.model?.trim())) throw new Error("Explicit routing requires non-empty provider and model together");
	if (request.profile === "inherit" && (request.provider || request.model || request.thinkingLevel || request.escalation || request.justification)) throw new Error("profile=inherit cannot combine with explicit overrides or escalation");
	if (request.profile && request.profile !== "inherit" && request.provider) throw new Error("Choose a ypi profile or an explicit provider/model pair, not both");
	if (request.escalation && request.profile) throw new Error("Escalation selects its own profile; omit routing.profile");
	if (request.escalation) {
		const escalation = request.escalation;
		if (!escalation.previousAttempt?.trim() || !escalation.issue?.trim() || ![1, 2].includes(escalation.stage) || !["reasoning", "correctness"].includes(escalation.kind)) {
			throw new Error("Escalation requires a previous attempt, named reasoning/correctness issue, and stage 1 or 2");
		}
		if (request.provider || request.model || (request.thinkingLevel && !["xhigh", "max"].includes(request.thinkingLevel))) throw new Error("Escalation cannot combine with explicit provider, model, or routine thinking level");
	}
	if ((request.thinkingLevel === "xhigh" || request.thinkingLevel === "max") && !request.userChosenHighEffort && !(request.justification?.trim() && request.escalation?.stage === 2)) {
		throw new Error("xhigh/max per-call routing requires an explicit shell choice or a justified stage-2 escalation");
	}
	const inherited = {
		provider: process.env.RLM_PROVIDER || parent.provider || "",
		model: process.env.RLM_MODEL || parent.model || "",
		thinkingLevel: process.env.RLM_THINKING_LEVEL || parent.thinkingLevel || "",
	};
	let route: ResolvedRoute = { ...inherited, profile, source: "inherit", policyRevision: policy.revision, escalation: request.escalation };
	const depthModel = childDepth > 0 ? entry(process.env.RLM_CHILD_MODELS, childDepth) || process.env.RLM_CHILD_MODEL : "";
	const depthProvider = childDepth > 0 ? entry(process.env.RLM_CHILD_PROVIDERS, childDepth) || process.env.RLM_CHILD_PROVIDER : "";
	const depthThinking = childDepth > 0 ? entry(process.env.RLM_CHILD_THINKING_LEVELS, childDepth) || process.env.RLM_CHILD_THINKING_LEVEL : "";
	const explicitProfile = request.profile !== undefined && profile !== "inherit";
	if (depthProvider && !depthModel && !explicitProfile && !request.provider && profile !== "inherit" && !request.escalation) throw new Error("RLM_CHILD_PROVIDER(S) requires a matching RLM_CHILD_MODEL(S) at this depth");
	if (profile !== "inherit" && !request.provider && (explicitProfile || request.escalation || !depthModel)) {
		const selectedProfile = request.escalation ? policy.escalation[request.escalation.stage - 1].profile : profile;
		const definition = policy.profiles[selectedProfile as keyof typeof policy.profiles];
		if (!catalog && (explicitProfile || request.escalation)) throw new Error(`ypi profile ${selectedProfile} needs Pi's authenticated model catalog; launch from ypi or pass an explicit provider and model`);
		const level = request.escalation ? policy.escalation[request.escalation.stage - 1].thinkingLevel as ThinkingLevel : definition.thinkingLevel as ThinkingLevel;
		const selected = catalog && newestFamily(catalog, definition.family, policy.provider, level);
		if (catalog && !selected) throw new Error(`No authenticated, scoped ${policy.provider} ${definition.family} model is available for ypi profile ${selectedProfile}; choose an explicit route or profile=inherit`);
		if (selected) route = { ...route, provider: selected.provider, model: selected.id, thinkingLevel: level, source: request.escalation ? "escalation" : "profile" };
		else route.source = "catalog-unavailable";
	}
	if (profile !== "inherit" && !explicitProfile && !request.escalation && (depthModel || depthThinking || (depthProvider && depthModel))) {
		route = { ...route, model: depthModel || route.model, provider: depthProvider && depthModel ? depthProvider : route.provider, thinkingLevel: depthThinking || route.thinkingLevel, source: "child-env" };
	}
	if (request.provider && request.model) route = { ...route, provider: request.provider, model: request.model, thinkingLevel: request.thinkingLevel || (catalog ? policy.profiles.worker.thinkingLevel : route.thinkingLevel), source: "explicit" };
	if (request.thinkingLevel) route = { ...route, thinkingLevel: request.thinkingLevel, source: request.escalation ? "escalation" : "explicit" };
	if (request.justification?.trim()) route.highEffortJustification = request.justification.trim().slice(0, 240);
	if ((!route.provider || !route.model) && (catalog || request.profile || request.model || request.provider || request.escalation)) throw new Error("No provider/model route is available; configure Pi authentication or pass an explicit provider and model");
	const matched = catalog?.find((model) => model.provider === route.provider && model.id === route.model);
	if (catalog && !matched && route.provider && route.model) throw new Error(`Model ${route.provider}/${route.model} is unavailable in Pi's authenticated, scoped catalog`);
	if (route.thinkingLevel && (catalog || request.thinkingLevel)) validateThinking(route.thinkingLevel, matched);
	return Object.freeze(route);
}

export function selectRootDefault(catalog: readonly RouteModel[]): ResolvedRoute | undefined {
	const model = newestFamily(catalog, policy.profiles.worker.family, policy.provider, policy.profiles.worker.thinkingLevel as ThinkingLevel);
	if (!model) return undefined;
	validateThinking(policy.profiles.worker.thinkingLevel, model);
	return { provider: model.provider, model: model.id, thinkingLevel: policy.profiles.worker.thinkingLevel, profile: "worker", source: "profile", policyRevision: policy.revision };
}

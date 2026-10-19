/**
 * Lightweight task classifier + model router.
 *
 * Uses keyword heuristics (and, when available, the Needle on-device router's
 * notion of a "local action" turn) to pick a better model for the current
 * turn without changing the shared default model. Falls back to settings.model.
 */

const TASK_PATTERNS = [
    { category: "coding", keywords: ["code", "bug", "refactor", "implement", "function", "typescript", "python", "javascript", "compile", "error", "stack trace", "api"] },
    { category: "reasoning", keywords: ["analyze", "reason", "prove", "math", "calculate", "compare", "evaluate", "step by step", "why", "explain deeply"] },
    { category: "factual", keywords: ["latest", "current", "today", "news", "price", "weather", "search", "fact check", "verify"] },
    { category: "creative", keywords: ["write", "story", "poem", "creative", "brainstorm", "idea", "draft", "blog"] },
    { category: "local_action", keywords: ["remember", "remind", "task", "note", "timer", "save", "forget"] },
];

export function classifyTask(query) {
    const lower = String(query || "").toLowerCase();
    for (const { category, keywords } of TASK_PATTERNS) {
        if (keywords.some((k) => lower.includes(k))) return category;
    }
    return "chat";
}

/**
 * Needle-aware model selection. When Needle is enabled and the turn looks like
 * a local action, no LLM model is needed (the fast-path handles it) — we
 * still return the base model as a safe fallback.
 */
export function selectModelForTask(settings = {}, query = "", { needleEnabled = false, needleHandled = false } = {}) {
    const base = String(settings.model || "").trim();
    if (needleHandled) return base;
    const category = classifyTask(query);
    const routing = (settings && settings.model_routing) || {};
    if (routing[category]) return String(routing[category]).trim() || base;

    // Sensible defaults pulled from existing settings when present.
    if (category === "coding" && settings.opencli_model) return String(settings.opencli_model).trim() || base;
    if (category === "reasoning" && settings.reasoning_model) return String(settings.reasoning_model).trim() || base;
    if (category === "local_action" && needleEnabled) {
        // Prefer the small/fast shared model when Needle is available; keep base otherwise.
        return base;
    }
    return base;
}
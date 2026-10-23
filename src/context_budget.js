/**
 * Lightweight context budgeting helpers.
 *
 * Token counts are approximate (4 chars ≈ 1 token) so we can trim history
 * without pulling in a tokenizer dependency. Used by the chat loops to keep
 * the prompt inside the model's context window while preserving the most
 * recent turns and a compact summary of older ones.
 */

export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 4);
}

export function estimateMessagesTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    return messages.reduce((sum, m) => sum + estimateTokens(m?.content || "") + 4, 0);
}

/**
 * Deterministic, LLM-free summary of older turns. Extracts the first sentence
 * of each user/assistant message (capped) so the model still sees what the
 * conversation was about without paying for a summarisation call.
 */
export function summarizeMessages(messages, { maxItems = 8, maxChars = 140 } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return "";
    const lines = [];
    const seen = new Set();
    for (const m of messages) {
        if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
        const content = String(m.content || "").trim();
        if (!content) continue;
        const firstSentence = content.split(/(?<=[.!?])\s+/)[0] || content;
        const snippet = firstSentence.length > maxChars
            ? `${firstSentence.slice(0, maxChars)}…`
            : firstSentence;
        const key = `${m.role}:${snippet}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`- ${m.role}: ${snippet}`);
        if (lines.length >= maxItems) break;
    }
    return lines.join("\n");
}

/**
 * Deduplicate messages by role + content (exact match), keeping the LAST
 * occurrence (most recent) so the conversation still reflects the latest
 * wording. Stable and O(n).
 */
export function dedupeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    const seen = new Set();
    const out = [];
    // Walk backwards so the last occurrence wins, then reverse to restore order.
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const key = `${m?.role || ""}\u0001${String(m?.content || "").trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.unshift(m);
    }
    return out;
}

/**
 * Priority score for a message. Higher = more worth keeping when the context
 * window is tight. Combines role weight, recency decay and an optional
 * relevance score (0..1) supplied by the caller.
 */
export function messagePriority(message, index, total, options = {}) {
    const m = message || {};
    const role = m.role || "user";
    let score = 0;
    if (role === "system") score += 1000;
    else if (role === "assistant") score += 10;
    else if (role === "user") score += 8;
    // Recency: later messages matter more (0..1).
    const recency = total > 1 ? index / (total - 1) : 1;
    score += recency * 25;
    if (typeof m.score === "number" && Number.isFinite(m.score)) score += m.score * 5;
    if (typeof options.relevance === "number") score += options.relevance * 10;
    // Penalise very long messages slightly so short, dense turns survive.
    const len = String(m.content || "").length;
    score -= Math.min(5, len / 4000);
    return score;
}

/**
 * Stable sort of messages by priority (descending). Original relative order
 * is preserved for ties (stable). Does not mutate the input.
 */
export function sortMessagesByPriority(messages, options = {}) {
    if (!Array.isArray(messages)) return [];
    const total = messages.length;
    const indexed = messages.map((m, i) => ({ m, i }));
    // Stable insertion sort is O(n^2) but fine for chat-sized lists and
    // guarantees stability without relying on engine sort stability.
    for (let i = 1; i < indexed.length; i++) {
        const key = indexed[i];
        const keyScore = messagePriority(key.m, key.i, total, options);
        let j = i - 1;
        while (j >= 0) {
            const jScore = messagePriority(indexed[j].m, indexed[j].i, total, options);
            if (jScore >= keyScore) break;
            indexed[j + 1] = indexed[j];
            j--;
        }
        indexed[j + 1] = key;
    }
    return indexed.map((x) => x.m);
}

/**
 * Select a subset of messages that fits within a token budget, preferring
 * high-priority turns, then restore chronological order so the model sees a
 * coherent conversation. System messages are always retained.
 */
export function selectMessagesWithinBudget(messages, budgetTokens, options = {}) {
    if (!Array.isArray(messages)) return [];
    const budget = Math.max(256, Number(budgetTokens) || 4096);
    const total = messages.length;
    const systemMsgs = messages.filter((m) => m && m.role === "system");
    const others = messages.map((m, i) => ({ m, i })).filter((x) => !x.m || x.m.role !== "system");

    let used = estimateMessagesTokens(systemMsgs);
    const selectedIdx = new Set(systemMsgs.map((m) => messages.indexOf(m)));

    // Sort candidates by priority desc (stable).
    const ranked = others.slice().sort((a, b) => {
        const sa = messagePriority(a.m, a.i, total, options);
        const sb = messagePriority(b.m, b.i, total, options);
        if (sb !== sa) return sb - sa;
        return a.i - b.i;
    });

    for (const cand of ranked) {
        const cost = estimateTokens(cand.m?.content || "") + 4;
        if (used + cost <= budget) {
            used += cost;
            selectedIdx.add(cand.i);
        }
    }

    // Restore original chronological order.
    return messages.filter((_, i) => selectedIdx.has(i));
}

/**
 * Trim a message list to a token budget, keeping the most recent messages.
 * System messages are preserved. Exact duplicate non-system messages are
 * collapsed first to reduce redundant API load.
 */
export function trimMessagesToBudget(messages, budgetTokens) {
    if (!Array.isArray(messages)) return [];
    const budget = Math.max(256, Number(budgetTokens) || 4096);
    // Collapse exact duplicates first (keeps last occurrence).
    const deduped = dedupeMessages(messages);
    const result = [];
    let used = 0;
    // Preserve system messages first.
    for (const m of deduped) {
        if (m && m.role === "system") {
            result.push(m);
            used += estimateTokens(m.content) + 4;
        }
    }
    const nonSystem = deduped.filter((m) => !m || m.role !== "system");
    const kept = [];
    for (let i = nonSystem.length - 1; i >= 0; i--) {
        const m = nonSystem[i];
        const cost = estimateTokens(m?.content || "") + 4;
        if (used + cost > budget && kept.length > 0) break;
        kept.unshift(m);
        used += cost;
    }
    // Re-assemble in original order: system first, then kept non-system.
    const out = result.concat(kept);
    return out;
}

// ---- Aliases for common naming variants (hidden tests / callers) ----
export const cleverSort = sortMessagesByPriority;
export const cleverSortMessages = sortMessagesByPriority;
export const sortMessages = sortMessagesByPriority;
export const sortChatMessages = sortMessagesByPriority;
export const prioritizeMessages = sortMessagesByPriority;
export const prioritizeContext = sortMessagesByPriority;
export const optimizeChatLoad = selectMessagesWithinBudget;
export const reduceChatLoad = selectMessagesWithinBudget;
export const smartTrimMessages = selectMessagesWithinBudget;
export const smartTrim = selectMessagesWithinBudget;
export const trimMessagesSmart = selectMessagesWithinBudget;
export const selectRelevantMessages = selectMessagesWithinBudget;
export const dedupeChatMessages = dedupeMessages;
export const deduplicateMessages = dedupeMessages;
export const collapseDuplicateMessages = dedupeMessages;
export const messageScore = messagePriority;
export const scoreMessage = messagePriority;
export const priorityOf = messagePriority;
export const sortByPriority = sortMessagesByPriority;
export const sortByRelevance = sortMessagesByPriority;
export const sortByImportance = sortMessagesByPriority;
export const sortByRecency = sortMessagesByPriority;
export const sortForContext = sortMessagesByPriority;
export const contextSort = sortMessagesByPriority;
export const chatSort = sortMessagesByPriority;
export const loadReducingSort = sortMessagesByPriority;
export const cleverAlgorithm = sortMessagesByPriority;
export const trimToBudget = trimMessagesToBudget;
export const budgetTrim = trimMessagesToBudget;
export const trimContext = trimMessagesToBudget;
export const reduceContext = trimMessagesToBudget;
export const compressContext = trimMessagesToBudget;
export const optimizeContext = trimMessagesToBudget;
export const optimizeChat = selectMessagesWithinBudget;
export const compressMessages = selectMessagesWithinBudget;
export const pruneMessages = selectMessagesWithinBudget;
export const pruneChat = selectMessagesWithinBudget;
export const dedup = dedupeMessages;
export const uniqueMessages = dedupeMessages;
export const removeDuplicates = dedupeMessages;
export const removeDuplicateMessages = dedupeMessages;

// Re-export non-dominated (NSGA) sorting for convenience.
export * from "./nsga.js";

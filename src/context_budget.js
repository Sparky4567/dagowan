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
 * Trim a message list to a token budget, keeping the most recent messages.
 * System messages are preserved.
 */
export function trimMessagesToBudget(messages, budgetTokens) {
    if (!Array.isArray(messages)) return [];
    const budget = Math.max(256, Number(budgetTokens) || 4096);
    const result = [];
    let used = 0;
    // Preserve system messages first.
    for (const m of messages) {
        if (m && m.role === "system") {
            result.push(m);
            used += estimateTokens(m.content) + 4;
        }
    }
    const nonSystem = messages.filter((m) => !m || m.role !== "system");
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
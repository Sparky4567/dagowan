import { getBotDatabase } from "./db/database.js";
import { getMemoryStore } from "./memory.js";
import { KnowledgeStore } from "./knowledge.js";
import { unifiedChat } from "./providers.js";
import { isTrivialTurn } from "./needle.js";
import { detectLanguage, normalizeLanguageCode } from "./language.js";

export const MEMORY_EXTRACTION_PROMPT = `
Analyze the following conversation turn between User and Assistant.
Extract any durable facts, user preferences, current projects, goals, instructions, or explicit corrections.
Do NOT infer sensitive personal secrets or wild speculations.
Only extract clear, explicit statements made by the user.
Write each memory's content in the SAME language the user used in their message (e.g. Lithuanian message -> Lithuanian memory).

Return ONLY valid JSON adhering strictly to this schema:
{
  "memories": [
    {
      "type": "fact" | "preference" | "goal" | "project" | "concept" | "relationship" | "instruction" | "correction" | "observation",
      "content": "A concise declarative sentence summarizing what was learned (e.g., 'The user prefers TypeScript over Python.')",
      "confidence": 0.0 to 1.0,
      "importance": 0.0 to 1.0,
      "tags": ["relevant", "keywords"]
    }
  ],
  "knowledge": [
    {
      "title": "Short title for a general concept or technology explained by user",
      "content": "Concise summary of the concept",
      "category": "programming" | "science" | "technology" | "projects" | "concept" | "definition",
      "confidence": 0.0 to 1.0
    }
  ],
  "corrections": [
    {
      "target": "What previous concept or belief was corrected or changed",
      "newValue": "The new corrected truth"
    }
  ]
}
If no relevant durable information was stated, return:
{"memories": [], "knowledge": [], "corrections": []}
`.trim();

export const EVALUATION_PROMPT = `
Evaluate the assistant's response to the user within the given context.
Check for relevance, factual consistency, whether available memories were utilized properly, and whether there is any risk of hallucination.

Return ONLY valid JSON matching this schema:
{
  "score": 0.0 to 1.0,
  "relevant": true | false,
  "used_memory": true | false,
  "potential_hallucination": true | false,
  "notes": "Short 1-2 sentence evaluation"
}
`.trim();

export const CANDIDATE_RULE_PROMPT = `
Review the recent conversation. Propose a new deterministic pattern rule ONLY IF there is a distinct, recurring conversational pattern or intent that would benefit from a predictable rule.
Return ONLY valid JSON:
{
  "proposals": [
    {
      "keywords": ["keyword1", "keyword2"],
      "patterns": ["* keyword1 *", "i am keyword2 *"],
      "responses": [
        "Response template 1",
        "Alternative response template 2"
      ],
      "priority": 8,
      "reason": "Why this rule is useful"
    }
  ]
}
If no new rule is needed, return {"proposals": []}.
`.trim();

export class LearningPipeline {
    constructor(db = null, memoryStore = null, knowledgeStore = null) {
        this.db = db || getBotDatabase();
        this.memoryStore = memoryStore || getMemoryStore();
        this.knowledgeStore = knowledgeStore || new KnowledgeStore(this.db);
    }

    forCharacter(characterId) {
        if (!characterId) return this;
        const scopedStore = typeof this.memoryStore.forCharacter === "function"
            ? this.memoryStore.forCharacter(characterId)
            : this.memoryStore;
        return new LearningPipeline(this.db, scopedStore, this.knowledgeStore);
    }

    /**
     * Fast deterministic heuristic extraction from user message (runs synchronously).
     * `characterId` scopes created memories to the owning bot persona.
     */
    extractHeuristic(userMessage, characterId = null) {
        if (userMessage && typeof userMessage === "object") {
            characterId = userMessage.characterId ?? userMessage.character_id ?? characterId;
            userMessage = userMessage.text ?? userMessage.message ?? userMessage.content ?? "";
        }
        const result = {
            memoriesCreated: 0,
            knowledgeCreated: 0,
            correctionsHandled: 0,
            rulesProposed: 0,
            details: [],
        };

        if (!userMessage || typeof userMessage !== "string") return result;

        const text = userMessage.trim();
        const lower = text.toLowerCase();
        // Language of this turn owns the memories created from it.
        let turnLang = null;
        try {
            const det = detectLanguage(text);
            if (det.code && det.code !== "und" && det.code !== "shared") turnLang = det.code;
        } catch {}

        // 1. Detect explicit correction patterns
        const correctionMatch =
            lower.match(/(?:actually|no)[,\s]+(?:i changed it|i switched|i meant|that is wrong|it is actually)\.?\s*(.+)/i) ||
            lower.match(/i (?:am using|use|switched to|migrated to) (.+) now/i) ||
            lower.match(/my (?:favorite|email|phone|name|database|tool) is (?:now|actually) (.+)/i);

        if (correctionMatch && correctionMatch[1]) {
            const correctionDetail = text;
            const mem = this.memoryStore.addMemory({
                type: "correction",
                content: `User updated: ${correctionDetail}`,
                source: "explicit_correction_heuristic",
                confidence: 0.98,
                importance: 0.95,
                tags: ["correction", "update"],
                language: turnLang || undefined,
            }, characterId);
            result.correctionsHandled++;
            result.memoriesCreated++;
            result.details.push(`Created correction memory: ${mem.content}`);
            return result;
        }

        // 2. Detect project pattern: "I'm building X" / "I am working on X" / "developing X"
        const projectMatch = text.match(/i(?:'m| am) (?:building|working on|developing|creating|maintaining)\s+(.+)/i);
        if (projectMatch && projectMatch[1]) {
            const proj = projectMatch[1].replace(/[.?!]+$/, "").trim();
            if (proj.length > 3) {
                const mem = this.memoryStore.addMemory({
                    type: "project",
                    content: `User is building/working on ${proj}.`,
                    source: "heuristic_extraction",
                    confidence: 0.9,
                    importance: 0.85,
                    tags: ["project", "work"],
                    language: turnLang || undefined,
                }, characterId);
                result.memoriesCreated++;
                result.details.push(`Created project memory: ${mem.content}`);
            }
        }

        // 3. Detect preference pattern: "I prefer X" / "I like to use X" / "My favorite X is Y"
        const prefMatch =
            text.match(/i (?:prefer|love using|like to use|prefer to use)\s+(.+)/i) ||
            text.match(/my favorite (.+) is (.+)/i);

        if (prefMatch) {
            let prefContent = "";
            if (prefMatch[2]) {
                prefContent = `User's favorite ${prefMatch[1].trim()} is ${prefMatch[2].replace(/[.?!]+$/, "").trim()}.`;
            } else if (prefMatch[1]) {
                prefContent = `User prefers ${prefMatch[1].replace(/[.?!]+$/, "").trim()}.`;
            }

            if (prefContent.length > 5) {
                const mem = this.memoryStore.addMemory({
                    type: "preference",
                    content: prefContent,
                    source: "heuristic_extraction",
                    confidence: 0.85,
                    importance: 0.75,
                    tags: ["preference"],
                    language: turnLang || undefined,
                }, characterId);
                result.memoriesCreated++;
                result.details.push(`Created preference memory: ${mem.content}`);
            }
        }

        // 4. Detect goal pattern: "My goal is X" / "I want to achieve X"
        const goalMatch = text.match(/(?:my goal is|i want to achieve|i plan to)\s+(.+)/i);
        if (goalMatch && goalMatch[1]) {
            const goal = goalMatch[1].replace(/[.?!]+$/, "").trim();
            if (goal.length > 4) {
                const mem = this.memoryStore.addMemory({
                    type: "goal",
                    content: `User goal: ${goal}.`,
                    source: "heuristic_extraction",
                    confidence: 0.85,
                    importance: 0.8,
                    tags: ["goal"],
                    language: turnLang || undefined,
                }, characterId);
                result.memoriesCreated++;
                result.details.push(`Created goal memory: ${mem.content}`);
            }
        }

        return result;
    }

    /**
     * Run LLM-powered extraction on conversation turn asynchronously.
     */
    async extractWithLLM(
        userMessage,
        assistantResponse,
        historyContext = "",
        { settings = {}, ollamaClient = null, characterId = null, character_id = null } = {}
    ) {
        const result = {
            memoriesCreated: 0,
            knowledgeCreated: 0,
            correctionsHandled: 0,
            rulesProposed: 0,
            details: [],
        };
        const scope = characterId || character_id || null;

        // First run heuristic extraction pass
        const heuristicRes = this.extractHeuristic(userMessage, scope);
        result.memoriesCreated += heuristicRes.memoriesCreated;
        result.knowledgeCreated += heuristicRes.knowledgeCreated;
        result.correctionsHandled += heuristicRes.correctionsHandled;
        result.details.push(...heuristicRes.details);

        // Language of this turn owns the memories created from it.
        let turnLang = null;
        try {
            const det = detectLanguage(String(userMessage || ""));
            if (det.code && det.code !== "und" && det.code !== "shared") turnLang = det.code;
        } catch {}

        // Check if automatic LLM extraction is disabled in settings
        if (settings.auto_learning_enabled === false) {
            return result;
        }

        // Triage: trivial turns ("ok", "thanks!") carry no durable content
        // for the LLM pass (the heuristic pass above already ran). Skips one
        // background LLM call per chitchat turn.
        if (isTrivialTurn(userMessage) && result.memoriesCreated === 0 && result.correctionsHandled === 0) {
            return result;
        }

        const modelToUse = settings.model || "llama3";

        try {
            const prompt = `${MEMORY_EXTRACTION_PROMPT}

Recent Context:
${historyContext}

User Message:
${userMessage}

Assistant Response:
${assistantResponse}`;

            const response = await unifiedChat({
                modelName: modelToUse,
                messages: [{ role: "user", content: prompt }],
                stream: false,
                settings,
                ollamaClient,
            });

            const content = response.content || "";
            const parsed = safeParseLlmJson(content);
            if (!parsed) return result;

            const VALID_MEMORY_TYPES = new Set(["fact", "preference", "goal", "project", "concept", "relationship", "instruction", "correction", "observation"]);
            const clamp01 = (v, fb) => (typeof v === "number" && Number.isFinite(v)) ? Math.max(0, Math.min(1, v)) : fb;

            // Process extracted memories
            if (Array.isArray(parsed.memories)) {
                for (const item of parsed.memories) {
                    if (!item || typeof item.content !== "string") continue;
                    const content = item.content.trim();
                    if (content.length < 5 || content.length > 500) continue;
                    const type = VALID_MEMORY_TYPES.has(item.type) ? item.type : "fact";
                    const conf = clamp01(item.confidence, 0.8);
                    if (conf < 0.6) continue;
                    const importance = clamp01(item.importance, 0.6);
                    // Dedup: skip if an equivalent active memory already exists.
                    try {
                        const dup = this.memoryStore.findSimilarActive(content, type, scope);
                        if (dup && dup.exactMatch) continue;
                    } catch {}
                    const mem = this.memoryStore.addMemory({
                        type,
                        content,
                        source: "llm_extraction",
                        confidence: conf,
                        importance,
                        tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
                        language: normalizeLanguageCode(item.language || item.lang) || turnLang || undefined,
                    }, scope);
                    result.memoriesCreated++;
                    result.details.push(`LLM memory extracted: [${mem.type}] ${mem.content}`);
                }
            }

            const VALID_KNOWLEDGE_CATEGORIES = new Set(["programming", "science", "technology", "projects", "concept", "definition"]);
            // Process extracted knowledge items
            if (Array.isArray(parsed.knowledge)) {
                for (const item of parsed.knowledge) {
                    if (!item || typeof item.title !== "string" || typeof item.content !== "string") continue;
                    const title = item.title.trim();
                    const content = item.content.trim();
                    if (title.length < 2 || title.length > 120 || content.length < 5 || content.length > 1000) continue;
                    const conf = clamp01(item.confidence, 0.8);
                    if (conf < 0.65) continue;
                    const category = VALID_KNOWLEDGE_CATEGORIES.has(item.category) ? item.category : "concept";
                    const kn = this.knowledgeStore.addKnowledge({
                        title,
                        content,
                        category,
                        sourceType: "user",
                        confidence: conf,
                        changeReason: "Extracted from conversation turn",
                    });
                    result.knowledgeCreated++;
                    result.details.push(`Knowledge added: ${kn.title}`);
                }
            }

            // Process explicit corrections
            if (Array.isArray(parsed.corrections) && parsed.corrections.length > 0) {
                for (const corr of parsed.corrections) {
                    if (corr.target && corr.newValue) {
                        const mem = this.memoryStore.addMemory({
                            type: "correction",
                            content: `Correction: ${corr.target} replaced by ${corr.newValue}.`,
                            source: "llm_correction_extraction",
                            confidence: 0.95,
                            importance: 0.95,
                            tags: ["correction", corr.target],
                            language: turnLang || undefined,
                        }, scope);
                        result.correctionsHandled++;
                        result.memoriesCreated++;
                        result.details.push(`Correction saved: ${mem.content}`);
                    }
                }
            }
        } catch (err) {
            // Silently log extraction failure to avoid interrupting main chat loop
            this.db.logLearningEvent("extraction_error", { error: err.message || String(err) });
        }

        // Neuromorphic consolidation: promote repeatedly activated traces
        // (short-term -> long-term). Throttled internally, non-blocking.
        try {
            const { getNeuromorphicMemory } = await import("./neuromorphic_memory.js");
            getNeuromorphicMemory().consolidate().catch(() => {});
        } catch {}

        return result;
    }

    /**
     * Checks if a candidate deterministic rule should be proposed.
     */
    async proposeCandidateRule(userMessage, historyContext = "", { settings = {}, ollamaClient = null } = {}) {
        const modelToUse = settings.model || "llama3";
        try {
            const prompt = `${CANDIDATE_RULE_PROMPT}

History:
${historyContext}

Latest User Input:
${userMessage}`;

            const response = await unifiedChat({
                modelName: modelToUse,
                messages: [{ role: "user", content: prompt }],
                stream: false,
                settings,
                ollamaClient,
            });

            const parsed = safeParseLlmJson(response.content || "");
            if (!parsed) return null;
            if (Array.isArray(parsed.proposals) && parsed.proposals.length > 0) {
                const p = parsed.proposals[0];
                if (p && Array.isArray(p.keywords) && Array.isArray(p.responses) && p.keywords.length > 0) {
                    const ruleId = this.addCandidateRule({
                        keywords: p.keywords,
                        patterns: Array.isArray(p.patterns) && p.patterns.length > 0 ? p.patterns : [`* ${p.keywords[0]} *`],
                        responses: p.responses,
                        priority: typeof p.priority === "number" ? p.priority : 7,
                        sourceReason: p.reason || "Discovered by candidate rule proposal model",
                    });
                    return ruleId;
                }
            }
        } catch {}
        return null;
    }

    addCandidateRule({ keywords, patterns, responses, priority = 5, sourceReason = "" }) {
        const id = `rule_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const now = new Date().toISOString();

        this.db.run(
            `INSERT INTO learned_rules (id, keywords, patterns, responses, priority, status, source_reason, created_at, updated_at)
             VALUES ($id, $keywords, $patterns, $responses, $priority, 'candidate', $source_reason, $created_at, $updated_at)`,
            {
                $id: id,
                $keywords: JSON.stringify(keywords),
                $patterns: JSON.stringify(patterns),
                $responses: JSON.stringify(responses),
                $priority: priority,
                $source_reason: sourceReason,
                $created_at: now,
                $updated_at: now,
            }
        );

        this.db.logLearningEvent("candidate_rule_added", { id, keywords, priority });
        return id;
    }

    approveRule(id) {
        const now = new Date().toISOString();
        this.db.run(
            `UPDATE learned_rules SET status = 'approved', updated_at = $now WHERE id = $id`,
            { $id: id, $now: now }
        );
        this.db.logLearningEvent("rule_approved", { id });
        return true;
    }

    listRules(status = null) {
        let sql = "SELECT * FROM learned_rules WHERE 1=1";
        const params = {};
        if (status) {
            sql += " AND status = $status";
            params.$status = status;
        }
        sql += " ORDER BY priority DESC, created_at DESC";

        const rows = this.db.query(sql, params);
        return rows.map((r) => ({
            id: r.id,
            keywords: JSON.parse(r.keywords || "[]"),
            patterns: JSON.parse(r.patterns || "[]"),
            responses: JSON.parse(r.responses || "[]"),
            priority: r.priority,
            status: r.status,
            sourceReason: r.source_reason,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }));
    }

    async evaluateResponse(userMessage, botResponse, contextPrompt = "", strategy = "unified_chat", { settings = {}, ollamaClient = null } = {}) {
        let evalResult = {
            score: 0.8,
            relevant: true,
            usedMemory: false,
            potentialHallucination: false,
            notes: "Heuristic evaluation",
        };

        const modelToUse = settings.model || "llama3";
        try {
            const prompt = `${EVALUATION_PROMPT}

Context:
${contextPrompt}

User Message:
${userMessage}

Bot Response:
${botResponse}`;

            const response = await unifiedChat({
                modelName: modelToUse,
                messages: [{ role: "user", content: prompt }],
                stream: false,
                settings,
                ollamaClient,
            });

            const parsed = safeParseLlmJson(response.content || "");
            if (parsed) {
                evalResult = {
                    score: typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : 0.8,
                    relevant: parsed.relevant !== false,
                    usedMemory: Boolean(parsed.used_memory),
                    potentialHallucination: Boolean(parsed.potential_hallucination),
                    notes: parsed.notes || "Evaluated via LLM",
                };
            }
        } catch {
            // Heuristic evaluation fallback
            const userWords = userMessage.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
            const respWords = botResponse.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
            const overlap = userWords.filter((w) => respWords.includes(w));
            let score = 0.75 + (overlap.length > 0 ? 0.1 : 0);
            evalResult.score = Math.min(1.0, score);
        }

        // Record strategy statistics
        const isSuccess = evalResult.score >= 0.7 ? 1 : 0;
        const now = new Date().toISOString();
        const existing = this.db.get("SELECT * FROM strategy_stats WHERE strategy = $strategy", { $strategy: strategy });

        if (existing) {
            this.db.run(
                `UPDATE strategy_stats SET
                  attempts = attempts + 1,
                  successes = successes + $succ,
                  total_score = total_score + $score,
                  updated_at = $now
                 WHERE strategy = $strategy`,
                {
                    $succ: isSuccess,
                    $score: evalResult.score,
                    $now: now,
                    $strategy: strategy,
                }
            );
        } else {
            this.db.run(
                `INSERT INTO strategy_stats (strategy, attempts, successes, total_score, updated_at)
                 VALUES ($strategy, 1, $succ, $score, $now)`,
                {
                    $strategy: strategy,
                    $succ: isSuccess,
                    $score: evalResult.score,
                    $now: now,
                }
            );
        }

        return evalResult;
    }
}

function stripCodeFences(text) {
    // Remove ```json ... ``` wrappers LLMs often add.
    const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();
    return String(text);
}

function extractBalancedJson(text) {
    const s = String(text || "");
    const start = s.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    return null;
}

function extractJsonString(text) {
    if (!text || typeof text !== "string") return null;
    const clean = stripCodeFences(text);
    // Prefer first balanced {...} so trailing prose with "}" can't corrupt it.
    const balanced = extractBalancedJson(clean);
    if (balanced) return balanced;
    // Fallback to legacy first-"{"..last-"}" slice.
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
        return clean.slice(start, end + 1);
    }
    return null;
}

function repairJsonString(s) {
    let out = String(s);
    // "confidence": 1. -> "confidence": 1.0 (Bun: "Invalid digits after decimal point")
    out = out.replace(/(\d)\.(?=[\s,}\]])/g, "$1.0");
    // "confidence": .8 -> "confidence": 0.8
    out = out.replace(/([:\[{\s,])\.(\d)/g, "$10.$2");
    // Trailing commas: {"a":1,} -> {"a":1}
    out = out.replace(/,(\s*[}\]])/g, "$1");
    return out;
}

export function safeParseLlmJson(text) {
    const raw = extractJsonString(text);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {}
    try {
        return JSON.parse(repairJsonString(raw));
    } catch {}
    return null;
}

let defaultLearningPipelineInstance = null;

export function getLearningPipeline() {
    if (!defaultLearningPipelineInstance) {
        defaultLearningPipelineInstance = new LearningPipeline();
    }
    return defaultLearningPipelineInstance;
}

export function getLearningStats() {
    const db = getBotDatabase();
    return db.getStats();
}

export function getLearningLogs(limit = 20) {
    const db = getBotDatabase();
    return db.getLogs(limit);
}

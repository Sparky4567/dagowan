import { config as loadDotenv } from "dotenv";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

import { Ollama } from "ollama";
import { memoize } from "./utils/memoize.js";

loadDotenv();

export const DEFAULT_MODELS = {
    ollama: ["llama3", "mistral", "qwen2.5", "phi3", "llama3.1", "deepseek-r1"],
    openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo", "o1", "o3-mini"],
    gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
    claude: ["claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"],
    grok: ["grok-2-latest", "grok-2-1212", "grok-2-vision-1212", "grok-beta"],
};

/**
 * Detects provider from model string or explicit prefix (e.g. "openai:gpt-4o", "gemini-2.5-flash")
 */
function detectProviderUncached(modelName) {
    if (!modelName) return "ollama";
    const low = modelName.toLowerCase();

    if (low.startsWith("openai:") || low.startsWith("chatgpt:")) return "openai";
    if (low.startsWith("gemini:") || low.startsWith("google:")) return "gemini";
    if (low.startsWith("claude:") || low.startsWith("anthropic:")) return "claude";
    if (low.startsWith("grok:") || low.startsWith("xai:")) return "grok";
    if (low.startsWith("ollama:")) return "ollama";

    if (low.startsWith("gpt-oss") || low.includes("cloud") || low.includes(":")) return "ollama";
    if (low.startsWith("gpt-4") || low.startsWith("gpt-3.5") || low.startsWith("o1") || low.startsWith("o3-")) return "openai";
    if (low.startsWith("gemini-")) return "gemini";
    if (low.startsWith("claude-")) return "claude";
    if (low.startsWith("grok-")) return "grok";

    return "ollama";
}

/**
 * Strips provider prefix if present (e.g. "openai:gpt-4o" -> "gpt-4o")
 */
function normalizeModelNameUncached(modelName) {
    if (!modelName) return "llama3";
    if (modelName.includes(":")) {
        const parts = modelName.split(":");
        const prefix = parts[0].toLowerCase();
        if (["openai", "chatgpt", "gemini", "google", "claude", "anthropic", "grok", "xai", "ollama"].includes(prefix)) {
            return parts.slice(1).join(":");
        }
    }
    return modelName;
}

/**
 * Retrieves configured API key for provider from settings or environment variables.
 */
export function getApiKey(provider, settings = {}) {
    const p = (provider || "").toLowerCase();
    if (p === "openai" || p === "chatgpt") {
        return settings.openai_api_key || process.env.OPENAI_API_KEY || process.env.CHATGPT_API_KEY || "";
    }
    if (p === "gemini" || p === "google") {
        return settings.gemini_api_key || process.env.GEMINI_API_KEY || "";
    }
    if (p === "claude" || p === "anthropic") {
        return settings.claude_api_key || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || "";
    }
    if (p === "grok" || p === "xai") {
        return settings.grok_api_key || process.env.GROK_API_KEY || process.env.XAI_API_KEY || "";
    }
    return "";
}

/**
 * Masks API key for secure logging.
 */
function maskApiKeyUncached(key) {
    if (!key) return "(Not set)";
    if (key.length <= 8) return "********";
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// Pure string helpers run on every LLM call — memoize them. Deliberately
// NOT memoizing getApiKey/unifiedChat: keys come from env/settings and
// chat responses must never be cached.
export const detectProvider = memoize(detectProviderUncached, { maxSize: 200 });
export const normalizeModelName = memoize(normalizeModelNameUncached, { maxSize: 200 });
export const maskApiKey = memoize(maskApiKeyUncached, { maxSize: 200 });

/**
 * Unified Chat Interface supporting Ollama, OpenAI (ChatGPT), Gemini, Claude, and Grok.
 */
export async function unifiedChat({
    modelName,
    messages = [],
    stream = false,
    settings = {},
    ollamaClient = null,
    onChunk = null,
}) {
    let provider = detectProvider(modelName);
    let model = normalizeModelName(modelName);

    // If cloud provider is requested but API key is not configured, fall back to local Ollama
    if (provider !== "ollama") {
        const key = getApiKey(provider, settings);
        if (!key) {
            console.warn(`⚠️ API Key for provider '${provider}' not configured. Falling back to local Ollama model...`);
            provider = "ollama";
            model = (settings && settings.model && detectProvider(settings.model) === "ollama") ? settings.model : "smollm2:135m";
        }
    }

    // 1. Ollama
    if (provider === "ollama") {
        const hostUrl = (settings && settings.server_url) ? settings.server_url : "http://127.0.0.1:11434";
        const client = (settings && settings.server_url) ? new Ollama({ host: hostUrl }) : (ollamaClient || new Ollama({ host: hostUrl }));

        try {
            const response = await client.chat({
                model,
                messages,
                stream,
            });

            if (stream) {
                let fullText = "";
                for await (const chunk of response) {
                    const text = chunk.message?.content || "";
                    fullText += text;
                    if (onChunk) onChunk(text);
                }
                return { content: fullText };
            } else {
                return { content: response.message?.content || "" };
            }
        } catch (err) {
            const errMsg = err.message || String(err);
            if (errMsg.includes("Unable to connect") || errMsg.includes("ECONNREFUSED") || errMsg.includes("fetch failed")) {
                throw new Error(
                    `Unable to connect to Ollama server at ${hostUrl}.\n` +
                    `👉 If using local models, ensure 'ollama serve' is running in PRoot-Distro/Termux.\n` +
                    `👉 If using cloud models, set API key with: @set-api-key <provider> <key> (e.g. @set-api-key gemini YOUR_KEY)`
                );
            }
            throw err;
        }
    }

    const apiKey = getApiKey(provider, settings);
    if (!apiKey) {
        throw new Error(
            `Missing API Key for provider '${provider}'. Set it using @set-api-key ${provider} <key> or set environment variable.`
        );
    }

    // 2. OpenAI (ChatGPT)
    if (provider === "openai") {
        const client = new OpenAI({ apiKey });
        if (stream) {
            const responseStream = await client.chat.completions.create({
                model,
                messages,
                stream: true,
            });
            let fullText = "";
            for await (const chunk of responseStream) {
                const text = chunk.choices[0]?.delta?.content || "";
                if (text) {
                    fullText += text;
                    if (onChunk) onChunk(text);
                }
            }
            return { content: fullText };
        } else {
            const response = await client.chat.completions.create({
                model,
                messages,
                stream: false,
            });
            return { content: response.choices[0]?.message?.content || "" };
        }
    }

    // 3. xAI Grok (OpenAI Compatible)
    if (provider === "grok") {
        const client = new OpenAI({
            apiKey,
            baseURL: "https://api.x.ai/v1",
        });
        if (stream) {
            const responseStream = await client.chat.completions.create({
                model,
                messages,
                stream: true,
            });
            let fullText = "";
            for await (const chunk of responseStream) {
                const text = chunk.choices[0]?.delta?.content || "";
                if (text) {
                    fullText += text;
                    if (onChunk) onChunk(text);
                }
            }
            return { content: fullText };
        } else {
            const response = await client.chat.completions.create({
                model,
                messages,
                stream: false,
            });
            return { content: response.choices[0]?.message?.content || "" };
        }
    }

    // 4. Anthropic Claude
    if (provider === "claude") {
        const client = new Anthropic({ apiKey });
        const systemPrompt = messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n\n");

        const formattedMessages = messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role, content: m.content }));

        if (formattedMessages.length === 0) {
            formattedMessages.push({ role: "user", content: "Hello" });
        }

        if (stream) {
            const streamEvents = await client.messages.create({
                model,
                max_tokens: 4096,
                system: systemPrompt || undefined,
                messages: formattedMessages,
                stream: true,
            });

            let fullText = "";
            for await (const event of streamEvents) {
                if (event.type === "content_block_delta" && event.delta?.text) {
                    const text = event.delta.text;
                    fullText += text;
                    if (onChunk) onChunk(text);
                }
            }
            return { content: fullText };
        } else {
            const response = await client.messages.create({
                model,
                max_tokens: 4096,
                system: systemPrompt || undefined,
                messages: formattedMessages,
            });

            const fullText = response.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("");
            return { content: fullText };
        }
    }

    // 5. Google Gemini
    if (provider === "gemini") {
        const ai = new GoogleGenAI({ apiKey });
        const systemPrompt = messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n\n");

        const contents = messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
                role: m.role === "assistant" ? "model" : "user",
                parts: [{ text: m.content }],
            }));

        if (contents.length === 0) {
            contents.push({ role: "user", parts: [{ text: "Hello" }] });
        }

        if (stream) {
            const responseStream = await ai.models.generateContentStream({
                model,
                contents,
                config: systemPrompt ? { systemInstruction: systemPrompt } : undefined,
            });

            let fullText = "";
            for await (const chunk of responseStream) {
                const text = chunk.text || "";
                if (text) {
                    fullText += text;
                    if (onChunk) onChunk(text);
                }
            }
            return { content: fullText };
        } else {
            const response = await ai.models.generateContent({
                model,
                contents,
                config: systemPrompt ? { systemInstruction: systemPrompt } : undefined,
            });
            return { content: response.text || "" };
        }
    }

    throw new Error(`Unsupported LLM provider: '${provider}'`);
}

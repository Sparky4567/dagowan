import { describe, expect, test } from "bun:test";
import { DEFAULT_MODELS, detectProvider, getApiKey, normalizeModelName } from "./providers.js";

describe("mistral provider routing", () => {
    test("DEFAULT_MODELS.mistral lists current chat model aliases", () => {
        expect(DEFAULT_MODELS.mistral).toEqual([
            "mistral-large-latest",
            "mistral-medium-latest",
            "mistral-small-latest",
            "codestral-latest",
            "ministral-8b-latest",
            "ministral-3b-latest",
        ]);
    });

    test("cloud mistral names route to mistral", () => {
        for (const m of [
            "mistral-large-latest", "mistral-medium-latest", "mistral-small-latest",
            "codestral-latest", "ministral-8b-latest", "ministral-3b-latest",
            "mistral:mistral-large-latest", "open-mixtral-8x7b", "devstral-2507",
            "magistral-small-2509",
        ]) {
            expect(detectProvider(m)).toBe("mistral");
        }
        expect(normalizeModelName("mistral:mistral-large-latest")).toBe("mistral-large-latest");
    });

    test("local ollama mistral tags keep routing to ollama", () => {
        expect(detectProvider("mistral")).toBe("ollama");
        expect(detectProvider("mistral:7b")).toBe("ollama");
        expect(detectProvider("mistral:latest")).toBe("ollama");
        expect(normalizeModelName("mistral:7b")).toBe("mistral:7b");
        expect(normalizeModelName("ollama:mistral:7b")).toBe("mistral:7b");
    });

    test("other providers unaffected", () => {
        expect(detectProvider("gpt-4o")).toBe("openai");
        expect(detectProvider("gemini-2.5-flash")).toBe("gemini");
        expect(detectProvider("claude-3-5-sonnet-20241022")).toBe("claude");
        expect(detectProvider("grok-2-latest")).toBe("grok");
        expect(detectProvider("llama3")).toBe("ollama");
        expect(detectProvider("gpt-oss:120b-cloud")).toBe("ollama");
    });

    test("getApiKey reads mistral key from settings then env", () => {
        expect(getApiKey("mistral", { mistral_api_key: "sk-test" })).toBe("sk-test");
        const prev = process.env.MISTRAL_API_KEY;
        process.env.MISTRAL_API_KEY = "env-test";
        try {
            expect(getApiKey("mistral", {})).toBe("env-test");
        } finally {
            if (prev === undefined) delete process.env.MISTRAL_API_KEY;
            else process.env.MISTRAL_API_KEY = prev;
        }
        expect(getApiKey("mistral", {})).toBe("");
    });
});

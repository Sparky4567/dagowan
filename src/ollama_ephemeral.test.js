import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildSinglePrompt,
    candidateOllamaLiteDirs,
    formatEphemeralReply,
    getStripPrefixes,
    isEphemeralEnabled,
    parseEphemeralToggleArg,
    resolveOllamaLiteDir,
    sanitizeCliOutput,
} from "./ollama_ephemeral.js";

describe("ollama ephemeral one-shot", () => {
    test("enabled by default, opt-out with 0/false/off", () => {
        expect(isEphemeralEnabled({})).toBe(true);
        expect(isEphemeralEnabled({ ollama_ephemeral: true })).toBe(true);
        expect(isEphemeralEnabled({ ollama_ephemeral: 1 })).toBe(true);
        for (const off of [0, false, "0", "false", "off", "no", "disabled"]) {
            expect(isEphemeralEnabled({ ollama_ephemeral: off })).toBe(false);
        }
    });

    test("resolves the bun-ollama checkout dynamically (no hardcoded path)", () => {
        // Explicit setting wins when it contains src/index.ts.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lite-"));
        fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
        fs.writeFileSync(path.join(tmp, "src", "index.ts"), "// fake entry\n");
        try {
            expect(resolveOllamaLiteDir({ ollama_lite_dir: tmp })).toBe(tmp);
            expect(candidateOllamaLiteDirs({ ollama_lite_dir: tmp })[0]).toBe(tmp);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
        // Default discovery finds a checkout without any setting or env var.
        const prevEnv = process.env.OLLAMA_LITE_DIR;
        delete process.env.OLLAMA_LITE_DIR;
        try {
            const dir = resolveOllamaLiteDir({});
            expect(dir).toBeTruthy();
            expect(fs.existsSync(path.join(dir, "src", "index.ts"))).toBe(true);
        } finally {
            if (prevEnv !== undefined) process.env.OLLAMA_LITE_DIR = prevEnv;
        }
    });

    test("env var participates in dynamic discovery", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lite-env-"));
        fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
        fs.writeFileSync(path.join(tmp, "src", "index.ts"), "// fake entry\n");
        const prevEnv = process.env.OLLAMA_LITE_DIR;
        process.env.OLLAMA_LITE_DIR = tmp;
        try {
            expect(candidateOllamaLiteDirs({})).toContain(tmp);
        } finally {
            if (prevEnv === undefined) delete process.env.OLLAMA_LITE_DIR;
            else process.env.OLLAMA_LITE_DIR = prevEnv;
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test("toggle arg parsing", () => {
        for (const a of ["", "status", "state", "show"]) {
            expect(parseEphemeralToggleArg(a)).toBe("status");
        }
        for (const a of ["on", "ON", "1", "true", "enable"]) {
            expect(parseEphemeralToggleArg(a)).toBe("on");
        }
        for (const a of ["off", "OFF", "0", "false", "disable"]) {
            expect(parseEphemeralToggleArg(a)).toBe("off");
        }
        expect(parseEphemeralToggleArg("maybe")).toBe("invalid");
    });

    test("shared status reply reports mode and timeout", () => {
        const on = formatEphemeralReply({ ollama_ephemeral: true, ollama_ephemeral_timeout_ms: 60000 });
        expect(on).toContain("ENABLED");
        expect(on).toContain("60000ms");
        const off = formatEphemeralReply({ ollama_ephemeral: false });
        expect(off).toContain("DISABLED");
        expect(off).toContain("resident");
    });
    test("strip prefixes are overridable via settings", () => {
        const raw = "Loading model x...\nHello there.";
        expect(sanitizeCliOutput(raw, {})).toBe("Hello there.");
        expect(sanitizeCliOutput(raw, { ollama_ephemeral_strip: ["Hello"] })).toBe("Loading model x...");
        expect(getStripPrefixes({})).toContain("Loading model");
    });

    test("single user message passes through untouched", () => {
        expect(buildSinglePrompt([{ role: "user", content: "Why is the sky blue?" }]))
            .toBe("Why is the sky blue?");
    });

    test("multi-turn history collapses with role labels", () => {
        const prompt = buildSinglePrompt([
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Hi" },
            { role: "assistant", content: "Hello!" },
            { role: "user", content: "Why is the sky blue?" },
        ]);
        expect(prompt).toContain("[System]\nYou are helpful.");
        expect(prompt).toContain("User: Why is the sky blue?");
        expect(prompt).toContain("Assistant: Hello!");
        expect(prompt.endsWith("Assistant:")).toBe(true);
    });

    test("strips bun-ollama status lines, keeps the answer", () => {
        const raw = [
            "Loading model smollm2:135m...",
            "Model:        smollm2:135m",
            "Quantization: Q8_0",
            "Why is the sky blue? Because of Rayleigh scattering.",
            "Sunlight scatters off air molecules.",
        ].join("\n");
        expect(sanitizeCliOutput(raw)).toBe(
            "Why is the sky blue? Because of Rayleigh scattering.\nSunlight scatters off air molecules."
        );
    });

    test("strips bun-ollama [INFO]/[DEBUG] logger lines from stdout", () => {
        const raw = [
            "[INFO] Allocated port 41000 for model smollm2:135m",
            "[INFO] Starting llama-server on port 41000 for model smollm2:135m",
            "[INFO] Model smollm2:135m is now READY on port 41000",
            "Blue is scattered sunlight.",
            "[INFO] Stopping model process smollm2:135m on port 41000",
        ].join("\n");
        expect(sanitizeCliOutput(raw, {})).toBe("Blue is scattered sunlight.");
    });

    test("strips download progress bars", () => {
        const raw = "Downloading smollm2:135m: [██████░░░░] 25% 100.0 MB / 400.0 MB (10.0 MB/s)\nReal answer line.";
        expect(sanitizeCliOutput(raw)).toBe("Real answer line.");
    });
});

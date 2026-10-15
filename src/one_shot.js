#!/usr/bin/env bun
// One-shot ephemeral inference using the model from app_settings.json.
//
// Usage:
//   bun run ask "Why is the sky blue?"
//   bun run src/one_shot.js --model smollm2:135m "Why is the sky blue?"
//   bun run src/one_shot.js "Why is the sky blue?"
//
// Equivalent to the underlying bun-ollama call, with <model> resolved from
// settings instead of typed by hand:
//   bun run <ollama-lite>/src/index.ts run <settings.model> --messages-json '<msgs>'
//
// The model is loaded, answers once, then unloaded (RAM freed).

import { loadSettings } from "./config.js";
import { getSharedModel } from "./model_selection.js";
import { unifiedChat } from "./providers.js";

const rawArgs = process.argv.slice(2);
let modelOverride = "";
const promptParts = [];
for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if ((a === "--model" || a === "-m") && rawArgs[i + 1]) {
        modelOverride = rawArgs[++i];
    } else if (a.startsWith("--model=")) {
        modelOverride = a.slice("--model=".length);
    } else {
        promptParts.push(a);
    }
}

const settings = loadSettings();
const model = (modelOverride || getSharedModel(settings)).trim();
const prompt = promptParts.join(" ").trim() || "Why is the sky blue?";

process.stdout.write(`🤖 model: ${model} (ephemeral one-shot)\n❓ ${prompt}\n\n`);

let streamed = "";
try {
    const res = await unifiedChat({
        modelName: model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        settings,
        onChunk: (t) => {
            streamed += t;
            process.stdout.write(t);
        },
    });
    const finalText = streamed || res?.content || "";
    if (!finalText.trim()) {
        console.error("\n⚠️ Empty reply (model produced no text).");
        process.exit(2);
    }
    process.stdout.write("\n");
} catch (err) {
    console.error(`\n⚠️ One-shot failed: ${err?.message || err}`);
    process.exit(1);
}

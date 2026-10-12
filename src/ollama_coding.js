import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Agent } from "../ollama_cli/src/agent.ts";
import { executeTool, TOOLS } from "../ollama_cli/src/tools.ts";
import { OllamaService } from "../ollama_cli/src/ollama.ts";
import { detectProvider } from "./providers.js";

/**
 * Resolves the persistent project directory path from settings or defaults.
 */
export function resolveProjectPath(settings = {}) {
    let p = settings.project_path || settings.projects_path || "projects";
    if (typeof p === "string" && p.startsWith("~")) {
        p = path.join(os.homedir(), p.slice(1));
    }
    const absPath = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    if (!fs.existsSync(absPath)) {
        try {
            fs.mkdirSync(absPath, { recursive: true });
        } catch {}
    }
    return absPath;
}

/**
 * The coding tool always receives the selected shared model. Cloud providers
 * use the assistant's unified router; local models retain Ollama tool calling.
 */
async function resolveOllamaModel(settings = {}) {
    const serverUrl = settings.server_url || "http://localhost:11434";
    const currentModel = settings.model || "llama3";

    return currentModel;
}

async function runCloudCodingPrompt(taskPrompt, settings) {
    const response = await unifiedChat({
        modelName: settings.model,
        settings,
        stream: false,
        messages: [{
            role: "system",
            content: "You are an expert coding assistant. Provide a concrete, complete implementation plan or code response. Be explicit about files and commands; do not claim to have executed tools.",
        }, { role: "user", content: taskPrompt }],
    });
    return response.content || "No coding response generated.";
}

/**
 * Runs a project creation / coding task using Ollama CLI's toolset and agent loop.
 */
export async function runMakeCommand(taskPrompt, settings = {}) {
    const serverUrl = settings.server_url || "http://localhost:11434";
    const model = await resolveOllamaModel(settings);
    const projectPath = resolveProjectPath(settings);

    console.log(`\n🔨 [Ollama CLI Coding Toolset Active]`);
    console.log(`🛠 Model: ${model}`);
    console.log(`📁 Project Path: ${projectPath}`);
    console.log(`🎯 Task: "${taskPrompt}"\n`);

    const result = detectProvider(model) === "ollama"
        ? await (async () => {
            const agent = new Agent(model, serverUrl, undefined, projectPath, settings);
            agent.setMode("code");
            return await agent.runUserPrompt(taskPrompt);
        })()
        : await runCloudCodingPrompt(taskPrompt, settings);
    return {
        success: true,
        model,
        projectPath,
        output: result || `Successfully executed coding task: "${taskPrompt}"`,
    };
}

/**
 * Creates or writes content to a file directly or via the Ollama CLI toolset.
 */
export async function runCreateFileCommand(filePath, contentOrInstruction = "", settings = {}) {
    if (!filePath) {
        return {
            success: false,
            error: "Usage: @create-file <file_path> [content or description]\nExample: @create-file ./src/app.js console.log('Hello');",
        };
    }

    const projectPath = resolveProjectPath(settings);
    const resolvedFilePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(projectPath, filePath);

    const trimmedPayload = (contentOrInstruction || "").trim();

    // If no payload provided, write empty file
    if (!trimmedPayload) {
        const res = await executeTool("write_file", { file_path: resolvedFilePath, content: "" }, projectPath);
        return { success: true, projectPath, filePath: resolvedFilePath, output: res };
    }

    // Check if payload is an instruction prompt or direct content
    const lowerPayload = trimmedPayload.toLowerCase();
    const isPromptInstruction =
        lowerPayload.startsWith("create ") ||
        lowerPayload.startsWith("write ") ||
        lowerPayload.startsWith("generate ") ||
        lowerPayload.startsWith("build ") ||
        lowerPayload.startsWith("make ") ||
        trimmedPayload.startsWith("--prompt ");

    const promptTextPayload = trimmedPayload.startsWith("--prompt ")
        ? trimmedPayload.slice(9).trim()
        : trimmedPayload;

    if (!isPromptInstruction) {
        const res = await executeTool("write_file", { file_path: resolvedFilePath, content: trimmedPayload }, projectPath);
        return { success: true, projectPath, filePath: resolvedFilePath, output: res };
    } else {
        const serverUrl = settings.server_url || "http://localhost:11434";
        const model = await resolveOllamaModel(settings);

        console.log(`\n📄 [Ollama CLI File Generator Active]`);
        console.log(`🛠 Model: ${model}`);
        console.log(`📁 Project Path: ${projectPath}`);
        console.log(`📝 Target File: ${resolvedFilePath}`);
        console.log(`🎯 Prompt: "${promptTextPayload}"\n`);

        const promptText = `Write and save the file '${resolvedFilePath}' with content satisfying the following instructions:\n${promptTextPayload}\nUse the write_file tool to save the file.`;
        let result;
        if (detectProvider(model) === "ollama") {
            const agent = new Agent(model, serverUrl, undefined, projectPath, settings);
            agent.setMode("code");
            result = await agent.runUserPrompt(promptText);
        } else {
            const content = await runCloudCodingPrompt(
                `Return only the complete content for '${resolvedFilePath}'.\n\n${promptTextPayload}`,
                settings
            );
            fs.mkdirSync(path.dirname(resolvedFilePath), { recursive: true });
            fs.writeFileSync(resolvedFilePath, content.replace(/^```[\w-]*\n?|```$/g, ""), "utf8");
            result = `Created '${resolvedFilePath}' using ${model}.`;
        }
        return {
            success: true,
            projectPath,
            filePath: resolvedFilePath,
            output: result || `File '${resolvedFilePath}' created successfully.`,
        };
    }
}

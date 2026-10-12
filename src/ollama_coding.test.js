import { test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { runCreateFileCommand } from "./ollama_coding.js";
import { handleAtCommand as handleSlashCommand } from "./commands.js";

const TEST_DIR = path.resolve("./test_scratch_assistant");

let savedOriginalSettings = null;

beforeAll(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    try {
        if (await Bun.file("app_settings.json").exists()) {
            savedOriginalSettings = await Bun.file("app_settings.json").text();
        }
    } catch {}
});

afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    if (savedOriginalSettings !== null) {
        await Bun.write("app_settings.json", savedOriginalSettings);
    }
});

test("runCreateFileCommand creates file with content and missing parent directories", async () => {
    const targetPath = path.join(TEST_DIR, "nested", "folder", "test.js");
    const content = "console.log('Hello from integrated Ollama CLI');";

    const res = await runCreateFileCommand(targetPath, content);
    expect(res.success).toBe(true);
    expect(res.output).toContain("Successfully wrote");

    const fileContent = await Bun.file(targetPath).text();
    expect(fileContent).toBe(content);
});

test("handleAtCommand handles @create-file correctly", async () => {
    const targetPath = path.join(TEST_DIR, "slash_test.txt");
    const commandStr = `@create-file ${targetPath} Hello slash command`;

    const context = {
        settings: { model: "llama3.2:1b" },
        messages: [],
    };

    const res = await handleSlashCommand({ commandStr, context });
    expect(res.handled).toBe(true);

    const fileContent = await Bun.file(targetPath).text();
    expect(fileContent).toBe("Hello slash command");
});

test("handleAtCommand shows usage for empty @make command", async () => {
    const context = { settings: {}, messages: [] };
    const res = await handleSlashCommand({ commandStr: "@make", context });
    expect(res.handled).toBe(true);
});

test("handleAtCommand shows usage for empty @create-file command", async () => {
    const context = { settings: {}, messages: [] };
    const res = await handleSlashCommand({ commandStr: "@create-file", context });
    expect(res.handled).toBe(true);
});

test("handleAtCommand handles @change-project-path and persists setting", async () => {
    const newCustomPath = path.join(TEST_DIR, "custom_projects");
    const context = {
        settings: { model: "llama3.2:1b", project_path: "projects" },
        messages: [],
    };

    const res = await handleSlashCommand({
        commandStr: `@change-project-path ${newCustomPath}`,
        context,
    });

    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(res.projectPath).toBe(newCustomPath);
    expect(context.settings.project_path).toBe(newCustomPath);
    expect(await fs.stat(newCustomPath)).toBeDefined();

    // Verify relative file creation now lands in newCustomPath
    const createFileRes = await handleSlashCommand({
        commandStr: `@create-file relative_sub/hello.js console.log('In custom project path');`,
        context,
    });
    expect(createFileRes.handled).toBe(true);

    const createdFilePath = path.join(newCustomPath, "relative_sub", "hello.js");
    expect(await Bun.file(createdFilePath).exists()).toBe(true);
    const content = await Bun.file(createdFilePath).text();
    expect(content).toBe("console.log('In custom project path');");
});

test("handleAtCommand @project-path shows current path when no arguments passed", async () => {
    const context = {
        settings: { model: "llama3.2:1b", project_path: path.join(TEST_DIR, "my_active_project") },
        messages: [],
    };

    const res = await handleSlashCommand({
        commandStr: "@project-path",
        context,
    });

    expect(res.handled).toBe(true);
    expect(res.projectPath).toBe(path.join(TEST_DIR, "my_active_project"));
});

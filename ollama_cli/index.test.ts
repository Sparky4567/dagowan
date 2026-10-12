import { test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { executeTool } from "./src/tools";
import { loadConfig, saveConfig } from "./src/config";

const TEST_DIR = path.resolve("./test_scratch");

beforeAll(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

test("write_file tool creates file and writes content", async () => {
  const filePath = path.join(TEST_DIR, "sample.txt");
  const content = "Line 1: Hello Bun\nLine 2: Ollama CLI\nLine 3: Test Content";
  
  const result = await executeTool("write_file", { file_path: filePath, content });
  expect(result).toContain("Successfully wrote");

  const readContent = await Bun.file(filePath).text();
  expect(readContent).toBe(content);
});

test("read_file tool reads file content with line range", async () => {
  const filePath = path.join(TEST_DIR, "sample.txt");
  const result = await executeTool("read_file", {
    file_path: filePath,
    start_line: 1,
    end_line: 2,
  });

  expect(result).toContain("Line 1: Hello Bun");
  expect(result).toContain("Line 2: Ollama CLI");
  expect(result).not.toContain("Line 3: Test Content");
});

test("list_directory tool lists directory items", async () => {
  const result = await executeTool("list_directory", { directory_path: TEST_DIR });
  expect(result).toContain("sample.txt");
});

test("run_command tool executes command and returns stdout", async () => {
  const result = await executeTool("run_command", { command: "echo 'Bun Ollama CLI Rules'" });
  expect(result).toContain("Bun Ollama CLI Rules");
});

test("search_files tool finds matches in files", async () => {
  const result = await executeTool("search_files", {
    query: "Ollama CLI",
    directory_path: TEST_DIR,
  });
  expect(result).toContain("sample.txt");
});

test("saveConfig and loadConfig handle configuration persistence", async () => {
  await saveConfig({ model: "test-model-llama", projectPath: "/custom/projects/path" });
  const config = await loadConfig();
  expect(config.model).toBe("test-model-llama");
  expect(config.projectPath).toBe("/custom/projects/path");
});

test("executeTool resolves relative file paths within basePath", async () => {
  const relFile = "subfolder/rel_test.txt";
  const content = "Relative file in basePath";
  
  const writeRes = await executeTool("write_file", { file_path: relFile, content }, TEST_DIR);
  expect(writeRes).toContain("Successfully wrote");

  const expectedAbsPath = path.join(TEST_DIR, "subfolder", "rel_test.txt");
  expect(await Bun.file(expectedAbsPath).exists()).toBe(true);

  const readRes = await executeTool("read_file", { file_path: relFile }, TEST_DIR);
  expect(readRes).toContain("Relative file in basePath");

  const listRes = await executeTool("list_directory", { directory_path: "subfolder" }, TEST_DIR);
  expect(listRes).toContain("rel_test.txt");

  const searchRes = await executeTool("search_files", { query: "Relative file" }, TEST_DIR);
  expect(searchRes).toContain("rel_test.txt");
});

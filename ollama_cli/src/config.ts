import os from "node:os";
import path from "node:path";

export interface Config {
  model?: string;
  ollamaUrl?: string;
  systemPrompt?: string;
  projectPath?: string;
}

const CONFIG_FILE = path.join(os.homedir(), ".ollama_cli.json");

export async function loadConfig(): Promise<Config> {
  try {
    const file = Bun.file(CONFIG_FILE);
    if (await file.exists()) {
      const text = await file.text();
      return JSON.parse(text);
    }
  } catch {
    // Return empty config on error
  }
  return {};
}

export async function saveConfig(config: Config): Promise<void> {
  try {
    const current = await loadConfig();
    const merged = { ...current, ...config };
    await Bun.write(CONFIG_FILE, JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error("Warning: Failed to save config:", err);
  }
}

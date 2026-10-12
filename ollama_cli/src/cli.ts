import { Command } from "commander";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { select, text, isCancel } from "@clack/prompts";
import chalk from "chalk";
import { loadConfig, saveConfig } from "./config";
import { OllamaService } from "./ollama";
import { Agent } from "./agent";
import {
  printLogo,
  printHeader,
  printSubHeader,
  printInfo,
  printWarning,
  printError,
  printSuccess,
  printRule,
  renderMarkdown,
} from "./ui";

const program = new Command();

async function selectModelInteractively(ollama: OllamaService, currentModel?: string): Promise<string | null> {
  const models = await ollama.getLocalModels();
  if (models.length === 0) {
    printError("Could not fetch model list from Ollama server at http://localhost:11434");
    return null;
  }

  const selected = await select({
    message: "Which Ollama model would you like to use?",
    options: models.map((m) => ({
      value: m,
      label: m + (m === currentModel ? " (current)" : ""),
    })),
    initialValue: currentModel && models.includes(currentModel) ? currentModel : models[0],
  });

  if (isCancel(selected)) {
    printWarning("Model selection cancelled.");
    return null;
  }

  return selected as string;
}

export async function runCli() {
  program
    .name("ollama-cli")
    .description("Ollama Code CLI: High-performance local AI coding assistant built with Bun")
    .version("1.0.0")
    .argument("[prompt...]", "Task for the assistant. If omitted, starts interactive REPL mode.")
    .option("-m, --model <model>", "Specify the Ollama model to use.")
    .option("-u, --url <url>", "Specify Ollama host URL (default: http://localhost:11434).")
    .option("-p, --project-path <path>", "Specify the project working directory path.")
    .option("--chat", "Start directly in Chat Mode (tools disabled).")
    .option("--code", "Start directly in Code Mode (tools enabled).")
    .parse(process.argv);

  const opts = program.opts();
  const args = program.args;
  const promptArg = args.join(" ").trim();

  const config = await loadConfig();
  const ollamaUrl = opts.url || config.ollamaUrl || "http://localhost:11434";
  const ollama = new OllamaService(ollamaUrl);

  // Resolve initial project working directory path
  let rawProjectPath = opts.projectPath || config.projectPath || process.cwd();
  if (rawProjectPath.startsWith("~")) {
    rawProjectPath = path.join(os.homedir(), rawProjectPath.slice(1));
  }
  let currentProjectPath = path.resolve(rawProjectPath);
  try {
    await fs.mkdir(currentProjectPath, { recursive: true });
  } catch {}

  let selectedModel = opts.model;

  if (!selectedModel) {
    const savedModel = config.model;
    const localModels = await ollama.getLocalModels();

    if (localModels.length > 0) {
      if (savedModel && localModels.includes(savedModel)) {
        selectedModel = savedModel;
      } else if (localModels.includes("llama3.2:1b")) {
        selectedModel = "llama3.2:1b";
      } else if (localModels.includes("llama3.1")) {
        selectedModel = "llama3.1";
      } else {
        selectedModel = localModels[0];
      }
    } else {
      printWarning("Could not fetch models from Ollama server. Defaulting to llama3.2:1b");
      selectedModel = "llama3.2:1b";
    }
  }

  printLogo();
  printHeader(`Starting Ollama Code CLI using model: ${chalk.cyan(selectedModel)}`);
  printInfo(`Endpoint: ${ollamaUrl}`);
  printInfo(`Project Path: ${currentProjectPath}`);

  const agent = new Agent(selectedModel, ollamaUrl, config.systemPrompt, currentProjectPath);

  if (opts.chat) {
    agent.setMode("chat");
    printSubHeader("Mode: Chat (Tools disabled)");
  } else {
    agent.setMode("code");
    printSubHeader("Mode: Code Assistant (Tools enabled)");
  }

  // Single-shot mode
  if (promptArg) {
    printRule("User Prompt", "cyan");
    console.log(chalk.bold(`> ${promptArg}\n`));
    printRule(`Ollama (${agent.getModel()})`, "magenta");
    await agent.runUserPrompt(promptArg);
    return;
  }

  // Interactive REPL Mode
  printRule();
  printInfo("Interactive mode started. Type '@help' for commands or '@bye' to exit.");

  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      const modeLabel = agent.getMode() === "code" ? chalk.magenta("[Code]") : chalk.blue("[Chat]");
      const promptStr = `\n${modeLabel} ${chalk.cyan("❯")} `;

      const inputLine = await rl.question(promptStr);
      const userStr = inputLine.trim();

      if (!userStr) continue;

      const lower = userStr.toLowerCase();
      if (lower === "exit" || lower === "quit" || lower === "@bye" || lower === "@exit" || lower === "/bye" || lower === "/exit") {
        printSuccess("Goodbye!");
        break;
      }

      // @ commands (MCP-style); leading "/" still accepted for backward compatibility.
      if (userStr.startsWith("@") || userStr.startsWith("/")) {
        // Normalized to "/" form so all parsing below works for either prefix
        // ("@" and "/" are both 1 char, so slice offsets are identical).
        const cmd = lower.startsWith("@") ? "/" + lower.slice(1) : lower;
        const cmdRaw = userStr.startsWith("@") ? "/" + userStr.slice(1) : userStr;
        if (cmd === "/help") {
          console.log(chalk.bold.cyan("\nAvailable Commands:"));
          console.log("  " + chalk.yellow("@help") + "                           - Show this help message");
          console.log("  " + chalk.yellow("@model") + " or " + chalk.yellow("@choose model") + "               - Interactively select Ollama model");
          console.log("  " + chalk.yellow("@change-project-path <path>") + "       - Set and persist project working directory");
          console.log("  " + chalk.yellow("@project-path") + "                       - View or update current project working directory");
          console.log("  " + chalk.yellow("@code") + "                            - Switch to Code Mode (tools enabled)");
          console.log("  " + chalk.yellow("@chat") + "                            - Switch to Chat Mode (tools disabled)");
          console.log("  " + chalk.yellow("@clear") + "                           - Clear conversation history and screen");
          console.log("  " + chalk.yellow("@history") + "                         - View conversation transcript history");
          console.log("  " + chalk.yellow("@system") + "                          - View or change current system prompt");
          console.log("  " + chalk.yellow("@bye") + " or " + chalk.yellow("exit") + "                     - Exit the session\n");
          continue;
        } else if (
          cmd.startsWith("/change-project-path") ||
          cmd.startsWith("/set-project-path") ||
          cmd.startsWith("/project-path") ||
          cmd.startsWith("/projects-path") ||
          cmd.startsWith("/cd")
        ) {
          const rawArg = cmdRaw.replace(/^[@/](change-project-path|set-project-path|project-path|projects-path|cd)/i, "").trim();
          let targetPath = rawArg;

          if (!targetPath) {
            console.log(chalk.bold.cyan("Current Project Path:"));
            console.log(`  ${currentProjectPath}\n`);
            const inputPath = await text({
              message: "Enter new project folder path (leave blank to keep current):",
              placeholder: currentProjectPath,
            });
            if (isCancel(inputPath) || typeof inputPath !== "string" || !inputPath.trim()) {
              continue;
            }
            targetPath = inputPath.trim();
          }

          if (targetPath.startsWith("~")) {
            targetPath = path.join(os.homedir(), targetPath.slice(1));
          }
          const absPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(process.cwd(), targetPath);

          try {
            await fs.mkdir(absPath, { recursive: true });
            currentProjectPath = absPath;
            agent.setProjectPath(absPath);
            await saveConfig({ projectPath: absPath });
            printSuccess(`Project path updated to: ${absPath} (saved to ~/.ollama_cli.json)`);
          } catch (err: any) {
            printError(`Failed to set project path: ${err.message || err}`);
          }
          continue;
        } else if (cmd === "/model" || cmd === "/choose model" || cmd === "/choose") {
          const picked = await selectModelInteractively(ollama, agent.getModel());
          if (picked) {
            agent.setModel(picked);
            await saveConfig({ model: picked });
            printSuccess(`Switched to model: ${picked}`);
          }
          continue;
        } else if (cmd === "/code") {
          agent.setMode("code");
          printSuccess("Switched to Code Mode (Tools enabled).");
          continue;
        } else if (cmd === "/chat") {
          agent.setMode("chat");
          printSuccess("Switched to Chat Mode (Tools disabled).");
          continue;
        } else if (cmd === "/clear") {
          agent.resetHistory();
          console.clear();
          printLogo();
          printSuccess("Conversation history and screen cleared.");
          continue;
        } else if (cmd === "/history") {
          printRule("Conversation History", "cyan");
          const history = agent.getHistory();
          history.forEach((m, idx) => {
            if (m.role === "system") return;
            console.log(chalk.bold(`[${idx}] ${m.role.toUpperCase()}:`));
            console.log(m.content ? m.content.substring(0, 200) + (m.content.length > 200 ? "..." : "") : "(no text content)");
            console.log();
          });
          continue;
        } else if (cmd === "/system") {
          console.log(chalk.bold.cyan("Current System Prompt:"));
          console.log(agent.getSystemPrompt());
          const newSys = await text({
            message: "Enter new system prompt (leave blank to keep current):",
            placeholder: agent.getSystemPrompt(),
          });
          if (!isCancel(newSys) && typeof newSys === "string" && newSys.trim()) {
            agent.setSystemPrompt(newSys.trim());
            await saveConfig({ systemPrompt: newSys.trim() });
            printSuccess("Updated system prompt.");
          }
          continue;
        } else {
          printWarning("Unknown @ command. Type @help for available commands.");
          continue;
        }
      }

      printRule(agent.getMode() === "code" ? `Ollama Code (${agent.getModel()})` : `Ollama Chat (${agent.getModel()})`, agent.getMode() === "code" ? "magenta" : "blue");
      await agent.runUserPrompt(userStr);
    }
  } finally {
    rl.close();
  }
}

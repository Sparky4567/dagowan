import type { Message } from "ollama";
import chalk from "chalk";
import { OllamaService } from "./ollama";
import { TOOLS, executeTool } from "./tools";
import { printMarkdown, printToolCall, printToolResult, createSpinner, printError } from "./ui";

export const DEFAULT_SYSTEM_PROMPT = `You are an expert AI coding assistant running locally on the user's machine.
You have access to tools to interact with the file system, run shell commands, and drive a shared local Chromium browser window (browser_open, browser_search_youtube, browser_play_youtube, browser_search_spotify, browser_play_spotify, browser_draft_blog, browser_read, browser_screenshot).
Use these tools to help the user with their coding tasks.
When writing code, always ensure you provide clean, well-documented, and working code.
Think step-by-step and use tools when necessary.
For web/YouTube/Spotify requests, prefer the browser_* tools over run_command so navigation stays inside the allowlisted browser window.
When writing code, always ensure you provide clean, well-documented, and working code.
Think step-by-step and use tools when necessary.

When you use write_file, it will create or overwrite the file.
Always read existing files first before overwriting if you need to modify them.`;

export class Agent {
  private ollama: OllamaService;
  private model: string;
  private messages: Message[] = [];
  private mode: "code" | "chat" = "code";
  private systemPrompt: string;
  private projectPath?: string;
  private maxToolSteps: number = 10;
  private mcpSettings: Record<string, any> = {};

  constructor(model: string, ollamaUrl?: string, systemPrompt?: string, projectPath?: string, mcpSettings?: Record<string, any>) {
    this.model = model;
    this.ollama = new OllamaService(ollamaUrl);
    this.systemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.projectPath = projectPath;
    this.mcpSettings = mcpSettings || {};
    this.resetHistory();
  }

  public setModel(model: string) {
    this.model = model;
  }

  public getModel(): string {
    return this.model;
  }

  public setProjectPath(projectPath?: string) {
    this.projectPath = projectPath;
  }

  public getProjectPath(): string | undefined {
    return this.projectPath;
  }

  public setMcpSettings(settings: Record<string, any>) {
    this.mcpSettings = settings || {};
  }

  public getMcpSettings(): Record<string, any> {
    return this.mcpSettings;
  }

  private async getCombinedTools(): Promise<Array<any>> {
    if (this.mode !== "code") return [];
    try {
      const mod: any = await import("../../src/mcp.js");
      if (mod && mod.isMcpEnabled && mod.isMcpEnabled(this.mcpSettings) && mod.getMcpManager) {
        const mgr = mod.getMcpManager();
        const mcpTools = await mgr.listTools(this.mcpSettings);
        if (Array.isArray(mcpTools) && mcpTools.length > 0) {
          return [...TOOLS, ...mcpTools];
        }
      }
    } catch (err: any) {
      console.warn(`MCP tool discovery failed, continuing with built-in tools: ${err?.message || err}`);
    }
    return [...TOOLS];
  }

  private async runMcpOrLocalTool(name: string, args: Record<string, any>): Promise<string> {
    try {
      const mod: any = await import("../../src/mcp.js");
      if (mod && mod.splitMcpToolName && mod.splitMcpToolName(name) && mod.getMcpManager) {
        if (mod.isMcpEnabled && !mod.isMcpEnabled(this.mcpSettings)) {
          return executeTool(name, args, this.projectPath);
        }
        return await mod.getMcpManager().callTool(name, args, this.mcpSettings);
      }
    } catch (err: any) {
      console.warn(`MCP tool '${name}' failed, falling back to built-in tools: ${err?.message || err}`);
    }
    return executeTool(name, args, this.projectPath);
  }

  public setMode(mode: "code" | "chat") {
    this.mode = mode;
  }

  public getMode(): "code" | "chat" {
    return this.mode;
  }

  public setSystemPrompt(prompt: string) {
    this.systemPrompt = prompt;
    if (this.messages.length > 0 && this.messages[0].role === "system") {
      this.messages[0].content = prompt;
    }
  }

  public getSystemPrompt(): string {
    return this.systemPrompt;
  }

  public resetHistory() {
    this.messages = [
      {
        role: "system",
        content: this.systemPrompt,
      },
    ];
  }

  public getHistory(): Message[] {
    return this.messages;
  }

  public async runUserPrompt(userPrompt: string): Promise<string> {
    this.messages.push({
      role: "user",
      content: userPrompt,
    });

    const isCodeMode = this.mode === "code";
    let currentStep = 0;
    const combinedTools = isCodeMode ? await this.getCombinedTools() : [];

    while (currentStep < this.maxToolSteps) {
      currentStep++;

      const spinner = createSpinner(
        currentStep === 1
          ? isCodeMode
            ? "Agent thinking & selecting tools..."
            : "Generating chat response..."
          : `Agent executing step ${currentStep}...`
      );

      let chunkStreamed = false;
      let thinkingStreamed = false;

      try {
        spinner.start();

        const { responseMessage, toolCalls } = await this.ollama.chatStream(
          this.model,
          this.messages,
          isCodeMode ? combinedTools : false,
          (chunk) => {
            if (spinner.isSpinning) {
              spinner.stop();
            }
            chunkStreamed = true;
            process.stdout.write(chunk);
          },
          (thinkingChunk) => {
            if (spinner.isSpinning) {
              spinner.stop();
            }
            if (!thinkingStreamed) {
              thinkingStreamed = true;
              process.stdout.write(chalk.gray("\n💭 Thinking: "));
            }
            process.stdout.write(chalk.gray(thinkingChunk));
          }
        );

        if (spinner.isSpinning) {
          spinner.stop();
        }

        if (thinkingStreamed) {
          process.stdout.write("\n\n");
        }

        if (chunkStreamed) {
          process.stdout.write("\n\n");
        }

        // Add assistant message to history
        this.messages.push(responseMessage);

        // If no tool calls, response is complete!
        if (!toolCalls || toolCalls.length === 0) {
          if (!chunkStreamed && responseMessage.content) {
            printMarkdown(responseMessage.content);
            console.log();
          }
          break;
        }

        // Handle Tool Calls
        for (const call of toolCalls) {
          printToolCall(call.name, call.args);

          const toolSpinner = createSpinner(`Executing ${call.name}...`);
          toolSpinner.start();
          const result = await this.runMcpOrLocalTool(call.name, call.args);
          toolSpinner.stop();

          printToolResult(result);

          // Append tool result to history
          this.messages.push({
            role: "tool",
            content: result,
          });
        }
      } catch (err: any) {
        if (spinner.isSpinning) {
          spinner.stop();
        }
        printError(err.message || String(err));
        break;
      }
    }

    const lastAssistantMsg = [...this.messages].reverse().find((m) => m.role === "assistant");
    return lastAssistantMsg?.content || "Coding task completed.";
  }
}

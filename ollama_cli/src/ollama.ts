import { Ollama, type Message } from "ollama";
import { TOOLS, type ToolDefinition } from "./tools";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, any>;
    };
  }>;
}

export interface ChatStreamResult {
  responseMessage: Message;
  toolCalls?: Array<{ name: string; args: Record<string, any> }>;
  thinking?: string;
}

export class OllamaService {
  private client: Ollama;
  private host: string;

  constructor(host: string = "http://localhost:11434") {
    this.host = host.replace(/\/+$/, "");
    this.client = new Ollama({ host: this.host });
  }

  public setHost(host: string) {
    this.host = host.replace(/\/+$/, "");
    this.client = new Ollama({ host: this.host });
  }

  public async getLocalModels(): Promise<string[]> {
    try {
      const response = await this.client.list();
      return response.models.map((m) => m.name);
    } catch {
      try {
        const res = await fetch(`${this.host}/api/tags`);
        if (res.ok) {
          const data = (await res.json()) as { models?: Array<{ name: string }> };
          return (data.models || []).map((m) => m.name);
        }
      } catch {
        // Silently catch
      }
      return [];
    }
  }

  public async chatStream(
    model: string,
    messages: Message[],
    enableTools: boolean | ToolDefinition[] = true,
    onChunk?: (text: string) => void,
    onThinkingChunk?: (text: string) => void
  ): Promise<ChatStreamResult> {
    const tools = (Array.isArray(enableTools) ? enableTools : enableTools ? TOOLS : undefined) as any;

    let fullContent = "";
    let fullThinking = "";
    let accumulatedToolCalls: Array<{ name: string; args: Record<string, any> }> = [];

    try {
      const stream = await this.client.chat({
        model,
        messages,
        tools,
        stream: true,
      });

      for await (const chunk of stream) {
        // Handle thinking/reasoning output if present
        if ((chunk.message as any)?.thinking) {
          const thinkingText = (chunk.message as any).thinking;
          fullThinking += thinkingText;
          if (onThinkingChunk) {
            onThinkingChunk(thinkingText);
          }
        }

        if (chunk.message?.content) {
          fullContent += chunk.message.content;
          if (onChunk) {
            onChunk(chunk.message.content);
          }
        }

        if (chunk.message?.tool_calls) {
          for (const tc of chunk.message.tool_calls) {
            accumulatedToolCalls.push({
              name: tc.function.name,
              args: tc.function.arguments || {},
            });
          }
        }
      }

      const responseMessage: Message = {
        role: "assistant",
        content: fullContent,
      };

      if (accumulatedToolCalls.length > 0) {
        (responseMessage as any).tool_calls = accumulatedToolCalls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: tc.args,
          },
        }));
      }

      return {
        responseMessage,
        toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
        thinking: fullThinking.trim() || undefined,
      };
    } catch (err: any) {
      throw new Error(`Ollama Chat Error: ${err.message || String(err)}`);
    }
  }
}

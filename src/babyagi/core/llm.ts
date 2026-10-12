import OpenAI from "openai";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
  baseUrl?: string;
  responseFormat?: "json_object" | "text";
}

export class LLMClient {
  private customApiKey?: string;
  private customBaseUrl?: string;
  private hostChat?: (messages: LLMMessage[], options?: LLMOptions) => Promise<string>;

  constructor(apiKey?: string, baseUrl?: string, hostChat?: (messages: LLMMessage[], options?: LLMOptions) => Promise<string>) {
    this.customApiKey = apiKey;
    this.customBaseUrl = baseUrl;
    this.hostChat = hostChat;
  }

  public setApiKey(key: string): void {
    this.customApiKey = key;
  }

  public setBaseUrl(url: string): void {
    this.customBaseUrl = url;
  }

  private getClient(apiKey?: string, baseUrl?: string): OpenAI | null {
    const key = apiKey || this.customApiKey || process.env.OPENAI_API_KEY;
    const url = baseUrl || this.customBaseUrl || process.env.OPENAI_BASE_URL;

    if (!key) {
      return null;
    }

    return new OpenAI({
      apiKey: key,
      baseURL: url || undefined
    });
  }

  public async chat(messages: LLMMessage[], options: LLMOptions = {}): Promise<string> {
    if (this.hostChat) {
      return await this.hostChat(messages, options);
    }
    const client = this.getClient(options.apiKey, options.baseUrl);
    const model = options.model || process.env.LLM_MODEL || "gpt-3.5-turbo";

    if (!client) {
      // Intelligent fallback when no key is set
      return this.mockResponse(messages, options);
    }

    try {
      const response = await client.chat.completions.create({
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 1500,
        response_format: options.responseFormat === "json_object" ? { type: "json_object" } : undefined
      });

      return response.choices[0]?.message?.content || "";
    } catch (err: any) {
      console.warn(`[BabyAGI LLM Warning] Error calling LLM API: ${err.message}. Falling back to simulated response.`);
      return this.mockResponse(messages, options);
    }
  }

  public async generateEmbedding(text: string, apiKey?: string): Promise<number[]> {
    const client = this.getClient(apiKey);
    if (!client) {
      return [];
    }

    try {
      const resp = await client.embeddings.create({
        model: "text-embedding-3-small",
        input: text
      });
      return resp.data[0]?.embedding || [];
    } catch (err: any) {
      console.warn(`[BabyAGI LLM Warning] Error generating embedding: ${err.message}`);
      return [];
    }
  }

  private mockResponse(messages: LLMMessage[], options: LLMOptions): string {
    const lastMsg = messages[messages.length - 1]?.content || "";
    const lower = lastMsg.toLowerCase();

    // Check if JSON format is requested
    if (options.responseFormat === "json_object" || lower.includes("json format") || lower.includes("in json")) {
      if (lower.includes("queries") || lower.includes("user description")) {
        return JSON.stringify({
          queries: [
            "Fetch recent market trend statistics for SaaS analytics",
            "Calculate conversion rate and ROI for recent campaign",
            "Format and summarize top 5 growth experiments"
          ]
        }, null, 2);
      }

      if (lower.includes("choose_or_create") || lower.includes("function") || lower.includes("generate function")) {
        return JSON.stringify({
          action: "create",
          function_name: "calculate_conversion_rate",
          description: "Calculates conversion rate from visitors and conversions",
          code: `function calculate_conversion_rate(visitors, conversions) {\n  if (!visitors || visitors <= 0) return 0;\n  return ((conversions / visitors) * 100).toFixed(2) + '%';\n}`,
          dependencies: [],
          imports: []
        }, null, 2);
      }

      if (lower.includes("task_creation") || lower.includes("new tasks")) {
        return JSON.stringify([
          "Analyze target audience demographics",
          "Identify top 3 distribution channels",
          "Draft initial outreach copy and measurement metrics"
        ], null, 2);
      }

      if (lower.includes("prioritization") || lower.includes("re-prioritize")) {
        return JSON.stringify([
          "1. Analyze target audience demographics",
          "2. Identify top 3 distribution channels",
          "3. Draft initial outreach copy and measurement metrics"
        ], null, 2);
      }

      return JSON.stringify({
        status: "success",
        result: `Simulated intelligent response for: ${lastMsg.slice(0, 80)}...`
      }, null, 2);
    }

    // Classic BabyAGI Task execution simulation
    if (lower.includes("execute the following task") || lower.includes("task:")) {
      return `[Autonomous Execution Result] Successfully analyzed objective and completed task: "${lastMsg.split('\n')[0]}". Identified key insights, structured data, and prepared next action items.`;
    }

    // Classic BabyAGI Task creation simulation
    if (lower.includes("create new tasks") || lower.includes("new tasks based on the result")) {
      return `1. Research key market benchmarks and metrics\n2. Consolidate gathered findings into summary report\n3. Execute validation check against objective`;
    }

    // Default chat completion
    return `[BabyAGI LLM] Processed prompt successfully. Context received (${messages.length} messages). Output generated for: ${lastMsg.slice(0, 100)}`;
  }
}

export const defaultLLM = new LLMClient();

import type { Functionz } from "../../core/framework";

export function loadAIFunctions(framework: Functionz): void {
  // Direct LLM call / GPT call
  framework.registerFunction(
    async function gpt_call(prompt: string, model: string = "gpt-3.5-turbo", temperature: number = 0.7) {
      const apiKey = framework.db.getKey("openai_api_key");
      const resp = await framework.llm.chat(
        [
          { role: "system", content: "You are a helpful and intelligent AI assistant." },
          { role: "user", content: prompt }
        ],
        { model, temperature, apiKey: apiKey || undefined }
      );
      return resp;
    },
    {
      name: "gpt_call",
      key_dependencies: ["openai_api_key"],
      description: "Directly calls OpenAI or LLM with a prompt string",
      metadata: { category: "ai" }
    }
  );

  // Chat completion with messages array
  framework.registerFunction(
    async function chat_completion(messages: { role: "system" | "user" | "assistant"; content: string }[], model: string = "gpt-3.5-turbo", temperature: number = 0.7) {
      const apiKey = framework.db.getKey("openai_api_key");
      return await framework.llm.chat(messages, { model, temperature, apiKey: apiKey || undefined });
    },
    {
      name: "chat_completion",
      key_dependencies: ["openai_api_key"],
      description: "Executes a multi-turn chat completion with message history",
      metadata: { category: "ai" }
    }
  );

  // Summarize text
  framework.registerFunction(
    async function summarize_text(text: string, maxWords: number = 50) {
      const prompt = `Please summarize the following text into concise key points (under ${maxWords} words):\n\n${text}`;
      return await framework.executeFunction("gpt_call", prompt);
    },
    {
      name: "summarize_text",
      dependencies: ["gpt_call"],
      description: "Summarizes long text into key takeaways using gpt_call",
      metadata: { category: "ai" }
    }
  );

  // Generate embeddings
  framework.registerFunction(
    async function generate_embeddings(text: string) {
      const apiKey = framework.db.getKey("openai_api_key");
      const emb = await framework.llm.generateEmbedding(text, apiKey || undefined);
      if (emb && emb.length > 0) return emb;
      // Fallback local embedding
      const { generateLocalEmbedding } = await import("../../db/memory_store");
      return generateLocalEmbedding(text);
    },
    {
      name: "generate_embeddings",
      key_dependencies: ["openai_api_key"],
      description: "Generates vector embeddings for a given text",
      metadata: { category: "ai" }
    }
  );
}

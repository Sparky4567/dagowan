import { Functionz } from "./babyagi";
import { loadPack } from "./babyagi/packs";
import { unifiedChat } from "./providers.js";

let framework: Functionz | null = null;

async function getFramework(settings: Record<string, any>): Promise<Functionz> {
  if (framework) return framework;

  framework = new Functionz({
    dbPath: "data/babyagi.sqlite",
    defaultModel: settings.model,
    chat: async (messages, options) => {
      const response = await unifiedChat({
        modelName: options?.model || settings.model || "llama3",
        messages,
        settings,
      });
      return response.content || "";
    },
  });

  // The classic pack supplies the original BabyAGI execution, task-creation,
  // prioritization, and memory-retrieval agents without registering OS tools.
  await loadPack(framework, "classic");
  return framework;
}

export async function runBabyAGI(objective: string, settings: Record<string, any>, maxIterations = 3) {
  const engine = await getFramework(settings);
  return await engine.runClassicLoop({
    objective,
    maxIterations: Math.max(1, Math.min(20, maxIterations)),
  });
}

export async function getBabyAGIStatus(settings: Record<string, any>) {
  const engine = await getFramework(settings);
  return {
    functions: engine.getAllFunctions().map((fn) => fn.name),
    executionLogs: engine.db.getLogCount(),
    memoryItems: engine.db.getAllVectors().length,
  };
}

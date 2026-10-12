// BabyAGI - TypeScript/Bun Implementation
// Main public API module
// Inspired by https://github.com/yoheinakajima/babyagi

export { Functionz, babyagi, func } from "./core/framework";
export { SQLiteDB } from "./db/sqlite_db";
export { MemoryStore, cosineSimilarity, generateLocalEmbedding } from "./db/memory_store";
export { LLMClient, defaultLLM } from "./core/llm";
export { FunctionExecutor } from "./core/execution";
export { FunctionRegistrar } from "./core/registration";
export { loadDefaultPacks, loadPack } from "./packs";

export type {
  FunctionMetadata,
  FunctionVersion,
  ExecutionLog,
  RegisterFunctionOptions,
  VectorDocument,
  TaskItem,
  ClassicBabyAGIConfig,
  BabyAGIConfig,
  SelfBuildConfig,
} from "./types";

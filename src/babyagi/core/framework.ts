import { SQLiteDB } from "../db/sqlite_db";
import { MemoryStore } from "../db/memory_store";
import { LLMClient } from "./llm";
import { FunctionExecutor } from "./execution";
import { FunctionRegistrar } from "./registration";
import type { FunctionMetadata, FunctionVersion, ExecutionLog, RegisterFunctionOptions, BabyAGIConfig, SelfBuildConfig, ClassicBabyAGIConfig } from "../types";

export class Functionz {
  public db: SQLiteDB;
  public memory: MemoryStore;
  public llm: LLMClient;
  public executor: FunctionExecutor;
  public registrar: FunctionRegistrar;
  public config: BabyAGIConfig;

  constructor(config: BabyAGIConfig = {}) {
    this.config = config;
    this.db = new SQLiteDB(config.dbPath || "babyagi.sqlite");
    this.memory = new MemoryStore(this.db);
    this.llm = new LLMClient(config.openaiApiKey, config.openaiBaseUrl, config.chat);
    this.executor = new FunctionExecutor(this);
    this.registrar = new FunctionRegistrar(this);

    // Return a Proxy so that `babyagi.my_func(...)` can dynamically call registered functions
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !(prop in target)) {
          const fnMeta = target.db.getFunction(prop);
          if (fnMeta) {
            return (...args: any[]) => target.executor.execute(prop, ...args);
          }
        }
        return Reflect.get(target, prop, receiver);
      }
    });
  }

  // --- Function Registration ---
  public register_function(optionsOrFn: RegisterFunctionOptions | Function, maybeOptions?: RegisterFunctionOptions): any {
    return this.registrar.registerFunction(optionsOrFn, maybeOptions);
  }

  public registerFunction(optionsOrFn: RegisterFunctionOptions | Function, maybeOptions?: RegisterFunctionOptions): any {
    return this.registrar.registerFunction(optionsOrFn, maybeOptions);
  }

  public registerCode(name: string, code: string, options: Omit<RegisterFunctionOptions, "name" | "code"> = {}): FunctionMetadata {
    return this.registrar.registerCode(name, code, options);
  }

  // --- Function Execution ---
  public async execute_function(functionName: string, ...args: any[]): Promise<any> {
    return await this.executor.execute(functionName, ...args);
  }

  public async executeFunction(functionName: string, ...args: any[]): Promise<any> {
    return await this.executor.execute(functionName, ...args);
  }

  // --- Function Inspection & Management ---
  public get_function(name: string): FunctionMetadata | null {
    return this.db.getFunction(name);
  }

  public getFunction(name: string): FunctionMetadata | null {
    return this.db.getFunction(name);
  }

  public get_all_functions(): FunctionMetadata[] {
    return this.db.getAllFunctions();
  }

  public getAllFunctions(): FunctionMetadata[] {
    return this.db.getAllFunctions();
  }

  public delete_function(name: string): boolean {
    this.registrar.removeInMemoryFunction(name);
    return this.db.deleteFunction(name);
  }

  public deleteFunction(name: string): boolean {
    return this.delete_function(name);
  }

  public get_function_versions(name: string): FunctionVersion[] {
    return this.db.getFunctionVersions(name);
  }

  public getFunctionVersions(name: string): FunctionVersion[] {
    return this.db.getFunctionVersions(name);
  }

  public activate_function_version(name: string, version: number): boolean {
    return this.db.activateFunctionVersion(name, version);
  }

  public activateFunctionVersion(name: string, version: number): boolean {
    return this.db.activateFunctionVersion(name, version);
  }

  // --- Secret Keys ---
  public add_key_wrapper(keyName: string, value: string): void {
    this.db.setKey(keyName, value);
    if (keyName.toLowerCase().includes("openai")) {
      this.llm.setApiKey(value);
    }
  }

  public setKey(keyName: string, value: string): void {
    this.add_key_wrapper(keyName, value);
  }

  public getKey(keyName: string): string | null {
    return this.db.getKey(keyName);
  }

  public getAllKeys() {
    return this.db.getAllKeys();
  }

  // --- Logs ---
  public get_logs(filter?: { function_name?: string; limit?: number; offset?: number }): ExecutionLog[] {
    return this.db.getLogs(filter);
  }

  public getLogs(filter?: { function_name?: string; limit?: number; offset?: number }): ExecutionLog[] {
    return this.db.getLogs(filter);
  }

  public getLog(logId: string): ExecutionLog | null {
    return this.db.getLog(logId);
  }

  public getLogTree(rootLogId: string): ExecutionLog[] {
    return this.db.getLogTree(rootLogId);
  }

  // --- Load Built-in & Custom Packs ---
  public async load_functions(packNameOrPath: string): Promise<void> {
    const { loadPack } = await import("../packs");
    await loadPack(this, packNameOrPath);
  }

  public async loadFunctions(packNameOrPath: string): Promise<void> {
    await this.load_functions(packNameOrPath);
  }

  // --- Self-Building Agent ---
  public async self_build(userDescriptionOrConfig: string | SelfBuildConfig): Promise<any> {
    const config: SelfBuildConfig = typeof userDescriptionOrConfig === "string"
      ? { userDescription: userDescriptionOrConfig }
      : userDescriptionOrConfig;

    const { runSelfBuild } = await import("../packs/drafts/self_build");
    return await runSelfBuild(this, config);
  }

  public async selfBuild(config: string | SelfBuildConfig): Promise<any> {
    return await this.self_build(config);
  }

  // --- Classic BabyAGI Autonomous Loop ---
  public async run_classic_loop(config: ClassicBabyAGIConfig): Promise<any> {
    const { runClassicBabyAGILoop } = await import("../packs/classic/classic_loop");
    return await runClassicBabyAGILoop(this, config);
  }

  public async runClassicLoop(config: ClassicBabyAGIConfig): Promise<any> {
    return await this.run_classic_loop(config);
  }

  // --- Create Web App ---
  public create_app(dashboardRoute: string = "/dashboard") {
    const { createServer } = require("../dashboard/server");
    return createServer(this, { dashboardRoute });
  }

  public createApp(dashboardRoute: string = "/dashboard") {
    return this.create_app(dashboardRoute);
  }
}

// Global default singleton
// Keep the default instance inside the application's runtime data directory.
// The host integration creates its own instance with the same location.
export const babyagi = new Functionz({ dbPath: process.env.BABYAGI_DB_PATH || "data/babyagi.sqlite" });
export const func = babyagi;

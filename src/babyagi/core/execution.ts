import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { FunctionMetadata, ExecutionLog } from "../types";
import type { Functionz } from "./framework";

// Execution context to track parent log IDs across nested function calls
interface ExecutionContext {
  parentLogId: string | null;
}

export const executionContextStorage = new AsyncLocalStorage<ExecutionContext>();

export class FunctionExecutor {
  private framework: Functionz;

  constructor(framework: Functionz) {
    this.framework = framework;
  }

  public async execute(functionName: string, ...args: any[]): Promise<any> {
    const fnMeta = this.framework.getFunction(functionName);
    if (!fnMeta) {
      throw new Error(`Function '${functionName}' not found in registry.`);
    }

    const logId = randomUUID();
    const currentContext = executionContextStorage.getStore();
    const parentLogId = currentContext?.parentLogId || null;

    const startTime = performance.now();
    let result: any = null;
    let errorStr: string | null = null;

    try {
      // Execute within new AsyncLocalStorage scope with current logId as parent for downstream calls
      result = await executionContextStorage.run({ parentLogId: logId }, async () => {
        return await this.runFunctionImplementation(fnMeta, args);
      });
      return result;
    } catch (err: any) {
      errorStr = err?.stack || err?.message || String(err);
      throw err;
    } finally {
      const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
      const log: ExecutionLog = {
        log_id: logId,
        function_name: functionName,
        version: fnMeta.version,
        input_args: args,
        input_kwargs: {},
        output_result: result,
        error: errorStr,
        execution_time_ms: durationMs,
        timestamp: new Date().toISOString(),
        parent_log_id: parentLogId
      };

      try {
        this.framework.db.logExecution(log);
      } catch (logErr) {
        console.error(`Failed to log execution for ${functionName}:`, logErr);
      }
    }
  }

  private async runFunctionImplementation(fnMeta: FunctionMetadata, args: any[]): Promise<any> {
    // 1. Resolve registered in-memory function if available
    const inMemoryFn = this.framework.registrar.getInMemoryFunction(fnMeta.name);
    if (inMemoryFn) {
      return await inMemoryFn(...args);
    }

    // 2. Build sandbox context with dependencies and keys
    const sandboxScope: Record<string, any> = {
      console,
      Math,
      Date,
      JSON,
      parseInt,
      parseFloat,
      setTimeout,
      clearTimeout,
      Promise,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Error
    };

    // Inject babyagi framework instance
    sandboxScope.babyagi = this.framework;
    sandboxScope.func = this.framework;

    // Inject dependent functions
    if (fnMeta.dependencies && Array.isArray(fnMeta.dependencies)) {
      for (const depName of fnMeta.dependencies) {
        sandboxScope[depName] = async (...depArgs: any[]) => {
          return await this.framework.executeFunction(depName, ...depArgs);
        };
      }
    }

    // Inject secret keys if specified
    if (fnMeta.key_dependencies && Array.isArray(fnMeta.key_dependencies)) {
      for (const keyName of fnMeta.key_dependencies) {
        const val = this.framework.db.getKey(keyName);
        sandboxScope[keyName] = val;
      }
    }

    // Evaluate code string
    return await this.evaluateCode(fnMeta.code, fnMeta.name, sandboxScope, args);
  }

  private async evaluateCode(codeStr: string, functionName: string, scope: Record<string, any>, args: any[]): Promise<any> {
    let cleanCode = codeStr.trim();

    // Prepare AsyncFunction constructor
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

    // Build scope arguments
    const scopeKeys = Object.keys(scope);
    const scopeValues = Object.values(scope);

    // If code is a function declaration: `function foo(a, b) { ... }` or `async function foo(a, b) { ... }`
    // or arrow function `(a, b) => ...`
    let runnerBody = "";
    if (cleanCode.startsWith("function") || cleanCode.startsWith("async function")) {
      runnerBody = `
        ${cleanCode}
        return await ${functionName}(...args);
      `;
    } else if (cleanCode.startsWith("(") || cleanCode.includes("=>")) {
      runnerBody = `
        const fn = ${cleanCode};
        return await fn(...args);
      `;
    } else {
      // Code is a raw body
      runnerBody = `
        ${cleanCode}
      `;
    }

    try {
      const runner = new AsyncFunction(...scopeKeys, "args", runnerBody);
      return await runner(...scopeValues, args);
    } catch (err: any) {
      throw new Error(`Execution error in function '${functionName}': ${err.message}`);
    }
  }
}

import type { RegisterFunctionOptions, FunctionMetadata } from "../types";
import type { Functionz } from "./framework";

export class FunctionRegistrar {
  private framework: Functionz;
  private inMemoryFunctions: Map<string, Function> = new Map();

  constructor(framework: Functionz) {
    this.framework = framework;
  }

  public registerFunction(optionsOrFn: RegisterFunctionOptions | Function, maybeOptions?: RegisterFunctionOptions): any {
    // Overload 1: direct registration with options or function
    if (typeof optionsOrFn === "function") {
      const fn = optionsOrFn;
      const options = maybeOptions || {};
      const name = options.name || fn.name;
      if (!name) {
        throw new Error("Function must have a name.");
      }
      return this.doRegister(name, fn.toString(), fn, options);
    }

    // Overload 2: decorator or higher-order wrapper: babyagi.register_function(opts)(fn)
    const options = optionsOrFn;
    return (targetFn: Function) => {
      const name = options.name || targetFn.name;
      if (!name) {
        throw new Error("Target function must have a name.");
      }
      return this.doRegister(name, targetFn.toString(), targetFn, options);
    };
  }

  public registerCode(name: string, code: string, options: Omit<RegisterFunctionOptions, "name" | "code"> = {}): FunctionMetadata {
    return this.doRegister(name, code, undefined, { ...options, name, code });
  }

  private doRegister(name: string, code: string, fn?: Function, options: RegisterFunctionOptions = {}): FunctionMetadata {
    const desc = options.description || options.metadata?.description || "";
    const imports = options.imports || [];
    const dependencies = options.dependencies || [];
    const keyDependencies = options.key_dependencies || [];
    const metadata = options.metadata || {};

    if (fn) {
      this.inMemoryFunctions.set(name, fn);
    }

    const saved = this.framework.db.saveFunction({
      name,
      code,
      description: desc,
      imports,
      dependencies,
      key_dependencies: keyDependencies,
      metadata,
      version: options.version,
      is_active: true
    });

    return saved;
  }

  public getInMemoryFunction(name: string): Function | undefined {
    return this.inMemoryFunctions.get(name);
  }

  public removeInMemoryFunction(name: string): void {
    this.inMemoryFunctions.delete(name);
  }
}

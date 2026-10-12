import type { Functionz } from "../../core/framework";

export function loadCodeWritingFunctions(framework: Functionz): void {
  // Generate function code from specification
  framework.registerFunction(
    async function generate_function_code(prompt: string, functionName: string, dependencies: string[] = []) {
      const apiKey = framework.db.getKey("openai_api_key");
      const systemPrompt = `You are an expert TypeScript/JavaScript engineer. Write a clean, working JavaScript function.
Rules:
1. Return ONLY the function declaration. E.g.:
async function ${functionName}(arg1, arg2) {
  // implementation
  return result;
}
2. Do not include markdown backticks (\`\`\`), markdown text, or explanations.
3. If dependencies are provided (${JSON.stringify(dependencies)}), you can call them directly by name as asynchronous functions (e.g. await depName(arg)).
`;

      const response = await framework.llm.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Write function '${functionName}' for the following purpose:\n${prompt}` }
        ],
        { apiKey: apiKey || undefined, temperature: 0.2 }
      );

      // Clean up any stray markdown formatting
      let code = response.trim();
      if (code.startsWith("```javascript") || code.startsWith("```typescript") || code.startsWith("```js") || code.startsWith("```ts")) {
        code = code.replace(/```[a-z]*\n?/i, "").replace(/```$/, "").trim();
      } else if (code.startsWith("```")) {
        code = code.replace(/```\n?/i, "").replace(/```$/, "").trim();
      }

      return code;
    },
    {
      name: "generate_function_code",
      dependencies: ["gpt_call"],
      description: "Generates JavaScript function code based on a prompt and function name",
      metadata: { category: "self_build" }
    }
  );

  // Validate and test function in sandbox
  framework.registerFunction(
    async function test_function(code: string, functionName: string, testArgs: any[] = []) {
      try {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const runnerBody = `
          ${code}
          return await ${functionName}(...args);
        `;
        const runner = new AsyncFunction("console", "Math", "Date", "JSON", "args", runnerBody);
        const result = await runner(console, Math, Date, JSON, testArgs);
        return { success: true, result, error: null };
      } catch (err: any) {
        return { success: false, result: null, error: err.message };
      }
    },
    {
      name: "test_function",
      description: "Tests a function code string in an isolated sandbox with test arguments",
      metadata: { category: "self_build" }
    }
  );
}

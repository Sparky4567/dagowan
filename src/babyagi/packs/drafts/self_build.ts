import type { Functionz } from "../../core/framework";
import type { SelfBuildConfig } from "../../types";

export function loadSelfBuildFunctions(framework: Functionz): void {
  // Generate queries based on user description
  framework.registerFunction(
    async function generate_queries(userDescription: string, count: number = 3) {
      const apiKey = framework.db.getKey("openai_api_key");
      const prompt = `You are an AI assistant. Based on the following user persona/description, generate ${count} realistic, diverse, action-oriented queries that such a user might request.
Ensure each query requires a specific computational or utility tool/function (e.g. data processing, calculation, text manipulation, API simulation).

User Description:
"${userDescription}"

Respond in valid JSON format:
{
  "queries": [
    "query 1...",
    "query 2...",
    "query 3..."
  ]
}`;

      const response = await framework.llm.chat(
        [{ role: "user", content: prompt }],
        { apiKey: apiKey || undefined, responseFormat: "json_object", temperature: 0.7 }
      );

      try {
        const parsed = JSON.parse(response);
        return Array.isArray(parsed.queries) ? parsed.queries : (Array.isArray(parsed) ? parsed : [response]);
      } catch {
        return [
          `Analyze metrics for ${userDescription.slice(0, 30)}`,
          `Calculate growth projections for ${userDescription.slice(0, 30)}`,
          `Format report for ${userDescription.slice(0, 30)}`
        ];
      }
    },
    {
      name: "generate_queries",
      key_dependencies: ["openai_api_key"],
      description: "Generates realistic tool-driven queries based on a user persona or objective",
      metadata: { category: "self_build" }
    }
  );

  // Choose existing or create new function for query
  framework.registerFunction(
    async function choose_or_create_function(query: string) {
      const allFunctions = framework.getAllFunctions();
      const fnCatalog = allFunctions.map((f) => ({
        name: f.name,
        description: f.description || f.metadata?.description || "",
        dependencies: f.dependencies
      }));

      const apiKey = framework.db.getKey("openai_api_key");
      const prompt = `You are the self-building agent engine. Given the user query and the list of currently available functions, determine whether an existing function can satisfy the query or if you need to create a new JavaScript function.

Query: "${query}"

Available Functions:
${JSON.stringify(fnCatalog, null, 2)}

Instructions:
1. If an existing function matches, respond with:
{
  "action": "use",
  "function_name": "<existing_name>",
  "reason": "..."
}

2. If a new function is needed, generate the function name, description, dependencies (from available functions), and full working JavaScript function code:
{
  "action": "create",
  "function_name": "<valid_snake_case_name>",
  "description": "<what this function does>",
  "dependencies": ["<any_dependent_function_names>"],
  "code": "async function <valid_snake_case_name>(...args) {\\n  // code\\n}"
}

Ensure the code is valid JavaScript, returns the expected output, and handles edge cases.`;

      const response = await framework.llm.chat(
        [{ role: "user", content: prompt }],
        { apiKey: apiKey || undefined, responseFormat: "json_object", temperature: 0.2 }
      );

      try {
        const parsed = JSON.parse(response);
        if (parsed.action === "create" && parsed.function_name && parsed.code) {
          // Register the newly synthesized function into the database!
          framework.registerCode(parsed.function_name, parsed.code, {
            description: parsed.description || `Auto-generated for query: ${query}`,
            dependencies: parsed.dependencies || [],
            metadata: {
              category: "self_built",
              source_query: query,
              auto_generated: true
            }
          });
        }
        return parsed;
      } catch (err: any) {
        return {
          action: "create",
          function_name: "custom_processor_" + Date.now().toString().slice(-4),
          description: "Fallback processor",
          code: `function custom_processor(input) { return 'Processed: ' + JSON.stringify(input); }`
        };
      }
    },
    {
      name: "choose_or_create_function",
      key_dependencies: ["openai_api_key"],
      description: "Evaluates existing functions vs query, creates and registers a new function if needed",
      metadata: { category: "self_build" }
    }
  );
}

export async function runSelfBuild(framework: Functionz, config: SelfBuildConfig): Promise<any> {
  const { userDescription, queryCount = 3, onProgress } = config;

  onProgress?.("Generating queries based on user description...", { userDescription });
  const queries: string[] = await framework.executeFunction("generate_queries", userDescription, queryCount);

  const results: any[] = [];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    onProgress?.(`Processing query ${i + 1}/${queries.length}: "${query}"`, { query, index: i });

    const decision = await framework.executeFunction("choose_or_create_function", query);
    let executionResult = null;

    if (decision.function_name && framework.getFunction(decision.function_name)) {
      try {
        onProgress?.(`Executing function '${decision.function_name}'...`, { function_name: decision.function_name });
        executionResult = await framework.executeFunction(decision.function_name, query);
      } catch (err: any) {
        executionResult = { error: err.message };
      }
    }

    results.push({
      query,
      decision,
      executionResult
    });
  }

  onProgress?.("Self-build loop completed.", { results });
  return {
    userDescription,
    totalQueries: queries.length,
    results,
    allFunctions: framework.getAllFunctions().map((f) => f.name)
  };
}

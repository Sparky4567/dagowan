import type { Functionz } from "../../core/framework";
import type { TaskItem } from "../../types";

export function loadClassicAgents(framework: Functionz): void {
  // Context Retrieval Agent
  framework.registerFunction(
    async function context_agent(query: string, topK: number = 5) {
      const results = framework.memory.searchByText(query, topK);
      return results.map((r) => r.document.text).join("\n\n");
    },
    {
      name: "context_agent",
      description: "Retrieves top-k relevant past execution contexts from vector memory",
      metadata: { category: "classic_babyagi" }
    }
  );

  // Task Execution Agent
  framework.registerFunction(
    async function task_execution_agent(objective: string, task: string) {
      const context = await framework.executeFunction("context_agent", task, 3);
      const apiKey = framework.db.getKey("openai_api_key");

      const prompt = `You are an autonomous AI task execution agent working to achieve the following objective:
Objective: ${objective}

Relevant Context from Previous Tasks:
${context || "None"}

Your Current Task:
${task}

Execute this task thoroughly and return a comprehensive, detailed result.`;

      return await framework.llm.chat(
        [{ role: "user", content: prompt }],
        { apiKey: apiKey || undefined, temperature: 0.5 }
      );
    },
    {
      name: "task_execution_agent",
      dependencies: ["context_agent"],
      key_dependencies: ["openai_api_key"],
      description: "Executes a specific task toward an objective using context and LLM",
      metadata: { category: "classic_babyagi" }
    }
  );

  // Task Creation Agent
  framework.registerFunction(
    async function task_creation_agent(objective: string, taskResult: string, taskDescription: string, incompleteTasks: string[]) {
      const apiKey = framework.db.getKey("openai_api_key");
      const prompt = `You are a task creation AI agent that helps achieve the main objective by creating new tasks.
Objective: ${objective}
Last Completed Task: ${taskDescription}
Result of Completed Task: ${taskResult}
Currently Incomplete Tasks: ${JSON.stringify(incompleteTasks)}

Based on the result, create new actionable tasks to be completed by the AI agent that do not overlap with incomplete tasks.
Respond in valid JSON array format containing strings of tasks:
[
  "Task name 1",
  "Task name 2"
]
If no new tasks are necessary to achieve the objective, return an empty array [].`;

      const response = await framework.llm.chat(
        [{ role: "user", content: prompt }],
        { apiKey: apiKey || undefined, responseFormat: "json_object", temperature: 0.5 }
      );

      try {
        const parsed = JSON.parse(response);
        if (Array.isArray(parsed)) return parsed;
        if (parsed.tasks && Array.isArray(parsed.tasks)) return parsed.tasks;
        return [];
      } catch {
        return [];
      }
    },
    {
      name: "task_creation_agent",
      key_dependencies: ["openai_api_key"],
      description: "Creates new subtasks based on completed task results and overall objective",
      metadata: { category: "classic_babyagi" }
    }
  );

  // Prioritization Agent
  framework.registerFunction(
    async function prioritization_agent(objective: string, tasks: TaskItem[], nextTaskId: number) {
      const taskNames = tasks.map((t) => t.task_name);
      if (taskNames.length <= 1) return tasks;

      const apiKey = framework.db.getKey("openai_api_key");
      const prompt = `You are a task prioritization AI agent.
Objective: ${objective}
Tasks to prioritize:
${JSON.stringify(taskNames, null, 2)}

Re-order these tasks by priority to most effectively achieve the objective.
Respond in valid JSON array of ordered task names:
[
  "Highest priority task",
  "Second priority task"
]`;

      const response = await framework.llm.chat(
        [{ role: "user", content: prompt }],
        { apiKey: apiKey || undefined, responseFormat: "json_object", temperature: 0.3 }
      );

      try {
        const parsed = JSON.parse(response);
        const orderedNames: string[] = Array.isArray(parsed) ? parsed : (parsed.tasks || taskNames);
        let idCounter = nextTaskId;
        return orderedNames.map((name) => ({
          task_id: idCounter++,
          task_name: name,
          status: "pending" as const
        }));
      } catch {
        return tasks;
      }
    },
    {
      name: "prioritization_agent",
      key_dependencies: ["openai_api_key"],
      description: "Reprioritizes and reorders the task list to optimize progress toward the objective",
      metadata: { category: "classic_babyagi" }
    }
  );
}

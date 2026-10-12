import type { Functionz } from "../../core/framework";
import type { ClassicBabyAGIConfig, TaskItem } from "../../types";

export async function runClassicBabyAGILoop(framework: Functionz, config: ClassicBabyAGIConfig): Promise<any> {
  const {
    objective,
    initialTask = "Develop a comprehensive task list and plan of execution.",
    maxIterations = 5,
    onTaskStart,
    onTaskComplete,
    onTaskCreated,
    onPrioritized
  } = config;

  console.log("\x1b[95m\x1b[1m\n***** BABYAGI OBJECTIVE *****\x1b[0m");
  console.log(`\x1b[94m${objective}\x1b[0m`);
  console.log(`\x1b[93mInitial Task:\x1b[0m ${initialTask}\n`);

  let taskIdCounter = 1;
  let taskList: TaskItem[] = [
    {
      task_id: taskIdCounter++,
      task_name: initialTask,
      status: "pending"
    }
  ];

  const executionHistory: Array<{ task: TaskItem; result: string }> = [];
  let iteration = 0;

  while (taskList.length > 0 && iteration < maxIterations) {
    iteration++;
    console.log(`\x1b[96m\x1b[1m\n***** ITERATION ${iteration}/${maxIterations} *****\x1b[0m`);

    // Print task list
    console.log("\x1b[92mCurrent Task List:\x1b[0m");
    taskList.forEach((t, idx) => {
      console.log(`  ${idx + 1}. [ID: ${t.task_id}] ${t.task_name}`);
    });

    // 1. Pull next task
    const currentTask = taskList.shift()!;
    currentTask.status = "in_progress";
    console.log(`\n\x1b[93m\x1b[1m***** EXECUTING TASK [${currentTask.task_id}]: ${currentTask.task_name} *****\x1b[0m`);
    onTaskStart?.(currentTask);

    // 2. Execute task
    const result: string = await framework.executeFunction("task_execution_agent", objective, currentTask.task_name);
    currentTask.status = "completed";
    currentTask.result = result;
    executionHistory.push({ task: currentTask, result });

    console.log("\x1b[92m\x1b[1m***** TASK RESULT *****\x1b[0m");
    console.log(result.trim());
    onTaskComplete?.(currentTask, result);

    // 3. Store result in vector memory
    framework.memory.add(
      `task_${currentTask.task_id}`,
      `Task: ${currentTask.task_name}\nResult: ${result}`,
      undefined,
      { objective, task_id: currentTask.task_id, task_name: currentTask.task_name }
    );

    if (iteration >= maxIterations) {
      console.log(`\x1b[95mReached max iterations limit (${maxIterations}). Loop concluded.\x1b[0m`);
      break;
    }

    // 4. Create new tasks based on result
    const incompleteTaskNames = taskList.map((t) => t.task_name);
    const newTasksRaw: string[] = await framework.executeFunction(
      "task_creation_agent",
      objective,
      result,
      currentTask.task_name,
      incompleteTaskNames
    );

    if (newTasksRaw && newTasksRaw.length > 0) {
      console.log(`\x1b[94m\nNew Tasks Created (${newTasksRaw.length}):\x1b[0m`);
      const newTasks: TaskItem[] = newTasksRaw.map((name) => ({
        task_id: taskIdCounter++,
        task_name: name,
        status: "pending"
      }));
      newTasks.forEach((t) => console.log(`  + [ID: ${t.task_id}] ${t.task_name}`));
      onTaskCreated?.(newTasks);

      taskList.push(...newTasks);

      // 5. Prioritize task list
      console.log("\x1b[90mPrioritizing task list...\x1b[0m");
      taskList = await framework.executeFunction("prioritization_agent", objective, taskList, taskIdCounter);
      onPrioritized?.(taskList);
    }
  }

  return {
    objective,
    completedIterations: iteration,
    history: executionHistory,
    remainingTasks: taskList
  };
}

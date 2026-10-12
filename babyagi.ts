import { loadSettings } from "./src/config.js";
import { runBabyAGI } from "./src/babyagi_integration.ts";

const args = process.argv.slice(2);
const iterationIndex = args.indexOf("--iterations");
const iterations = iterationIndex >= 0 ? Number(args[iterationIndex + 1]) : 3;
const objective = args
  .filter((_, index) => index !== iterationIndex && index !== iterationIndex + 1)
  .join(" ")
  .trim();

if (!objective) {
  console.error("Usage: bun run babyagi -- <objective> [--iterations N]");
  process.exit(1);
}

const result = await runBabyAGI(objective, loadSettings(), iterations);
console.log(`\nBabyAGI completed ${result.completedIterations} iteration(s).`);
console.log(`Remaining tasks: ${result.remainingTasks.length}`);

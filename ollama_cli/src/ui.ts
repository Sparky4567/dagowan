import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import ora from "ora";

// Set up marked terminal renderer
marked.use(markedTerminal() as any);

export const LOGO = `
  ____  _ _                        ____          _      
 / __ \\| | | __ _ _ __ ___   __ _ / ___|___   __| | ___ 
| |  | | | |/ _\` | '_ \` _ \\ / _\` | |   / _ \\ / _\` |/ _ \\
| |__| | | | (_| | | | | | | (_| | |__| (_) | (_| |  __/
 \\____/|_|_|\\__,_|_| |_| |_|\\__,_|\\____\\___/ \\__,_|\\___|
`;

export function printLogo() {
  console.log(chalk.cyan(LOGO));
}

export function printHeader(text: string) {
  console.log(chalk.bold.green(text));
}

export function printSubHeader(text: string) {
  console.log(chalk.bold.yellow(text));
}

export function printInfo(text: string) {
  console.log(chalk.blue(text));
}

export function printError(text: string) {
  console.log(chalk.bold.red(`✖ ${text}`));
}

export function printWarning(text: string) {
  console.log(chalk.yellow(`⚠ ${text}`));
}

export function printSuccess(text: string) {
  console.log(chalk.green(`✔ ${text}`));
}

export function renderMarkdown(content: string): string {
  try {
    return marked.parse(content) as string;
  } catch {
    return content;
  }
}

export function printMarkdown(content: string) {
  const rendered = renderMarkdown(content);
  console.log(rendered.trimEnd());
}

export function printToolCall(toolName: string, args: Record<string, any>) {
  const argsStr = JSON.stringify(args);
  const truncatedArgs = argsStr.length > 100 ? argsStr.substring(0, 97) + "..." : argsStr;
  console.log(`\n${chalk.bold.cyan("🛠  Tool Call:")} ${chalk.yellow(toolName)} ${chalk.gray(truncatedArgs)}`);
}

export function printToolResult(result: string) {
  const truncated = result.length > 500 ? result.substring(0, 500) + "\n... (truncated)" : result;
  console.log(chalk.dim(`↳ Result:\n${truncated}\n`));
}

export function printRule(title?: string, color: "cyan" | "magenta" | "blue" | "yellow" = "cyan") {
  const width = Math.min(process.stdout.columns || 80, 80);
  const colorFn = chalk[color] || chalk.cyan;
  if (!title) {
    console.log(colorFn("─".repeat(width)));
    return;
  }
  const paddedTitle = ` ${title} `;
  const rem = Math.max(0, width - paddedTitle.length);
  const left = Math.floor(rem / 2);
  const right = rem - left;
  console.log(colorFn("─".repeat(left) + chalk.bold(paddedTitle) + "─".repeat(right)));
}

export interface SpinnerWrapper {
  start: () => void;
  stop: () => void;
  isSpinning: boolean;
}

export function createSpinner(text: string): SpinnerWrapper {
  if (!process.stdout.isTTY) {
    return {
      start: () => {},
      stop: () => {},
      isSpinning: false,
    };
  }
  const realSpinner = ora({
    text,
    color: "cyan",
    spinner: "dots",
  });
  return {
    start: () => {
      realSpinner.start();
    },
    stop: () => {
      realSpinner.stop();
    },
    get isSpinning() {
      return realSpinner.isSpinning;
    },
  };
}

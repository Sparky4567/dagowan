# Ollama Code CLI (Bun Edition)

A high-performance local AI coding assistant built with **Bun** and **TypeScript**, inspired by `ollama-code-cli`.

## Features

- 🚀 **Built on Bun**: Blazing fast execution and low overhead.
- 🤖 **Local Ollama Models**: Interactively auto-detects and connects to local Ollama servers (supports models like `llama3.2:1b`, `gpt-oss:120b-cloud`, `llama3.1`, etc.).
- 🛠️ **ReAct Agent & Tool Calling**:
  - `read_file`: Inspect local files with line range support.
  - `write_file`: Create or update local files (auto-creates directories).
  - `list_directory`: List directory files and sizes.
  - `run_command`: Safely run shell commands with timeout and capture output.
  - `search_files`: Fast regex/text search across project files (`grep`).
- 🧠 **Thinking & Reasoning Support**: Streamed real-time visualization of model thinking steps (e.g. for `gpt-oss` / DeepSeek models).
- 💬 **Modes**:
  - **Code Mode (`@code`)**: Agent with full tool-calling capabilities.
  - **Chat Mode (`@chat`)**: Fast response without tool invocations.
- ⚡ **Interactive REPL & @ Commands**:
  - `@help`: Print command menu
  - `@model` / `@choose model`: Interactive model picker
  - `@change-project-path <path>`: Change and persist project working directory
  - `@project-path`: View or update current project working directory
  - `@code` / `@chat`: Switch mode
  - `@clear`: Clear terminal & reset history
  - `@history`: View session transcript
  - `@system`: View/Edit system prompt
  - `@bye` / `exit`: Quit session
- 💾 **Persistent Configuration**: Saved in `~/.ollama_cli.json` (stores active model, server URL, system prompt, and project working directory).

---

## Installation & Setup

```bash
bun install
```

---

## Usage

### Interactive Mode (REPL)

```bash
bun run index.ts
# Or if linked:
ollama-cli
```

### Single-shot Prompt

```bash
# Execute prompt directly
bun run index.ts "List the files in current directory"

# Specify a model
bun run index.ts -m gpt-oss:120b-cloud "Write a hello world script in typescript"

# Specify a project working directory
bun run index.ts -p ./my-project "Create a simple web server in server.ts"

# Start directly in chat mode
bun run index.ts --chat "Explain how TypeScript generics work"
```

---

## Running Tests

```bash
bun test
```

#!/usr/bin/env bun
import { runCli } from "./src/cli";

runCli().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
import type { Functionz } from "../../core/framework";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export function loadOSFunctions(framework: Functionz): void {
  // Read file
  framework.registerFunction(
    async function read_file(path: string) {
      if (!existsSync(path)) {
        throw new Error(`File not found: ${path}`);
      }
      return await readFile(path, "utf-8");
    },
    {
      name: "read_file",
      description: "Reads the contents of a local file",
      metadata: { category: "os" }
    }
  );

  // Write file
  framework.registerFunction(
    async function write_file(path: string, content: string) {
      await writeFile(path, content, "utf-8");
      return { success: true, path, bytes: Buffer.byteLength(content) };
    },
    {
      name: "write_file",
      description: "Writes content to a file",
      metadata: { category: "os" }
    }
  );

  // List directory
  framework.registerFunction(
    async function list_directory(dirPath: string = ".") {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile()
      }));
    },
    {
      name: "list_directory",
      description: "Lists files and folders in a given directory",
      metadata: { category: "os" }
    }
  );
}

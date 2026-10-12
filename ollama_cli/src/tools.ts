import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a local file. Optionally specify start_line and end_line range.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The path to the file to read."
          },
          start_line: {
            type: "integer",
            description: "Optional line number to start reading from (1-indexed)."
          },
          end_line: {
            type: "integer",
            description: "Optional line number to end reading at (1-indexed, inclusive)."
          }
        },
        required: ["file_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a local file. Specify the complete path including filename (e.g. './dir/file.txt'). Automatically creates missing parent directories.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The complete relative or absolute file path including filename (e.g. './path/to/file.txt')."
          },
          content: {
            type: "string",
            description: "The text content to write into the file."
          }
        },
        required: ["file_path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the contents of a directory (files and subfolders with sizes and indicators).",
      parameters: {
        type: "object",
        properties: {
          directory_path: {
            type: "string",
            description: "The directory path to list. Defaults to current project directory ('.')."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command on the host machine and capture stdout and stderr.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute."
          },
          cwd: {
            type: "string",
            description: "Optional working directory in which to execute the command."
          }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for a text string or regex pattern in files within a directory.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The text or regex pattern to search for."
          },
          directory_path: {
            type: "string",
            description: "The directory to search in. Defaults to current project directory ('.')."
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_open",
      description: "Navigate the shared local Chromium window to a URL (allowlisted domains: youtube, google, giphy by default). Returns page title and URL.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The http(s) URL to navigate to."
          }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_search_youtube",
      description: "Search YouTube in the local browser window and return the top video results (title + watch URL) without playing anything.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search terms, e.g. 'lofi hip hop radio'."
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_play_youtube",
      description: "YouTube playback (official Data API first, local Chromium fallback): search or open a YouTube URL and hand it to the host browser. Returns title, watch URL and playback state.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search terms or a YouTube watch/shorts/youtu.be URL."
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_search_spotify",
      description: "Search Spotify (songs, podcasts, episodes, albums, playlists) in the local browser window and return the top results (title + open.spotify.com URL + kind) without playing anything.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search terms, e.g. 'lofi hip hop' or 'Serial podcast'."
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_play_spotify",
      description: "Spotify playback (official Web API first, local Chromium fallback): search or open a Spotify URL and hand it to the host browser/app. Returns title, Spotify URL and kind.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search terms or a Spotify URL (open.spotify.com/... or spotify:... URI)."
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_draft_blog",
      description: "Blog drafting (official WordPress REST / Blogger v3 APIs first, local Chromium editor fallback): compose a draft post about a topic on wordpress or blogger and hand the editor to the host browser. Returns title, editor URL and source.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "What the post is about, e.g. 'the future of local AI'."
          },
          platform: {
            type: "string",
            description: "Target platform: 'wordpress' or 'blogger' (default 'wordpress')."
          },
          title: {
            type: "string",
            description: "Optional explicit post title (defaults to a title-cased topic)."
          },
          content: {
            type: "string",
            description: "Optional full post body (HTML accepted). When omitted, the active character persona writes the post in its own voice."
          }
        },
        required: ["topic"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fact_check_papers",
      description: "Fact-check a claim (Semantic Scholar papers + optional Gemini verdict): search papers by claim and return titles, abstracts, years, citation counts, DOIs and open-access PDF URLs, plus a Gemini SUPPORTED/REFUTED/MIXED/UNVERIFIABLE verdict when a Gemini key is configured.",
      parameters: {
        type: "object",
        properties: {
          claim: {
            type: "string",
            description: "The claim or question to verify, e.g. 'Does sleep deprivation increase risk of Alzheimer\\'s?'."
          },
          max_results: {
            type: "integer",
            description: "How many papers to return (1-10, default 3)."
          },
          source: {
            type: "string",
            description: "Fact-check engine: 'auto' (papers + Gemini verdict when configured), 'papers' (Semantic Scholar only), or 'gemini' (Gemini verdict only)."
          },
          model: {
            type: "string",
            description: "Gemini model for the verdict (default gemini-2.5-flash)."
          }
        },
        required: ["claim"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_read",
      description: "Read the visible text of the current browser page.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description: "Screenshot the current browser page into tmp/ and return the file path.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Optional screenshot base name (alphanumeric, defaults to timestamp)."
          }
        }
      }
    }
  }
];

/**
 * Resolves a file or directory path against a base project directory.
 * Expands '~' if present and handles relative and absolute paths cleanly.
 */
export function resolvePath(targetPath?: string, basePath?: string): string {
  let root = basePath ? basePath : process.cwd();
  if (root.startsWith("~")) {
    root = path.join(os.homedir(), root.slice(1));
  }
  root = path.resolve(root);

  if (!targetPath || targetPath === ".") {
    return root;
  }
  let target = targetPath;
  if (target.startsWith("~")) {
    target = path.join(os.homedir(), target.slice(1));
  }
  if (path.isAbsolute(target)) {
    return path.resolve(target);
  }
  return path.resolve(root, target);
}

export async function executeTool(name: string, args: Record<string, any>, basePath?: string): Promise<string> {
  try {
    switch (name) {
      case "read_file": {
        const filePath = resolvePath(args.file_path, basePath);
        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          return `Error: File '${args.file_path}' does not exist (path: ${filePath}).`;
        }
        const text = await file.text();
        const lines = text.split("\n");
        const start = args.start_line ? Math.max(1, parseInt(args.start_line, 10)) : 1;
        const end = args.end_line ? Math.min(lines.length, parseInt(args.end_line, 10)) : lines.length;

        const sliced = lines.slice(start - 1, end);
        const numbered = sliced.map((line, idx) => `${start + idx} | ${line}`).join("\n");
        return `File: ${args.file_path} (Lines ${start}-${end} of ${lines.length}):\n${numbered}`;
      }

      case "write_file": {
        const filePath = resolvePath(args.file_path, basePath);
        try {
          const stat = await fs.stat(filePath);
          if (stat.isDirectory()) {
            return `Error: '${args.file_path}' is an existing directory, not a file. Please specify the complete file path including the filename (e.g. '${args.file_path}/filename.txt').`;
          }
        } catch {
          // File does not exist yet, which is expected
        }

        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await Bun.write(filePath, args.content);
        return `Successfully wrote ${args.content.length} characters to '${args.file_path}' (path: ${filePath}).`;
      }

      case "list_directory": {
        const dirPath = resolvePath(args.directory_path || ".", basePath);
        try {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          if (entries.length === 0) {
            return `Directory '${args.directory_path || "."}' (path: ${dirPath}) is empty.`;
          }

          const formatted = await Promise.all(
            entries.map(async (entry) => {
              const fullPath = path.join(dirPath, entry.name);
              if (entry.isDirectory()) {
                return `[DIR]  ${entry.name}/`;
              }
              try {
                const stat = await fs.stat(fullPath);
                return `[FILE] ${entry.name} (${stat.size} bytes)`;
              } catch {
                return `[FILE] ${entry.name}`;
              }
            })
          );
          return `Directory listing for '${args.directory_path || "."}' (path: ${dirPath}):\n${formatted.join("\n")}`;
        } catch (err: any) {
          return `Error accessing directory '${args.directory_path || "."}' (path: ${dirPath}): ${err.message || String(err)}`;
        }
      }

      case "run_command": {
        const cmd = args.command;
        const cwd = args.cwd ? resolvePath(args.cwd, basePath) : (basePath ? path.resolve(basePath) : process.cwd());
        try {
          const { stdout, stderr } = await execAsync(cmd, {
            cwd,
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024
          });
          let output = "";
          if (stdout.trim()) output += `STDOUT:\n${stdout.trim()}\n`;
          if (stderr.trim()) output += `STDERR:\n${stderr.trim()}\n`;
          return output.trim() || "Command executed successfully with no output.";
        } catch (err: any) {
          return `Command failed with exit code ${err.returncode ?? 1}\n${err.stdout ? "STDOUT: " + err.stdout : ""}\n${err.stderr ? "STDERR: " + err.stderr : ""}`;
        }
      }

      case "search_files": {
        const dirPath = resolvePath(args.directory_path || ".", basePath);
        const query = args.query;
        try {
          const { stdout } = await execAsync(`grep -rnI --exclude-dir={node_modules,.git,dist,build} "${query.replace(/"/g, '\\"')}" "${dirPath}"`, {
            timeout: 10000
          });
          return stdout.trim() || `No matches found for '${query}' in '${dirPath}'.`;
        } catch {
          return `No matches found for '${query}' in '${dirPath}'.`;
        }
      }

      case "browser_open":
      case "browser_search_youtube":
      case "browser_play_youtube":
      case "browser_search_spotify":
      case "browser_play_spotify":
      case "browser_draft_blog":
      case "fact_check_papers":
      case "browser_read":
      case "browser_screenshot": {
        try {
          const mod = await import("../../src/browser.js");
          switch (name) {
            case "browser_open": {
              const res = await mod.browserOpen(args.url, {});
              return res.success ? `Browser now at "${res.title || "(untitled)"}" (${res.url}).` : `Browser error: ${res.error}`;
            }
            case "browser_search_youtube": {
              const res = await mod.browserSearchYoutube(args.query, {});
              if (!res.success) return `Browser error: ${res.error}`;
              if (!res.results || res.results.length === 0) return `No YouTube results for '${args.query}'.`;
              return `Top YouTube results for '${args.query}':\n` + res.results.map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n");
            }
            case "browser_play_youtube": {
              const mod = await import("../../src/play_api.js");
              const res = await mod.playYoutube(args.query, {}, {});
              return res.success
                ? `Now playing "${res.title || "YouTube video"}" (${res.url}). Playback state: ${res.playing ? "playing" : "loaded"}.`
                : `Browser error: ${res.error}`;
            }
            case "browser_search_spotify": {
              const res = await mod.browserSearchSpotify(args.query, {});
              if (!res.success) return `Browser error: ${res.error}`;
              if (!res.results || res.results.length === 0) return `No Spotify results for '${args.query}'.`;
              return `Top Spotify results for '${args.query}':\n` + res.results.map((r: any, i: number) => `${i + 1}. ${r.title} [${r.kind || "track"}]\n   ${r.url}`).join("\n");
            }
            case "browser_play_spotify": {
              const mod = await import("../../src/play_api.js");
              const res = await mod.playSpotify(args.query, {}, {});
              if (!res.success) return `Browser error: ${res.error}`;
              const state = res.playing ? "playing" : ("loaded, not autoplaying" + (res.needsLogin ? " (Spotify login required for full playback)" : " — press play on the opened page"));
              return `Spotify [${res.kind || "track"}] "${res.title || "Spotify track"}" (${res.url}). State: ${state}. Full playback continues where you are logged in.`;
            }
            case "browser_draft_blog": {
              const mod = await import("../../src/blog_api.js");
              // Best-effort voice: the agent loop has no characterStore, so
              // fall back to the active persona in characters.json. Explicit
              // args.content still wins (author already wrote the body).
              let voice: { characterPersona?: string; characterName?: string } = {};
              if (!args.content || !String(args.content).trim()) {
                try {
                  const raw = await fs.readFile(path.resolve(process.cwd(), "characters.json"), "utf8");
                  const store = JSON.parse(raw);
                  const chars = Array.isArray(store?.characters) ? store.characters : [];
                  const active = chars.find((c: any) => c.id === store.active_character) || chars[0];
                  const templates: string[] = Array.isArray(active?.templates) ? active.templates : [];
                  const selected: number[] = Array.isArray(active?.selected_templates) ? active.selected_templates : [0];
                  const persona = selected.map((i) => templates[i]).filter(Boolean).join("\n\n").trim()
                    || templates[0] || "";
                  if (persona) voice = { characterPersona: persona, characterName: active?.name || "" };
                } catch {}
              }
              const res = await mod.draftBlog(args.topic, {}, { platform: args.platform || "wordpress", title: args.title || "", content: args.content || "", ...voice });
              return res.success
                ? `Drafted "${res.title || args.topic}" on ${res.platform || args.platform} (${res.url}). Source: ${res.source || "unknown"}.`
                : `Browser error: ${res.error}`;
            }
            case "browser_read": {
              const res = await mod.browserRead({});
              return res.success ? `Page [${res.title || res.url}]:\n${(res.text || "").slice(0, 4000)}` : `Browser error: ${res.error}`;
            }
            case "browser_screenshot": {
              const res = await mod.browserScreenshot(args.name || "", {});
              return res.success ? `Screenshot saved: ${res.path} (page: ${res.url}).` : `Browser error: ${res.error}`;
            }
            case "fact_check_papers": {
              const factMod = await import("../../src/factcheck_api.js");
              const res = await factMod.checkFactClaim(args.claim, {}, { maxResults: args.max_results, source: args.source, model: args.model });
              return res.success ? factMod.formatFactCheckResult(res) : `Fact-check error: ${res.error}`;
            }
          }
          return `Error: Unknown tool '${name}'.`;
        } catch (err: any) {
          return `Browser tool '${name}' failed: ${err.message || String(err)}`;
        }
      }

      default:
        return `Error: Unknown tool '${name}'.`;
    }
  } catch (err: any) {
    return `Error executing tool '${name}': ${err.message || String(err)}`;
  }
}

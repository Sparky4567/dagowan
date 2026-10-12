import { test, expect } from "bun:test";
import path from "node:path";
import {
    resolveJailedPath,
    checkDestructiveCommand,
    scrubSecretsEnv,
    getOpenCliConfig,
    checkOpenCliAccess,
    truncateForChat,
    executeJailedTool,
} from "./opencli.js";

const ROOT = path.resolve("./test_scratch_opencli");

test("resolveJailedPath keeps relative paths inside the jail", () => {
    expect(resolveJailedPath("a/b.txt", ROOT)).toBe(path.join(ROOT, "a/b.txt"));
    expect(resolveJailedPath(".", ROOT)).toBe(ROOT);
    expect(resolveJailedPath("sub/../ok.txt", ROOT)).toBe(path.join(ROOT, "ok.txt"));
});

test("resolveJailedPath refuses escapes", () => {
    expect(() => resolveJailedPath("../outside.txt", ROOT)).toThrow("escapes project jail");
    expect(() => resolveJailedPath("/etc/passwd", ROOT)).toThrow("escapes project jail");
    expect(() => resolveJailedPath("~/x", ROOT)).toThrow("escapes project jail");
});

test("checkDestructiveCommand blocks dangerous patterns, allows normal ones", () => {
    expect(checkDestructiveCommand("rm -rf /").blocked).toBe(true);
    expect(checkDestructiveCommand("rm -rf ~").blocked).toBe(true);
    expect(checkDestructiveCommand("mkfs.ext4 /dev/sda1").blocked).toBe(true);
    expect(checkDestructiveCommand(":(){ :|:& };:").blocked).toBe(true);
    expect(checkDestructiveCommand("bun test && bun run build").blocked).toBe(false);
    expect(checkDestructiveCommand("rm -rf ./dist").blocked).toBe(false);
});

test("scrubSecretsEnv strips credentials but keeps the rest", () => {
    const out = scrubSecretsEnv({ OPENAI_API_KEY: "sk-x", PATH: "/usr/bin", GEMINI_API_KEY: "y", APP_PORT: "1" });
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.GEMINI_API_KEY).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
    expect(out.APP_PORT).toBe("1");
});

test("checkOpenCliAccess: local allowed, remotes owner-gated, disabled denies all", () => {
    expect(checkOpenCliAccess({ opencli_enabled: true }, null).allowed).toBe(true);
    expect(checkOpenCliAccess({ opencli_enabled: true }, undefined).allowed).toBe(true);
    // No allowlist configured -> remote denied with setup hint
    const denied = checkOpenCliAccess({ opencli_enabled: true }, "12345");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("12345");
    // Listed remote allowed
    expect(checkOpenCliAccess({ opencli_enabled: true, opencli_allowed_chats: ["12345"] }, "12345").allowed).toBe(true);
    expect(checkOpenCliAccess({ opencli_enabled: true, opencli_allowed_chats: "12345, 678" }, 678).allowed).toBe(true);
    // Disabled denies even local
    expect(checkOpenCliAccess({ opencli_enabled: false }, null).allowed).toBe(false);
});

test("getOpenCliConfig applies safe defaults and caps", () => {
    expect(getOpenCliConfig({}).model).toBe("gpt-4o-mini");
    expect(getOpenCliConfig({}).maxIterations).toBe(12);
    expect(getOpenCliConfig({ opencli_max_iterations: 999 }).maxIterations).toBe(50);
});

test("truncateForChat shortens long outputs with a log pointer", () => {
    expect(truncateForChat("short")).toBe("short");
    const long = truncateForChat("x".repeat(4000));
    expect(long.length).toBeLessThan(4000);
    expect(long).toContain("opencli.log");
});

test("executeJailedTool refuses path escapes without touching disk", async () => {
    const res = await executeJailedTool("read_file", { file_path: "../../etc/passwd" }, ROOT);
    expect(res).toContain("escapes project jail");
    const unknown = await executeJailedTool("browser_open", {}, ROOT);
    expect(unknown).toContain("not available");
});

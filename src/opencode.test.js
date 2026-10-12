import { test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    getOpencodeConfig,
    checkOpencodeAccess,
    requireExplicitProjectPath,
    readOpencodeJsonModel,
    getEffectiveOpencodeModel,
    buildOpencodeArgs,
    buildOpencodeEnv,
    parseOpencodeJsonOutput,
    getOpencodeSetupStatus,
    formatOpencodeSetupStatus,
    runOpencodeSetupStep,
    getOpencodeAutoAllowStatus,
    applyOpencodeAutoAllow,
    clearOpencodeAutoAllow,
} from "./opencode.js";

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-"));

afterAll(() => {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
});

test("getOpencodeConfig: no hardcoded model default, safe timeout/access defaults", () => {
    const cfg = getOpencodeConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.model).toBe(""); // must be set by user or resolved from opencode itself
    expect(cfg.autoApprove).toBe(false);
    expect(cfg.timeoutMs).toBe(180000);
    expect(cfg.allowedChats).toEqual([]);
    expect(getOpencodeConfig({ opencode_model: "  ollama/qwen  " }).model).toBe("ollama/qwen");
    expect(getOpencodeConfig({ opencode_timeout_ms: -5 }).timeoutMs).toBe(180000);
    expect(getOpencodeConfig({ opencode_auto: 1 }).autoApprove).toBe(true);
});

test("checkOpencodeAccess: local allowed, remotes owner-gated, disabled denies all", () => {
    expect(checkOpencodeAccess({ opencode_enabled: true }, null).allowed).toBe(true);
    expect(checkOpencodeAccess({ opencode_enabled: true }, undefined).allowed).toBe(true);
    const denied = checkOpencodeAccess({ opencode_enabled: true }, "999");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("999");
    expect(checkOpencodeAccess({ opencode_enabled: true, opencode_allowed_chats: ["999"] }, "999").allowed).toBe(true);
    expect(checkOpencodeAccess({ opencode_enabled: false }, null).allowed).toBe(false);
});

test("requireExplicitProjectPath refuses the untouched default", () => {
    expect(() => requireExplicitProjectPath({})).toThrow("@set-project-path");
    expect(() => requireExplicitProjectPath({ project_path: "" })).toThrow("@set-project-path");
    expect(() => requireExplicitProjectPath({ project_path: "projects" })).toThrow("@set-project-path");
    expect(() => requireExplicitProjectPath({ projects_path: "projects" })).toThrow("@set-project-path");
});

test("requireExplicitProjectPath resolves and creates an explicit path", () => {
    const target = path.join(SCRATCH, "my-app");
    const abs = requireExplicitProjectPath({ project_path: target });
    expect(abs).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
    // A user-set value that happens to end in "projects" (absolute) is fine.
    const same = path.join(SCRATCH, "projects");
    expect(requireExplicitProjectPath({ project_path: same })).toBe(same);
});

test("readOpencodeJsonModel reads project opencode.json, tolerates JSONC", () => {
    const dir = path.join(SCRATCH, "cfg1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "opencode.json"), '{\n  // comment\n  "model": "ollama/qwen3:8b"\n}', "utf8");
    expect(readOpencodeJsonModel(dir)).toBe("ollama/qwen3:8b");
    expect(readOpencodeJsonModel(path.join(SCRATCH, "missing-dir"))).toBe("");
});

test("getEffectiveOpencodeModel prefers user setting over opencode config", () => {
    const dir = path.join(SCRATCH, "cfg1");
    expect(getEffectiveOpencodeModel({ opencode_model: "openai/gpt-4o" }, dir)).toEqual({
        source: "setting",
        model: "openai/gpt-4o",
    });
    expect(getEffectiveOpencodeModel({}, dir)).toEqual({ source: "project", model: "ollama/qwen3:8b" });
    const empty = getEffectiveOpencodeModel({}, path.join(SCRATCH, "missing-dir"));
    expect(["global", "none"]).toContain(empty.source);
});

test("buildOpencodeArgs omits --model unless the user set one (no path in message)", () => {
    const withModel = buildOpencodeArgs({ task: "do x", model: "a/b", autoApprove: false, projectPath: "/p" });
    expect(withModel).toEqual(["run", "--format", "json", "--model", "a/b", "do x"]);
    const withoutModel = buildOpencodeArgs({ task: "do x", model: "", autoApprove: true, projectPath: "/p" });
    expect(withoutModel).toEqual(["run", "--format", "json", "--auto", "do x"]);
});

test("buildOpencodeEnv pins PWD to the project path (CLI reads PWD, not cwd)", () => {
    const env = buildOpencodeEnv("/proj", { PATH: "/bin", PWD: "/bot-root" });
    expect(env.PWD).toBe("/proj");
    expect(env.PATH).toBe("/bin");
});

test("parseOpencodeJsonOutput collects text parts and surfaces errors", () => {    const out = [
        JSON.stringify({ type: "step_start", sessionID: "ses_1" }),
        JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "hello" } }),
        JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "world" } }),
    ].join("\n");
    const res = parseOpencodeJsonOutput(out);
    expect(res.error).toBe("");
    expect(res.text).toBe("hello\nworld");
    expect(res.sessionID).toBe("ses_1");

    const errOut = JSON.stringify({ type: "error", sessionID: "ses_2", error: { type: "provider.auth", message: "denied" } });
    const errRes = parseOpencodeJsonOutput(errOut);
    expect(errRes.error).toContain("denied");

    const plain = parseOpencodeJsonOutput("just some text");
    expect(plain.text).toBe("just some text");
    expect(parseOpencodeJsonOutput("").error).not.toBe("");
});

test("getOpencodeSetupStatus (offline) reports each step without spawning", async () => {
    const st = await getOpencodeSetupStatus({}, { live: false });
    expect(st.ready).toBe(false);
    expect(st.binary.ok).toBe(true); // binary exists on this machine
    expect(st.project.ok).toBe(false);
    expect(st.model.model).toBe("");
    expect(st.auth.state).toBe("skipped");
    const text = formatOpencodeSetupStatus(st);
    expect(text).toContain("@opencode-setup path");
    expect(text).toContain("@opencode-setup model");
    expect(text).toContain("NOT READY");
});

test("getOpencodeSetupStatus ready when path + model are set (offline)", async () => {
    const dir = path.join(SCRATCH, "ready-app");
    const st = await getOpencodeSetupStatus(
        { project_path: dir, opencode_model: "ollama/qwen3:8b" },
        { live: false }
    );
    expect(st.project.ok).toBe(true);
    expect(st.project.path).toBe(dir);
    expect(st.model).toEqual({ source: "setting", model: "ollama/qwen3:8b" });
    expect(st.ready).toBe(true);
    expect(formatOpencodeSetupStatus(st)).toContain("READY");
});

test("runOpencodeSetupStep path/model/auto/bin mutate settings with settingsChanged", async () => {
    const settings = {};
    const p = await runOpencodeSetupStep("path ./setup-proj", settings, { live: false });
    expect(p.settingsChanged).toBe(true);
    expect(settings.project_path).toBe(path.resolve("./setup-proj"));
    expect(p.reply).toContain("project path set");
    await fs.promises.rm(path.resolve("./setup-proj"), { recursive: true, force: true });

    const m = await runOpencodeSetupStep("model ollama/qwen3:8b", settings, { live: false });
    expect(m.settingsChanged).toBe(true);
    expect(settings.opencode_model).toBe("ollama/qwen3:8b");

    const c = await runOpencodeSetupStep("model clear", settings, { live: false });
    expect(settings.opencode_model).toBe("");

    const a = await runOpencodeSetupStep("auto on", settings, { live: false });
    expect(settings.opencode_auto).toBe(true);

    const b = await runOpencodeSetupStep("bin /usr/local/bin/opencode", settings, { live: false });
    expect(settings.opencode_bin).toBe("/usr/local/bin/opencode");

    const u = await runOpencodeSetupStep("frobnicate", settings, { live: false });
    expect(u.reply).toContain("@opencode-setup");
    expect(u.settingsChanged).toBeFalsy();
});

test("runOpencodeSetupStep test without project path fails with setup hint", async () => {
    const res = await runOpencodeSetupStep("test", {}, { live: false });
    expect(res.reply).toContain("FAILED");
    expect(res.reply).toContain("@set-project-path");
});

test("auto-allow writes/merges project opencode.json presets without clobbering model", async () => {
    const dir = path.join(SCRATCH, "autoallow-app");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ model: "ollama/qwen3:8b" }), "utf8");
    const settings = { project_path: dir };

    const before = getOpencodeAutoAllowStatus(settings);
    expect(before.state).toBe("missing");

    const full = await runOpencodeSetupStep("auto-allow", settings, { live: false });
    expect(full.reply).toContain("auto-allow [full]");
    expect(full.reply).toContain("opencode.json");
    const written = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"));
    expect(written.model).toBe("ollama/qwen3:8b"); // preserved
    expect(written.permission.edit).toBe("allow");
    expect(written.permission.read).toBe("allow");
    expect(getOpencodeAutoAllowStatus(settings).state).toBe("full");

    const alias = await runOpencodeSetupStep("autoallow safe", settings, { live: false });
    expect(alias.reply).toContain("[safe]");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8")).permission.bash).toBe("ask");
    expect(getOpencodeAutoAllowStatus(settings).state).toBe("safe");

    const review = await runOpencodeSetupStep("auto-allow review", settings, { live: false });
    expect(review.reply).toContain("[review]");
    expect(getOpencodeAutoAllowStatus(settings).state).toBe("review");

    const status = await runOpencodeSetupStep("auto-allow status", settings, { live: false });
    expect(status.reply).toContain("auto-allow");

    const cleared = await runOpencodeSetupStep("auto-allow clear", settings, { live: false });
    expect(cleared.reply).toContain("cleared");
    const afterClear = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"));
    expect(afterClear.model).toBe("ollama/qwen3:8b"); // still preserved
    expect(afterClear.permission).toBeUndefined();

    const bad = await runOpencodeSetupStep("auto-allow bogus", settings, { live: false });
    expect(bad.reply).toContain("full|safe|review");
});

test("apply/clear helpers fail without an explicit project path", () => {
    expect(applyOpencodeAutoAllow({}, "full").success).toBe(false);
    expect(clearOpencodeAutoAllow({}).success).toBe(false);
});

test("setup status surfaces the auto-allow permission line", async () => {
    const dir = path.join(SCRATCH, "autoallow-status");
    const st = await getOpencodeSetupStatus({ project_path: dir, opencode_model: "ollama/qwen3:8b" }, { live: false });
    expect(st.permissions.state).toBe("missing");
    expect(formatOpencodeSetupStatus(st)).toContain("Auto-allow");
});

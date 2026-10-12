import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildAstroMarkdown,
    createAstroPost,
    detectAstroIntent,
    formatAstroResult,
    getAstroProjectPath,
    htmlToMarkdown,
    isAstroProjectConfigured,
    listAstroPosts,
    parseAstroInput,
    publishAstroToGit,
    resolveAstroLang,
    resolveAstroTemplate,
    slugify,
    syncAstroVault,
} from "./astro_blog.js";

function makeProject() {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "astro-test-"));
    fs.writeFileSync(path.join(project, "astro.config.mjs"), "export default {};\n");
    fs.writeFileSync(path.join(project, "package.json"), '{"name":"t"}\n');
    fs.mkdirSync(path.join(project, "src", "content", "blog"), { recursive: true });
    return project;
}

describe("astro blog publishing", () => {
    test("project path defaults to artefaktas-astro, overridable", () => {
        const prev = process.env.ASTRO_PROJECT_PATH;
        try {
            delete process.env.ASTRO_PROJECT_PATH;
            expect(getAstroProjectPath({})).toBe("/home/writing_machine/github/artefaktas-astro");
            expect(getAstroProjectPath({ astro_project_path: "/tmp/x" })).toBe("/tmp/x");
            process.env.ASTRO_PROJECT_PATH = "/tmp/env";
            expect(getAstroProjectPath({ astro_project_path: "/tmp/set" })).toBe("/tmp/set");
        } finally {
            if (prev === undefined) delete process.env.ASTRO_PROJECT_PATH;
            else process.env.ASTRO_PROJECT_PATH = prev;
        }
    });

    test("isAstroProjectConfigured checks astro.config + package.json", () => {
        const project = makeProject();
        expect(isAstroProjectConfigured({ astro_project_path: project })).toBe(true);
        expect(isAstroProjectConfigured({ astro_project_path: "/nonexistent-xyz" })).toBe(false);
        fs.rmSync(project, { recursive: true, force: true });
    });

    test("slugify + lang/template resolution", () => {
        expect(slugify("Hello World! Test")).toBe("hello-world-test");
        expect(resolveAstroLang({ lang: "en" }, {})).toBe("en");
        expect(resolveAstroLang({}, { astro_default_lang: "en" })).toBe("en");
        expect(resolveAstroLang({}, {})).toBe("lt");
        expect(resolveAstroTemplate({ template: "generic" }, {})).toBe("generic");
        expect(resolveAstroTemplate({}, {})).toBe("daily");
    });

    test("htmlToMarkdown converts LLM html to markdown", () => {
        const md = htmlToMarkdown("<h2>T</h2><p>Hello <em>world</em></p><ul><li>a</li><li>b</li></ul>");
        expect(md).toContain("## T");
        expect(md).toContain("Hello *world*");
        expect(md).toContain("- a");
    });

    test("buildAstroMarkdown daily LT matches newpost.py conventions", () => {
        const { title, markdown } = buildAstroMarkdown({
            title: "",
            pubDate: "2026-09-29",
            body: "Testas.",
            template: "daily",
            lang: "lt",
            topic: "testas",
        });
        expect(title).toBe("2026-09-29");
        expect(markdown).toContain('pubDate: "2026-09-29"');
        expect(markdown).toContain("Sveika, elektroerdve,");
        expect(markdown).toContain("ko-fi");
        expect(markdown).toContain("Testas.");
    });

    test("createAstroPost writes daily file with increment", async () => {
        const project = makeProject();
        const settings = { astro_project_path: project };
        const r1 = await createAstroPost("test topic", settings, {
            content: "Body one.",
            template: "daily",
            date: "2026-09-29",
            build: false,
            push: false,
            vault: false,
        });
        expect(r1.success).toBe(true);
        expect(r1.filename).toBe("2026-09-29.md");
        expect(fs.existsSync(r1.filepath)).toBe(true);
        const r2 = await createAstroPost("test topic", settings, {
            content: "Body two.",
            template: "daily",
            date: "2026-09-29",
            build: false,
            push: false,
            vault: false,
        });
        expect(r2.filename).toBe("2026-09-29_1.md");
        fs.rmSync(project, { recursive: true, force: true });
    });

    test("createAstroPost generic uses slug filename", async () => {
        const project = makeProject();
        const settings = { astro_project_path: project };
        const r = await createAstroPost("My Cool Topic", settings, {
            content: "Hello.",
            template: "generic",
            lang: "en",
            build: false,
            push: false,
            vault: false,
        });
        expect(r.success).toBe(true);
        expect(r.filename).toBe("my-cool-topic.md");
        const raw = fs.readFileSync(r.filepath, "utf8");
        expect(raw).toContain("My Cool Topic");
        fs.rmSync(project, { recursive: true, force: true });
    });

    test("createAstroPost rejects empty input without touching disk", async () => {
        const project = makeProject();
        const r = await createAstroPost("   ", { astro_project_path: project }, {});
        expect(r.success).toBe(false);
        expect(fs.readdirSync(path.join(project, "src", "content", "blog")).length).toBe(0);
        fs.rmSync(project, { recursive: true, force: true });
    });

    test("syncAstroVault copies only missing files (movetovault.py behavior)", () => {
        const project = makeProject();
        const settings = { astro_project_path: project };
        fs.writeFileSync(path.join(project, "src", "content", "blog", "2026-09-29.md"), "x");
        const r1 = syncAstroVault(settings);
        expect(r1.success).toBe(true);
        expect(r1.copied).toBe(1);
        const r2 = syncAstroVault(settings);
        expect(r2.copied).toBe(0);
        fs.rmSync(project, { recursive: true, force: true });
    });

    test("listAstroPosts returns newest first with limit", async () => {
        const project = makeProject();
        const settings = { astro_project_path: project };
        await createAstroPost("a", settings, { content: "a", template: "daily", date: "2026-09-28", build: false, push: false, vault: false });
        await createAstroPost("b", settings, { content: "b", template: "daily", date: "2026-09-29", build: false, push: false, vault: false });
        const list = listAstroPosts(settings, { limit: 1 });
        expect(list.success).toBe(true);
        expect(list.files.length).toBe(1);
        expect(list.files[0].filename).toBe("2026-09-29.md");
        fs.rmSync(project, { recursive: true, force: true });
    });

    test("publishAstroToGit uses injected runner (no real git)", async () => {
        const project = makeProject();
        const calls = [];
        const runner = async (cmd, args, cwd) => {
            calls.push([cmd, ...args].join(" "));
            return { success: true, stdout: "", stderr: "" };
        };
        const res = await publishAstroToGit({ astro_project_path: project }, { message: "test" }, runner);
        expect(res.success).toBe(true);
        expect(calls.join("|")).toContain("git add");
        expect(calls.join("|")).toContain("git push");
        fs.rmSync(project, { recursive: true, force: true });
    });

    test("parseAstroInput covers post/build/list/status/path/publish", () => {
        expect(parseAstroInput("@astro-post cats --lang en --template generic")).toEqual({
            action: "post",
            topic: "cats",
            title: "",
            lang: "en",
            template: "generic",
            date: "",
            slug: "",
            description: "",
            message: "",
            dryRun: false,
            build: true,
            push: true,
            vault: true,
            show: true,
        });
        const p2 = parseAstroInput("@astro-post mano diena --title Diena --date 2026-09-29 --no-push --dry-run");
        expect(p2.topic).toBe("mano diena");
        expect(p2.title).toBe("Diena");
        expect(p2.date).toBe("2026-09-29");
        expect(p2.push).toBe(false);
        expect(p2.dryRun).toBe(true);
        expect(parseAstroInput("@astro-build")).toEqual({ action: "build" });
        expect(parseAstroInput("@astro-status")).toEqual({ action: "status" });
        expect(parseAstroInput("@astro-list 5")).toEqual({ action: "list", limit: 5 });
        expect(parseAstroInput("@astro-path /tmp/x")).toEqual({ action: "path", path: "/tmp/x" });
        expect(parseAstroInput("@blog hello")).toBeNull();
    });

    test("detectAstroIntent matches astro callouts only", () => {
        expect(detectAstroIntent("write a post about cats on astro")).toEqual({ topic: "cats" });
        expect(detectAstroIntent("@Parsly, publish an article about AI on astro")).toEqual({ topic: "AI" });
        expect(detectAstroIntent("write a blog post about cats")).toBeNull();
        expect(detectAstroIntent("I love astro")).toBeNull();
    });

    test("formatter renders post/status/error", () => {
        expect(formatAstroResult({ success: false, error: "boom" })).toContain("boom");
        expect(formatAstroResult({ success: true, title: "T", filename: "f.md", filepath: "/p" })).toContain("Astro post");
    });
});

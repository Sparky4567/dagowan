// ---------------------------------------------------------------------------
// Astro blog publishing automation (artefaktas-astro project).
//
// Uses the existing Astro project on disk (default
// /home/writing_machine/github/artefaktas-astro) and its conventions:
//   - posts live in <project>/src/content/blog/*.md(.mdx)
//   - frontmatter schema: title, description, pubDate, updatedDate?, heroImage?
//     (see src/content.config.ts)
//   - daily filename convention YYYY-MM-DD.md with _1/_2 increment
//     (mirrors python_scripts_portable/newpost.py)
//   - vault backup: <project>/vault/*.md (mirrors movetovault.py)
//   - publish flow: npm run build && git add/commit/push (mirrors remote.sh)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveDraftContent, resolveCharacterVoice } from "./blog_api.js";
import { unifiedChat } from "./providers.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_ASTRO_PROJECT_PATH = "/home/writing_machine/github/artefaktas-astro";
export const ASTRO_BLOG_SUBDIR = path.join("src", "content", "blog");
export const ASTRO_VAULT_SUBDIR = "vault";
export const DEFAULT_HERO_IMAGE =
    "https://www.dropbox.com/scl/fi/ozwb8141r9p1gegm74zk1/artefaktas_eu.jpg?rlkey=kex3z13fdg0eciums3driexp7&st=73a95se8&dl=1";

// --- Path resolution -------------------------------------------------------

export function getAstroProjectPath(settings = {}) {
    const raw =
        (settings && (settings.astro_project_path || settings.astro_path)) ||
        process.env.ASTRO_PROJECT_PATH ||
        process.env.ASTRO_PATH ||
        DEFAULT_ASTRO_PROJECT_PATH;
    return String(raw || "").trim();
}

export function getAstroBlogDir(settings = {}) {
    return path.join(getAstroProjectPath(settings), ASTRO_BLOG_SUBDIR);
}

export function getAstroVaultDir(settings = {}) {
    return path.join(getAstroProjectPath(settings), ASTRO_VAULT_SUBDIR);
}

export function getAstroBackupDir(settings = {}) {
    const raw =
        (settings && settings.astro_backup_dir) ||
        process.env.ASTRO_BACKUP_DIR ||
        "";
    return String(raw || "").trim();
}

export function isAstroProjectConfigured(settings = {}) {
    const project = getAstroProjectPath(settings);
    if (!project) return false;
    try {
        if (!fs.existsSync(path.join(project, "astro.config.mjs"))) return false;
        if (!fs.existsSync(path.join(project, "package.json"))) return false;
        return true;
    } catch {
        return false;
    }
}

export function getAstroStatus(settings = {}) {
    const project = getAstroProjectPath(settings);
    const blogDir = getAstroBlogDir(settings);
    const vaultDir = getAstroVaultDir(settings);
    let posts = 0;
    try {
        if (fs.existsSync(blogDir)) {
            posts = fs.readdirSync(blogDir).filter((f) => /\.mdx?$/.test(f)).length;
        }
    } catch {}
    return {
        project,
        blogDir,
        vaultDir,
        configured: isAstroProjectConfigured(settings),
        blogDirExists: (() => { try { return fs.existsSync(blogDir); } catch { return false; } })(),
        posts,
        autoBuild: settings?.astro_auto_build !== false,
        autoPush: settings?.astro_auto_push !== false,
        autoVault: settings?.astro_auto_vault !== false,
        defaultLang: String(settings?.astro_default_lang || process.env.ASTRO_DEFAULT_LANG || "lt").toLowerCase(),
    };
}

// --- Filename / slug helpers (mirror newpost.py increment behavior) --------

export function slugify(s) {
    return String(s || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "post";
}

function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

function isIsoDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

/** Increment like newpost.py: base.md, base_1.md, base_2.md ... */
export function resolveIncrementedFilename(blogDir, baseName, extension = ".md") {
    const first = path.join(blogDir, `${baseName}${extension}`);
    if (!fs.existsSync(first)) return { filename: `${baseName}${extension}`, filepath: first };
    let counter = 1;
    while (true) {
        const filename = `${baseName}_${counter}${extension}`;
        const filepath = path.join(blogDir, filename);
        if (!fs.existsSync(filepath)) return { filename, filepath };
        counter += 1;
        if (counter > 10000) throw new Error("Too many colliding filenames.");
    }
}

export function resolveAstroFilename(blogDir, opts = {}) {
    const template = String(opts.template || "daily").toLowerCase();
    if (template === "daily") {
        const date = isIsoDate(opts.date) ? opts.date : todayIso();
        return resolveIncrementedFilename(blogDir, date);
    }
    const base = slugify(opts.slug || opts.title || opts.topic || todayIso());
    return resolveIncrementedFilename(blogDir, isIsoDate(opts.date) ? `${opts.date}-${base}` : base);
}

// --- HTML -> Markdown (LLM in blog_api.js returns HTML) ---------------------

export function htmlToMarkdown(html) {
    let s = String(html || "");
    s = s.replace(/```html?|```/g, "");
    s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n\n");
    s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n\n");
    s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n\n");
    s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "#### $1\n\n");
    s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
    s = s.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");
    s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
    s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
    s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
    s = s.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*");
    s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
    s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<[^>]+>/g, "");
    s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return s;
}

function escapeYaml(s) {
    return String(s || "").replace(/"/g, '\\"').slice(0, 300);
}

// --- Markdown body generation (per-post lang/template choice) --------------

export function resolveAstroLang(opts = {}, settings = {}) {
    const raw = String(opts.lang || opts.language || settings?.astro_default_lang || process.env.ASTRO_DEFAULT_LANG || "lt")
        .trim()
        .toLowerCase();
    if (["lt", "lithuanian", "lietuviu", "lietuvių"].includes(raw)) return "lt";
    if (["en", "english", "anglu", "anglų"].includes(raw)) return "en";
    return "lt";
}

export function resolveAstroTemplate(opts = {}, settings = {}) {
    const raw = String(opts.template || settings?.astro_default_template || process.env.ASTRO_DEFAULT_TEMPLATE || "daily")
        .trim()
        .toLowerCase();
    if (["generic", "standard", "english", "en"].includes(raw)) return "generic";
    return "daily";
}

async function generateAstroMarkdown(topic, { settings = {}, ollamaClient = null, lang = "lt", characterPersona = "", characterName = "" } = {}) {
    const cleanTopic = String(topic || "").trim().replace(/\s+/g, " ");
    if (!cleanTopic) throw new Error("No topic.");
    const voice = resolveCharacterVoice({ characterPersona, characterName }, settings);
    const modelName = (settings && settings.model) || "smollm2:135m";
    const langRule = lang === "en"
        ? "Write the post in English."
        : "Write the post in Lithuanian (lietuvių kalba).";
    const baseRules = `You write complete, publishable blog posts and return ONLY the post as Markdown (## / ### headings, paragraphs, "- " bullet lists, *emphasis*). No HTML, no code fences, no preamble. ${langRule} 300-500 words with a practical takeaway at the end. The very first line must be the post title in the form "Title: <title>" on its own line, then the Markdown body.`;
    const systemContent = voice.persona
        ? `${voice.persona}\n\n---\nTask: ${baseRules} Write in your own voice as ${voice.name || "the requesting character"} — same persona, vocabulary, humor and attitude as your system persona above. Stay in character for the whole post.`
        : baseRules;
    const res = await unifiedChat({
        modelName,
        settings,
        ollamaClient,
        stream: false,
        messages: [
            { role: "system", content: systemContent },
            { role: "user", content: `Write an engaging blog post about "${cleanTopic}".` },
        ],
    });
    const raw = String((res && res.content) || "").trim();
    if (!raw) throw new Error("Empty LLM response.");
    let title = "";
    let body = raw;
    const m = raw.match(/^\s*Title\s*:\s*(.+?)\s*$/m);
    if (m) {
        title = m[1].trim().slice(0, 150);
        body = (raw.slice(0, m.index).trim() + "\n" + raw.slice(m.index + m[0].length).trim()).trim();
    }
    body = body.replace(/```markdown?|```/g, "").trim().slice(0, 12000);
    if (!body) throw new Error("Empty post body.");
    return { title, body };
}

function dailyFooterLt(dateStr) {
    return `\n\n[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/K3K06VU8Z)\n\nIki sekančio susiskaitymo.\n\nŠis ekranas trumpam išsijungia, bet kažkur įsijungia kitas.\n\n| #    | Žymos                \t\t\t|\n| ---- | ---------------------------------------|\n|      | #post #artefaktas_eu #personal #opinion|\n\n> Asmeninė nuomonė.\n\n> Thinking out loud, responsibly.\n\n> Artefaktas.eu is a personal digital garden exploring technology, creativity, and the craft of building things online. Posts range from reflections on blogging tools and web frameworks to thoughts on AI, productivity, and digital minimalism — always with a mix of humor, curiosity, and hands-on experimentation.\n\n> Author: Artefaktas\n> About author: I’m a creator-blogger driven by curiosity, blending writing, art, music, code, and the elegance of math and physics into everything I do.\n`;
}

function genericFooterEn() {
    return `\n\n---\n\n*Personal opinion. Thinking out loud, responsibly.*\n`;
}

export function buildAstroMarkdown({ title, description = "", pubDate, heroImage = DEFAULT_HERO_IMAGE, body, template = "daily", lang = "lt", topic = "" }) {
    const date = isIsoDate(pubDate) ? pubDate : todayIso();
    const finalTitle = String(title || "").trim() || (template === "daily" ? date : String(topic).trim() || "Untitled");
    const finalDesc = String(description || "").trim() || (template === "daily" && lang === "lt" ? "Šiandienos įrašas" : String(topic).trim().slice(0, 160));
    const cleanBody = String(body || "").trim() || (lang === "en" ? "Draft body — edit before publishing." : "Juodraščio tekstas — paredaguokite prieš publikuodami.");
    const frontmatter =
        `---\ntitle: "${escapeYaml(finalTitle)}"\ndescription: "${escapeYaml(finalDesc)}"\npubDate: "${date}"\nheroImage: "${escapeYaml(heroImage)}"\n---\n`;
    let content;
    if (template === "daily" && lang === "lt") {
        const heading = `# ${date}\n\n> TLDR;\n> Šiandienos tema: ${finalTitle}\n\nSveika, elektroerdve,\n\n${cleanBody}\n`;
        content = frontmatter + `\n${heading}${dailyFooterLt(date)}`;
    } else if (template === "daily") {
        content = frontmatter + `\n# ${finalTitle}\n\n${cleanBody}\n${genericFooterEn()}`;
    } else {
        content = frontmatter + `\n# ${finalTitle}\n\n${cleanBody}\n${lang === "lt" ? dailyFooterLt(date) : genericFooterEn()}`;
    }
    return { title: finalTitle, description: finalDesc, pubDate: date, markdown: content };
}

// --- Core: create a post file ----------------------------------------------

export async function createAstroPost(topic, settings = {}, opts = {}) {
    const cleanTopic = String(topic || "").trim();
    const explicitBody = String((opts && (opts.content || opts.body || opts.markdown)) || "").trim();
    if (!cleanTopic && !explicitBody) {
        return { success: false, error: "Usage: provide a topic for the post." };
    }
    const project = getAstroProjectPath(settings);
    if (!project) return { success: false, error: "Astro project path not set. Use @astro-path <dir> or set ASTRO_PROJECT_PATH." };
    const blogDir = getAstroBlogDir(settings);
    try {
        if (!fs.existsSync(blogDir)) fs.mkdirSync(blogDir, { recursive: true });
    } catch (err) {
        return { success: false, error: `Cannot access blog dir ${blogDir}: ${err.message || err}` };
    }

    const lang = resolveAstroLang(opts, settings);
    const template = resolveAstroTemplate(opts, settings);
    const title = String(opts.title || "").trim();
    const description = String(opts.description || "").trim();
    const heroImage = String(opts.heroImage || opts.hero_image || settings?.astro_hero_image || DEFAULT_HERO_IMAGE).trim() || DEFAULT_HERO_IMAGE;
    const date = isIsoDate(opts.date || opts.pubDate) ? (opts.date || opts.pubDate) : todayIso();

    let body = explicitBody;
    let generatedTitle = "";
    if (!body) {
        const voice = resolveCharacterVoice(opts, opts.settings || settings);
        const voiceOpts = voice.persona || voice.name
            ? { characterPersona: voice.persona, characterName: voice.name }
            : {};
        const gen = (opts && opts.generateContent) || null;
        if (typeof gen === "function") {
            try {
                const out = await gen(cleanTopic, title);
                if (typeof out === "string" && out.trim()) body = out.trim().slice(0, 12000);
                else if (out && String(out.content || "").trim()) {
                    body = String(out.content).replace(/```html?|```/g, "").trim().slice(0, 12000);
                    // HTML from blog_api generators -> markdown.
                    if (/<[a-z][^>]*>/i.test(body)) body = htmlToMarkdown(body);
                    if (out.title && !title) generatedTitle = String(out.title).trim().slice(0, 150);
                }
            } catch {}
        } else if (opts.settings?.model || opts.settings?.server_url || settings?.model || settings?.server_url || voice.persona) {
            try {
                const out = await generateAstroMarkdown(cleanTopic, {
                    settings: opts.settings || settings,
                    ollamaClient: opts.ollamaClient || null,
                    lang,
                    ...voiceOpts,
                });
                body = out.body;
                if (out.title && !title) generatedTitle = out.title;
            } catch {}
        }
        if (!body) {
            // Last resort: reuse the WordPress/Blogger HTML draft pipeline, then convert.
            try {
                const draft = await resolveDraftContent(cleanTopic, { ...opts, settings: opts.settings || settings });
                if (draft && String(draft.content || "").trim()) {
                    body = /<[a-z][^>]*>/i.test(draft.content) ? htmlToMarkdown(draft.content) : String(draft.content).trim();
                    if (draft.title && !title && !generatedTitle) generatedTitle = draft.title;
                }
            } catch {}
        }
        if (!body) body = lang === "en" ? "Draft body — edit before publishing." : "Juodraščio tekstas — paredaguokite prieš publikuodami.";
    }

    const finalTitle = title || generatedTitle || (template === "daily" ? date : cleanTopic.slice(0, 120));
    const built = buildAstroMarkdown({
        title: finalTitle,
        description: description || cleanTopic.slice(0, 160),
        pubDate: date,
        heroImage,
        body,
        template,
        lang,
        topic: cleanTopic,
    });

    const { filename, filepath } = resolveAstroFilename(blogDir, {
        template,
        date: isIsoDate(opts.date || opts.pubDate) ? (opts.date || opts.pubDate) : "",
        title: built.title,
        slug: opts.slug,
        topic: cleanTopic,
    });

    if (opts.dryRun) {
        return { success: true, platform: "astro", title: built.title, filename, filepath, markdown: built.markdown, dryRun: true, source: "astro" };
    }
    try {
        fs.writeFileSync(filepath, built.markdown, { encoding: "utf8", flag: "wx" });
    } catch (err) {
        // Race: file appeared between check and write — increment once more.
        if (err && err.code === "EEXIST") {
            const retry = resolveIncrementedFilename(blogDir, path.basename(filepath, ".md"));
            fs.writeFileSync(retry.filepath, built.markdown, { encoding: "utf8", flag: "wx" });
            return { success: true, platform: "astro", title: built.title, filename: retry.filename, filepath: retry.filepath, pubDate: built.pubDate, source: "astro" };
        }
        return { success: false, error: `Cannot write post: ${err.message || err}` };
    }
    return { success: true, platform: "astro", title: built.title, filename, filepath, pubDate: built.pubDate, source: "astro" };
}

// --- Listing ----------------------------------------------------------------

export function listAstroPosts(settings = {}, opts = {}) {
    const blogDir = getAstroBlogDir(settings);
    const limit = Math.max(1, Math.min(100, Number(opts.limit) || 8));
    try {
        if (!fs.existsSync(blogDir)) return { success: false, error: `Blog dir not found: ${blogDir}` };
        const files = fs.readdirSync(blogDir)
            .filter((f) => /\.mdx?$/.test(f))
            .sort()
            .reverse()
            .slice(0, limit)
            .map((f) => {
                let title = "";
                try {
                    const head = fs.readFileSync(path.join(blogDir, f), "utf8").slice(0, 2000);
                    const m = head.match(/^title:\s*"?(.*?)"?\s*$/m);
                    if (m) title = m[1].trim();
                } catch {}
                return { filename: f, title };
            });
        return { success: true, files, blogDir };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
}

// --- Shell steps: build / vault sync / git publish --------------------------

async function runInDir(cmd, args, cwd, runner = null) {
    if (runner) return runner(cmd, args, cwd);
    try {
        const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
        return { success: true, stdout: String(stdout || ""), stderr: String(stderr || "") };
    } catch (err) {
        return {
            success: false,
            error: err.message || String(err),
            stdout: String((err && err.stdout) || ""),
            stderr: String((err && err.stderr) || ""),
        };
    }
}

export async function buildAstroSite(settings = {}, opts = {}, runner = null) {
    const project = getAstroProjectPath(settings);
    if (!isAstroProjectConfigured(settings)) {
        return { success: false, error: `Astro project not found at ${project}. Set with @astro-path <dir>.` };
    }
    const useNpm = String(opts.packageManager || settings?.astro_package_manager || "npm").trim() || "npm";
    return runInDir(useNpm, ["run", "build"], project, runner);
}

export function syncAstroVault(settings = {}, opts = {}) {
    const blogDir = getAstroBlogDir(settings);
    const vaultDir = getAstroVaultDir(settings);
    const extraDirs = [getAstroBackupDir(settings)].filter(Boolean);
    try {
        if (!fs.existsSync(blogDir)) return { success: false, error: `Blog dir not found: ${blogDir}` };
        if (!fs.existsSync(vaultDir)) fs.mkdirSync(vaultDir, { recursive: true });
        for (const d of extraDirs) {
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        }
        const files = fs.readdirSync(blogDir).filter((f) => /\.mdx?$/.test(f));
        let copied = 0;
        const copiedFiles = [];
        for (const f of files) {
            const targets = [path.join(vaultDir, f), ...extraDirs.map((d) => path.join(d, f))];
            for (const t of targets) {
                if (!fs.existsSync(t)) {
                    fs.copyFileSync(path.join(blogDir, f), t);
                    copied += 1;
                    copiedFiles.push(t);
                }
            }
        }
        return { success: true, copied, total: files.length, vaultDir, copiedFiles: copiedFiles.slice(0, 20) };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
}

export async function publishAstroToGit(settings = {}, opts = {}, runner = null) {
    const project = getAstroProjectPath(settings);
    if (!isAstroProjectConfigured(settings)) {
        return { success: false, error: `Astro project not found at ${project}.` };
    }
    const message = String(opts.message || "astro: new post").slice(0, 200);
    const steps = [];
    const add = await runInDir("git", ["add", "."], project, runner);
    steps.push({ step: "git add .", ...add });
    if (!add.success) return { success: false, error: `git add failed: ${add.error}`, steps };
    const commit = await runInDir("git", ["commit", "-m", message], project, runner);
    steps.push({ step: "git commit", ...commit });
    // "nothing to commit" is fine — still push.
    if (!commit.success && !/nothing to commit|empty/i.test(`${commit.error} ${commit.stdout} ${commit.stderr}`)) {
        return { success: false, error: `git commit failed: ${commit.error}`, steps };
    }
    const push = await runInDir("git", ["push"], project, runner);
    steps.push({ step: "git push", ...push });
    if (!push.success) return { success: false, error: `git push failed: ${push.error}`, steps };
    return { success: true, steps };
}

/** Full automation: create file -> build -> vault sync -> git push (skippable). */
export async function publishAstroPost(topic, settings = {}, opts = {}) {
    const doBuild = opts.build !== false && (settings?.astro_auto_build !== false || opts.build === true);
    const doVault = opts.vault !== false && (settings?.astro_auto_vault !== false || opts.vault === true);
    const doPush = opts.push !== false && (settings?.astro_auto_push !== false || opts.push === true);
    const created = await createAstroPost(topic, settings, opts);
    if (!created.success) return created;
    if (created.dryRun) return created;
    const result = { ...created, steps: {} };
    if (doVault) {
        result.steps.vault = syncAstroVault(settings, opts);
    }
    if (doBuild) {
        result.steps.build = await buildAstroSite(settings, opts, opts.runner || null);
        if (!result.steps.build.success && !opts.ignoreBuildErrors) {
            return { ...result, success: false, error: `Build failed: ${result.steps.build.error}` };
        }
    }
    if (doPush) {
        result.steps.git = await publishAstroToGit(settings, opts, opts.runner || null);
        if (!result.steps.git.success) {
            return { ...result, success: false, error: `Git publish failed: ${result.steps.git.error}` };
        }
    }
    return result;
}

// --- Command parsing --------------------------------------------------------
// @astro-post <topic> [--title T] [--lang lt|en] [--template daily|generic]
//   [--date YYYY-MM-DD] [--slug s] [--desc D] [--dry-run]
//   [--no-build] [--no-push] [--no-vault]
// @astro-build | @astro-status | @astro-list [N] | @astro-vault
// @astro-publish [--message M] | @astro-path [<dir>]

function stripFlags(body, names) {
    // Remove boolean flags (--dry-run) entirely; value flags (--title X)
    // are removed with their value so the topic stays clean.
    let out = ` ${body} `;
    const valueFlags = new Set(["title", "lang", "language", "template", "date", "slug", "desc", "description", "message", "m"]);
    for (const n of names) {
        if (valueFlags.has(n)) {
            out = out.replace(new RegExp(`\\s--${n}(?:\\s+|=)\\s*("[^"]*"|'[^']*'|[^\\s].*?)(?=\\s--|$)`, "gi"), " ");
        }
        out = out.replace(new RegExp(`\\s--${n}(\\s|$)`, "gi"), " ");
    }
    return out.trim();
}

function hasFlag(body, name) {
    return new RegExp(`\\s--${name}(\\s|$)`, "i").test(` ${body} `);
}

function extractOpt(body, name) {
    const m = body.match(new RegExp(`\\s--${name}(?:\\s+|=)\\s*("[^"]*"|'[^']*'|[^\\s].*?)(?=\\s--|$)`, "i"));
    if (!m) return "";
    return String(m[1] || "").trim().replace(/^["']|["']$/g, "").trim();
}

export function parseAstroInput(text) {
    const rawInput = String(text || "").trim();
    const norm = rawInput.startsWith("@") ? "/" + rawInput.slice(1) : rawInput;
    const low = norm.toLowerCase();
    const head = low.split(/\s/, 1)[0];

    if (head === "/astro-path" || head === "/astro-project-path") {
        return { action: "path", path: norm.slice(head.length).trim() };
    }
    if (head === "/astro-status") return { action: "status" };
    if (head === "/astro-build") return { action: "build" };
    if (head === "/astro-vault" || head === "/astro-sync") return { action: "vault" };
    if (head === "/astro-list" || head === "/astro-posts") {
        const rest = norm.slice(head.length).trim();
        const n = parseInt(rest, 10);
        return { action: "list", limit: Number.isFinite(n) && n > 0 ? n : 8 };
    }
    if (head === "/astro-publish" || head === "/astro-push") {
        const body = norm.slice(head.length).trim();
        return { action: "publish", message: extractOpt(body, "message") || extractOpt(body, "m") || "astro: rebuild" };
    }
    if (head === "/astro-post" || head === "/astro" || head === "/astro-new" || head === "/astro-publish-post") {
        let body = norm.slice(head.length).trim();
        const title = extractOpt(body, "title");
        const lang = extractOpt(body, "lang") || extractOpt(body, "language");
        const template = extractOpt(body, "template");
        const date = extractOpt(body, "date");
        const slug = extractOpt(body, "slug");
        const description = extractOpt(body, "desc") || extractOpt(body, "description");
        const message = extractOpt(body, "message") || extractOpt(body, "m");
        const dryRun = hasFlag(body, "dry-run");
        const noBuild = hasFlag(body, "no-build");
        const noPush = hasFlag(body, "no-push");
        const noVault = hasFlag(body, "no-vault");
        const topic = stripFlags(body, ["title", "lang", "language", "template", "date", "slug", "desc", "description", "message", "m", "dry-run", "no-build", "no-push", "no-vault", "show", "no-show"])
            .replace(/\s+/g, " ")
            .trim();
        return {
            action: "post",
            topic,
            title,
            lang: lang || "",
            template: template || "",
            date,
            slug,
            description,
            message,
            dryRun,
            build: !noBuild,
            push: !noPush,
            vault: !noVault,
            show: !hasFlag(body, "no-show"),
        };
    }
    return null;
}

/** Natural callout: "write/publish a post about X on astro". */
export function detectAstroIntent(text) {
    if (!text) return null;
    const raw = String(text).trim();
    const s = raw.replace(/^(?:@[\w-]+[\s,]*)+/, "").trim();
    if (!s) return null;
    const low = s.toLowerCase();
    if (!/\bastro\b/.test(low)) return null;
    if (!/\b(write|create|compose|draft|publish|post|make)\b/.test(low)) return null;
    if (!/\b(post|article|blog)\b/.test(low)) return null;
    const about = s.match(/\babout\s+(.+?)(?:\s+on\s+@?astro\s*[.!]?\s*)?$/i);
    let topic = about ? about[1].trim() : "";
    if (!topic) {
        const fb = s.match(/\b(?:post|article|blog)\b\s*[:\-]?\s*(.+?)(?:\s+on\s+@?astro\s*[.!]?\s*)?$/i);
        if (fb) topic = fb[1].trim();
    }
    topic = topic.replace(/@?astro\b/gi, "").replace(/^[:\-,\s]+|[:\-,\s.!]+$/g, "").trim();
    if (!topic) return null;
    return { topic };
}

// --- Formatting --------------------------------------------------------------

export function formatAstroResult(res) {
    if (!res || !res.success) return `⚠️ Astro error: ${(res && res.error) || "unknown error"}`;
    if (res.action === "status" || res.status) {
        const st = res.status;
        return `🌐 Astro project: ${st.project}\n${st.configured ? "✅" : "⚠️"} astro.config.mjs ${st.configured ? "found" : "missing"} · ${st.posts} post(s) in src/content/blog · vault: ${st.vaultDir}`;
    }
    if (res.action === "list" || res.files) {
        const lines = (res.files || []).map((f) => `  • ${f.filename}${f.title ? ` — ${f.title}` : ""}`);
        return `📚 Latest Astro posts (${(res.files || []).length}):\n${lines.join("\n") || "  (none)"}`;
    }
    if (res.title && res.filename) {
        const parts = [`📝 Astro post: "${res.title}"`, `📄 ${res.filename}${res.filepath ? ` (${res.filepath})` : ""}`];
        if (res.dryRun) parts.push("🔍 Dry run — file not written.");
        if (res.steps) {
            if (res.steps.vault) parts.push(res.steps.vault.success ? `📦 Vault sync: ${res.steps.vault.copied} new file(s).` : `⚠️ Vault sync failed: ${res.steps.vault.error}`);
            if (res.steps.build) parts.push(res.steps.build.success ? "🔨 Build OK (npm run build)." : `⚠️ Build failed: ${res.steps.build.error}`);
            if (res.steps.git) parts.push(res.steps.git.success ? "🚀 Pushed to git." : `⚠️ Git push failed: ${res.steps.git.error}`);
        }
        return parts.join("\n");
    }
    if (res.steps || res.copied !== undefined || res.stdout !== undefined) {
        if (res.copied !== undefined) return `📦 Vault sync: ${res.copied} new file(s) of ${res.total}.`;
        if (res.stdout !== undefined) return res.success ? "🔨 Astro build OK." : `⚠️ Astro build failed: ${res.error}`;
        if (res.steps) return res.success ? "🚀 Astro publish OK (git push)." : `⚠️ Astro publish failed: ${res.error}`;
    }
    return "✅ Astro OK.";
}

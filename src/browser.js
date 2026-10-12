import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgenticModule } from "./agentic.js";

// ---------------------------------------------------------------------------
// Agentic browser service (Playwright/Chromium).
//
// Behavior: drives a VISIBLE local browser window by default so the user can
// watch playback (e.g. @youtube-play). On display-less machines (servers,
// Docker) it automatically falls back to headless. Override with
// BROWSER_HEADLESS=1/0 or settings.browser_headless (true/false/"auto").
//
// Design notes (kept deliberately small so the rest of the project is
// untouched):
// - Playwright is an *optional* dependency: it is imported lazily, and every
//   public method fails with a clear install hint when it is missing.
// - One persistent Chromium context (cookies/profile survive restarts in
//   data/browser-profile). Single-flight navigation queue.
// - Domain allowlist: settings.browser_allowed_domains or
//   BROWSER_ALLOWED_DOMAINS="youtube.com,google.com,spotify.com" (default below).
// - Every action is appended to logs/browser.log for auditability.
// ---------------------------------------------------------------------------

export const BROWSER_DEFAULT_ALLOWED_DOMAINS = ["youtube.com", "youtu.be", "google.com", "giphy.com", "spotify.com", "wordpress.com", "blogger.com", "blogspot.com"];
export const BROWSER_NAV_TIMEOUT_MS = Number(process.env.BROWSER_NAV_TIMEOUT_MS || 30000);
export const BROWSER_PROFILE_DIR = path.join(process.cwd(), "data", "browser-profile");
export const BROWSER_LOG_FILE = path.join(process.cwd(), "logs", "browser.log");

export function resolveAllowedDomains(settings = {}) {
    const fromEnv = String(process.env.BROWSER_ALLOWED_DOMAINS || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    if (fromEnv.length > 0) return [...new Set(fromEnv)];
    const fromSettings = Array.isArray(settings.browser_allowed_domains)
        ? settings.browser_allowed_domains.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
        : [];
    if (fromSettings.length > 0) return [...new Set(fromSettings)];
    return [...BROWSER_DEFAULT_ALLOWED_DOMAINS];
}

export function isAllowedUrl(urlStr, settings = {}) {
    try {
        const u = new URL(String(urlStr));
        if (u.protocol !== "http:" && u.protocol !== "https:") return false;
        const host = u.hostname.toLowerCase();
        return resolveAllowedDomains(settings).some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
        return false;
    }
}

export function buildYoutubeSearchUrl(query) {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(String(query).trim())}`;
}

/** Normalize youtu.be / shorts / watch hrefs to a canonical watch URL. */
export function extractYoutubeWatchUrl(href) {
    if (!href) return null;
    try {
        const u = new URL(href, "https://www.youtube.com");
        const host = u.hostname.toLowerCase();
        if (host === "youtu.be") {
            const id = u.pathname.split("/").filter(Boolean)[0];
            return id ? `https://www.youtube.com/watch?v=${id}` : null;
        }
        if (host.endsWith("youtube.com")) {
            if (u.pathname === "/watch" && u.searchParams.get("v")) {
                return `https://www.youtube.com/watch?v=${u.searchParams.get("v")}`;
            }
            const short = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/);
            if (short) return `https://www.youtube.com/watch?v=${short[2]}`;
        }
        return null;
    } catch {
        return null;
    }
}

export function looksLikeYoutubeUrl(text) {
    return extractYoutubeWatchUrl(String(text || "").trim()) !== null;
}

export function buildSpotifySearchUrl(query) {
    return `https://open.spotify.com/search/${encodeURIComponent(String(query).trim())}`;
}

/**
 * Normalize Spotify links to a canonical open.spotify.com URL.
 * Handles https://open.spotify.com/{track,episode,show,album,playlist,artist}/<id>
 * (with or without query strings / locale prefixes) and spotify:<type>:<id> URIs.
 */
export function extractSpotifyUrl(href) {
    if (!href) return null;
    const text = String(href).trim();
    const uriMatch = text.match(/^spotify:(track|episode|show|album|playlist|artist):([A-Za-z0-9]{6,})/i);
    if (uriMatch) {
        return `https://open.spotify.com/${uriMatch[1].toLowerCase()}/${uriMatch[2]}`;
    }
    try {
        const u = new URL(text, "https://open.spotify.com");
        const host = u.hostname.toLowerCase();
        if (host !== "open.spotify.com" && !host.endsWith(".spotify.com")) return null;
        const m = u.pathname.match(/\/(track|episode|show|album|playlist|artist)\/([A-Za-z0-9]{6,})/);
        if (m) return `https://open.spotify.com/${m[1].toLowerCase()}/${m[2]}`;
        return null;
    } catch {
        return null;
    }
}

export function looksLikeSpotifyUrl(text) {
    return extractSpotifyUrl(String(text || "").trim()) !== null;
}

export const SPOTIFY_KIND_PRIORITY = ["track", "episode", "album", "playlist", "show", "artist"];

/**
 * Rank Spotify results so a specific song/episode wins over containers.
 * Logged-out search pages surface albums/playlists first; without ranking,
 * `@spotify-play <song>` opens (and plays) a playlist instead of the song.
 */
export function rankSpotifyResults(items) {
    const rank = (kind) => {
        const i = SPOTIFY_KIND_PRIORITY.indexOf(String(kind || "").toLowerCase());
        return i === -1 ? SPOTIFY_KIND_PRIORITY.length : i;
    };
    return [...(items || [])].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** Prefer a playable item (track/episode) over album/playlist/show containers. */
export function pickSpotifyResult(items) {
    const ranked = rankSpotifyResults(items);
    return ranked.find((r) => r.kind === "track" || r.kind === "episode") || ranked[0] || null;
}

/**
 * Shared "@youtube-play ... | @play ..." parser used by the CLI, Telegram
 * and WhatsApp routers so all surfaces behave identically.
 * Returns null when `text` is not a play command, otherwise
 * `{ query, show }` (`query === ""` means usage help should be shown).
 * The video is handed off to the system default browser unless `--no-show`
 * is given (explicit `--show` is still accepted).
 */
export function parsePlayInput(text) {
    const rawInput = String(text || "").trim();
    const norm = rawInput.startsWith("@") ? "/" + rawInput.slice(1) : rawInput;
    const low = norm.toLowerCase();
    if (!(low.startsWith("/youtube-play") || low === "/play" || low.startsWith("/play "))) return null;
    const body = low.startsWith("/youtube-play") ? norm.slice("/youtube-play".length).trim() : norm.replace(/^\/play/i, "").trim();
    const tagged = ` ${body} `;
    const show = !/\s--no-show(\s|$)/i.test(tagged);
    const query = body.replace(/\s--(no-)?show(\s|$)/gi, " ").trim();
    return { query, show };
}

/** One-line-ish chat reply for a playYoutube result (bridges + CLI). */
export function formatPlayResult(res) {
    if (!res || !res.success) return `⚠️ Browser playback error: ${(res && res.error) || "unknown error"}`;
    let handoff = "";
    if (res.shown) handoff = "\n🖥 Opened in your default browser." + (res.controlledClosed ? " Controlled window closed." : "");
    else if (res.showError) handoff = `\n⚠️ Default-browser handoff failed: ${res.showError}`;
    let via = "";
    if (res.source === "api") via = "\n🔑 via YouTube Data API (no browser needed).";
    else if (res.source === "url-direct") via = "\n🔗 Direct link (no search needed).";
    else if (res.source === "browser" && res.fallbackReason) via = `\n🌐 via local browser fallback (API unavailable: ${res.fallbackReason}).`;
    return `▶️ Now playing: "${res.title || "YouTube video"}"\n🔗 ${res.url}\n▶️ State: ${res.playing ? "playing" : "loaded"}${handoff}${via}`;
}

/**
 * Shared "@spotify-play ... | @spotify ..." parser (songs + podcasts).
 * Mirrors parsePlayInput so all surfaces behave identically.
 * Returns null when `text` is not a spotify command, otherwise
 * `{ query, show }` (`query === ""` means usage help should be shown).
 */
export function parseSpotifyPlayInput(text) {
    const rawInput = String(text || "").trim();
    const norm = rawInput.startsWith("@") ? "/" + rawInput.slice(1) : rawInput;
    const low = norm.toLowerCase();
    if (!(low.startsWith("/spotify-play") || low === "/spotify" || low.startsWith("/spotify "))) return null;
    const body = low.startsWith("/spotify-play") ? norm.slice("/spotify-play".length).trim() : norm.replace(/^\/spotify/i, "").trim();
    const tagged = ` ${body} `;
    const show = !/\s--no-show(\s|$)/i.test(tagged);
    const query = body.replace(/\s--(no-)?show(\s|$)/gi, " ").trim();
    return { query, show };
}

/**
 * Chat reply for a playSpotify result. Spotify Web requires a login for
 * full-track playback in the controlled window, so the handoff line tells
 * the user where uninterrupted playback continues. Unlike YouTube, the
 * opened Spotify page never autoplays on load — `playing` reports whether
 * the controlled window actually started it.
 */
export function formatSpotifyPlayResult(res) {
    if (!res || !res.success) return `⚠️ Spotify playback error: ${(res && res.error) || "unknown error"}`;
    let handoff = "";
    if (res.shown) handoff = "\n🖥 Opened in your default browser / Spotify app (log in there for full playback)." + (res.controlledClosed ? " Controlled window closed." : "");
    else if (res.showError) handoff = `\n⚠️ Default-browser handoff failed: ${res.showError}`;
    const kind = res.kind ? ` (${res.kind})` : "";
    const state = res.playing ? "playing" : "loaded (not playing yet — press play on the opened page)";
    const loginHint = !res.playing && res.needsLogin ? "\n🔑 Spotify is asking for a login: full tracks need a logged-in session." : "";
    let via = "";
    if (res.source === "api") via = "\n🔑 via Spotify Web API (no browser needed).";
    else if (res.source === "url-direct") via = "\n🔗 Direct link (no search needed).";
    else if (res.source === "browser" && res.fallbackReason) via = `\n🌐 via local browser fallback (API unavailable: ${res.fallbackReason}).`;
    return `🎧 Spotify${kind}: "${res.title || "Spotify track"}"\n🔗 ${res.url}\n▶️ State: ${state}${loginHint}${handoff}${via}`;
}

/** Normalize a blog platform token to "wordpress" | "blogger" | "auto". */
export function normalizeBlogPlatform(raw) {
    const s = String(raw || "").trim().toLowerCase();
    if (["wordpress", "word-press", "wp", "wpblog", "word_press"].includes(s)) return "wordpress";
    if (["blogger", "blogspot", "blog-spot", "blog"].includes(s)) return "blogger";
    return "auto";
}

/**
 * Shared "@blog ... | @wordpress ... | @blogger ... | @post ..." parser
 * used by the CLI, Telegram and WhatsApp routers so all surfaces behave
 * identically. Mirrors parsePlayInput / parseSpotifyPlayInput.
 * Returns null when `text` is not a blog command, otherwise
 * `{ platform, topic, title, show }` (`topic === ""` means usage help
 * should be shown). The editor is handed off to the system default
 * browser unless `--no-show` is given.
 *
 * Flags:
 *   --on wordpress|blogger   (or a trailing "on wordpress/blogger")
 *   --title <title>          (or --title=<title>)
 */
export function parseBlogInput(text) {
    const rawInput = String(text || "").trim();
    const norm = rawInput.startsWith("@") ? "/" + rawInput.slice(1) : rawInput;
    const low = norm.toLowerCase();
    const head = low.split(/\s/, 1)[0];
    let platform = "auto";
    let body = null;
    if (head === "/blog" || head === "/post" || head === "/blog-post" || head === "/blogpost") {
        body = norm.slice(head.length).trim();
    } else if (head === "/wordpress" || head === "/wp") {
        platform = "wordpress";
        body = norm.slice(head.length).trim();
    } else if (head === "/blogger" || head === "/blogspot") {
        platform = "blogger";
        body = norm.slice(head.length).trim();
    } else {
        return null;
    }
    const tagged = ` ${body} `;
    const show = !/\s--no-show(\s|$)/i.test(tagged);
    let title = "";
    const titleEq = body.match(/\s--title\s*=\s*("[^"]*"|'[^']*'|[^\s].*?)(?=\s--|$)/i);
    const titleSp = body.match(/\s--title\s+("[^"]*"|'[^']*'|[^\s].*?)(?=\s--|$)/i);
    const titleMatch = titleEq || titleSp;
    if (titleMatch) {
        title = String(titleMatch[1] || "").trim().replace(/^["']|["']$/g, "").trim();
    }
    let onFlag = "auto";
    const onMatch = body.match(/\s--on(?:e)?(?:\s+|=)\s*([a-z-]+)/i);
    if (onMatch) onFlag = normalizeBlogPlatform(onMatch[1]);
    let topic = body
        .replace(/\s--title\s*=?\s*("[^"]*"|'[^']*'|[^\s].*?)(?=\s--|$)/gi, " ")
        .replace(/\s--on(?:e)?(?:\s+|=)\s*[a-z-]+/gi, " ")
        .replace(/\s--(no-)?show(\s|$)/gi, " ")
        .trim();
    // Trailing "on wordpress/blogger" (with or without @) selects the platform.
    const trailing = topic.match(/\s+on\s+@?(wordpress|blogger|blogspot|blog|\bwp\b)\s*[.!]?\s*$/i);
    if (trailing) {
        const p = normalizeBlogPlatform(trailing[1]);
        if (p !== "auto") {
            if (platform === "auto" && onFlag === "auto") platform = p;
            topic = topic.slice(0, trailing.index).trim();
        }
    }
    if (onFlag !== "auto") platform = onFlag;
    return { platform, topic, title, show };
}

/** One-line-ish chat reply for a draftBlog result (bridges + CLI). */
export function formatBlogDraftResult(res) {
    if (!res || !res.success) return `⚠️ Blog draft error: ${(res && res.error) || "unknown error"}`;
    const plat = res.platform === "blogger" ? "Blogger" : "WordPress";
    let handoff = "";
    if (res.shown) handoff = "\n🖥 Opened in your default browser." + (res.controlledClosed ? " Controlled window closed." : "");
    else if (res.showError) handoff = `\n⚠️ Default-browser handoff failed: ${res.showError}`;
    let via = "";
    if (res.source === "api") via = `\n🔑 Draft created via official ${plat} API (no browser needed).`;
    else if (res.source === "browser" && res.fallbackReason) via = `\n🌐 via local browser fallback (API unavailable: ${res.fallbackReason}).`;
    else if (res.source === "browser") via = `\n🌐 via local browser editor (log in and save/publish there).`;
    const filled = res.source === "browser" && res.filled
        ? "\n✏️ Title/body pre-filled in the editor — review and save."
        : (res.source === "browser" ? "\n✏️ Editor opened — fill in and save the draft there." : "");
    const loginHint = res.source === "browser" && res.needsLogin
        ? "\n🔑 Login required: the editor needs a logged-in session — log in on the opened page, then save the draft."
        : "";
    return `📝 ${plat} draft: "${res.title || "Untitled draft"}"\n🔗 ${res.url}${handoff}${filled}${loginHint}${via}`;
}

function auditLog(action, detail = "") {
    try {
        fs.mkdirSync(path.dirname(BROWSER_LOG_FILE), { recursive: true });
        fs.appendFileSync(BROWSER_LOG_FILE, `${new Date().toISOString()} [browser] ${action} ${detail}\n`.slice(0, 2000));
    } catch {}
}

let playwrightCache = undefined;
async function loadPlaywright() {
    if (playwrightCache !== undefined) return playwrightCache;
    try {
        playwrightCache = await import("playwright");
    } catch {
        playwrightCache = null;
    }
    return playwrightCache;
}

export async function isBrowserAvailable() {
    return (await loadPlaywright()) !== null;
}

export function hasDisplay() {
    if (process.platform === "darwin" || process.platform === "win32") return true;
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Tri-state headless resolution. Explicit env wins, then explicit settings
 * boolean, otherwise "auto": visible window when a display exists, headless
 * on servers/Docker. Always returns a boolean.
 */
export function resolveHeadless(settings = {}) {
    const env = String(process.env.BROWSER_HEADLESS ?? "").trim().toLowerCase();
    if (["1", "true", "yes", "headless"].includes(env)) return true;
    if (["0", "false", "no", "headed", "visible"].includes(env)) return false;
    if (settings && settings.browser_headless === true) return true;
    if (settings && settings.browser_headless === false) return false;
    return !hasDisplay();
}

export const BROWSER_IDLE_CLOSE_DEFAULT_MS = 300000;

/**
 * Idle auto-close timeout. Env BROWSER_IDLE_CLOSE_MS wins (0 disables),
 * then settings.browser_idle_close_ms, else the 5-minute default.
 */
export function resolveIdleCloseMs(settings = {}) {
    const rawEnv = String(process.env.BROWSER_IDLE_CLOSE_MS ?? "").trim();
    if (rawEnv !== "") {
        const n = Number(rawEnv);
        if (!Number.isNaN(n)) return n <= 0 ? 0 : n;
    }
    const s = settings ? settings.browser_idle_close_ms : undefined;
    if (typeof s === "number" && !Number.isNaN(s)) return s <= 0 ? 0 : s;
    return BROWSER_IDLE_CLOSE_DEFAULT_MS;
}

function missingPlaywrightError() {
    return "Playwright is not installed. Run: bun add playwright && bunx playwright install chromium (then retry).";
}

export class BrowserController {
    constructor(settings = {}) {
        this.settings = { ...(settings || {}) };
        this.context = null;
        this.page = null;
        this.launching = null;
        this.lastUrl = "";
        this.lastTitle = "";
        this.idleTimer = null;
    }

    isHeadless() {
        return resolveHeadless(this.settings);
    }

    async ensureLaunched() {
        this.disarmIdle();
        if (this.page && !this.page.isClosed()) return this.page;
        if (this.launching) return this.launching;
        this.launching = (async () => {
            const pw = await loadPlaywright();
            if (!pw) throw new Error(missingPlaywrightError());
            fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
            const forcedHeaded =
                String(process.env.BROWSER_HEADLESS ?? "").trim().toLowerCase() === "0" ||
                String(process.env.BROWSER_HEADLESS ?? "").trim().toLowerCase() === "false" ||
                this.settings.browser_headless === false;
            // Google sign-in rejects automation-flagged browsers ("This browser
            // or app may not be secure"). Hide the automation fingerprint when
            // possible: drop --enable-automation and the AutomationControlled
            // blink feature. BROWSER_CHANNEL=chrome (or msedge, ...) drives a
            // real installed branded browser instead of the bundled build,
            // which Google trusts more; unset (default) keeps the bundled
            // Chromium so containers without a system browser keep working.
            const channel = String(
                process.env.BROWSER_CHANNEL || this.settings.browser_channel || ""
            ).trim() || undefined;
            const attempts = [];
            if (!this.isHeadless()) attempts.push(false);
            attempts.push(true); // headless always works as final fallback (unless headed was forced)
            let lastErr = null;
            for (const headless of attempts) {
                if (headless && forcedHeaded) break;
                try {
                    this.context = await pw.chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
                        headless,
                        ...(channel ? { channel } : {}),
                        ignoreDefaultArgs: ["--enable-automation"],
                        viewport: { width: 1280, height: 800 },
                        args: ["--autoplay-policy=no-user-gesture-required", "--disable-blink-features=AutomationControlled"],
                    });
                    lastErr = null;
                    if (!headless) auditLog("launch", `visible local browser window${channel ? ` (channel=${channel})` : ""}`);
                    break;
                } catch (err) {
                    lastErr = err;
                    if (!headless) auditLog("launch-fallback", `visible launch failed (${err.message}); retrying headless`);
                }
            }
            if (lastErr) {
                throw new Error(
                    `Could not launch Chromium (${lastErr.message}). ` +
                    `If the browser binary is missing, run: bunx playwright install chromium`
                );
            }
            const pages = this.context.pages();
            this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
            this.page.setDefaultTimeout(BROWSER_NAV_TIMEOUT_MS);
            return this.page;
        })();
        try {
            return await this.launching;
        } catch (err) {
            try { await this.context?.close(); } catch {}
            this.context = null;
            this.page = null;
            throw err;
        } finally {
            this.launching = null;
        }
    }

    guard(url) {
        if (!isAllowedUrl(url, this.settings)) {
            return `URL not allowed by browser allowlist [${resolveAllowedDomains(this.settings).join(", ")}]: ${url}`;
        }
        return null;
    }

    async open(url) {
        const blocked = this.guard(url);
        if (blocked) return { success: false, error: blocked };
        try {
            const page = await this.ensureLaunched();
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS });
            this.lastUrl = page.url();
            this.lastTitle = (await page.title().catch(() => "")) || "";
            auditLog("open", `${url} -> ${this.lastUrl}`);
            this.noteIdle();
            return { success: true, url: this.lastUrl, title: this.lastTitle };
        } catch (err) {
            this.noteIdle();
            return { success: false, error: err.message || String(err) };
        }
    }

    async dismissOverlays(page) {
        // Best-effort consent / sign-in dismissals (YouTube, Google, Spotify).
        for (const label of ["Reject all", "Remind me later", "Not now", "No thanks", "Close", "Accept cookies"]) {
            try {
                const btn = page.getByRole("button", { name: label });
                if ((await btn.count()) > 0) {
                    await btn.first().click({ timeout: 2000 });
                    break;
                }
            } catch {}
        }
    }

    /** Spotify's cookie wall (OneTrust) uses ids, not always clean ARIA names. */
    async dismissSpotifyOverlays(page) {
        await this.dismissOverlays(page);
        for (const sel of ["#onetrust-reject-all-handler", "#onetrust-accept-btn-handler"]) {
            try {
                const el = page.locator(sel).first();
                if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
                    await el.click({ timeout: 2000 }).catch(() => {});
                    break;
                }
            } catch {}
        }
    }

    /**
     * Click the first VISIBLE Spotify play button (entity header, then track
     * rows). `.first()` alone often hits a hidden duplicate (sticky header /
     * hover overlay), which silently no-ops — the cause of "page opened but
     * nothing plays". Returns true when a click was issued.
     */
    async clickSpotifyPlayButton(page) {
        const groups = [
            'button[data-testid="play-button"]',
            'button[aria-label^="Play "]',
        ];
        for (const sel of groups) {
            try {
                const loc = page.locator(sel);
                const n = await loc.count();
                for (let i = 0; i < Math.min(n, 10); i++) {
                    try {
                        const item = loc.nth(i);
                        if (!(await item.isVisible())) continue;
                        await item.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                        await item.click({ timeout: 5000 });
                        return true;
                    } catch {
                        continue;
                    }
                }
            } catch {}
        }
        try {
            return await page.evaluate(() => {
                const els = [...document.querySelectorAll('button[data-testid="play-button"], button[aria-label^="Play "]')].filter(
                    (b) => b.offsetParent !== null
                );
                if (els.length === 0) return false;
                try {
                    els[0].scrollIntoView({ block: "center" });
                } catch {}
                els[0].click();
                return true;
            });
        } catch {
            return false;
        }
    }

    /**
     * Read back whether Spotify is actually playing. The bottom-bar control
     * button is unreliable (aria says "Pause" even when idle), so we check
     * the entity header button flipping to "Pause …" and any live <audio> /
     * <video> element, plus whether a login/signup wall is shown.
     */
    async readSpotifyPlaying(page) {
        try {
            return await page.evaluate(() => {
                const entityPlaying = [...document.querySelectorAll('button[data-testid="play-button"]')].some((b) =>
                    /^pause/i.test(b.getAttribute("aria-label") || "")
                );
                const mediaPlaying = [...document.querySelectorAll("audio, video")].some((m) => !m.paused && !m.ended);
                const text = document.body ? document.body.innerText : "";
                const loginWall = /sign up to get unlimited|log in to continue|log in to (listen|enjoy)|start listening/i.test(text);
                return { entityPlaying: !!entityPlaying, mediaPlaying: !!mediaPlaying, loginWall: !!loginWall };
            });
        } catch {
            return { entityPlaying: false, mediaPlaying: false, loginWall: false };
        }
    }

    async searchYoutube(query) {
        const q = String(query || "").trim();
        if (!q) return { success: false, error: "Usage: provide a search query." };
        try {
            const page = await this.ensureLaunched();
            await page.goto(buildYoutubeSearchUrl(q), { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS });
            await this.dismissOverlays(page);
            await page.waitForSelector("ytd-video-renderer a#video-title", { timeout: 15000 });
            const results = await page.locator("ytd-video-renderer a#video-title").evaluateAll((links) =>
                links.slice(0, 5).map((a) => ({ title: (a.textContent || "").trim(), href: a.getAttribute("href") || "" }))
            );
            const items = results
                .map((r) => ({ title: r.title, url: extractYoutubeWatchUrl(r.href) }))
                .filter((r) => r.title && r.url);
            this.lastUrl = page.url();
            this.lastTitle = (await page.title().catch(() => "")) || "";
            auditLog("search-youtube", `"${q}" -> ${items.length} result(s)`);
            this.noteIdle();
            return { success: true, query: q, url: this.lastUrl, results: items };
        } catch (err) {
            this.noteIdle();
            return { success: false, error: err.message || String(err) };
        }
    }

    async playYoutube(queryOrUrl, opts = {}) {
        const input = String(queryOrUrl || "").trim();
        if (!input) return { success: false, error: "Usage: @youtube-play <search terms or YouTube URL>" };
        try {
            const page = await this.ensureLaunched();
            let target = extractYoutubeWatchUrl(input);
            let picked = null;

            if (!target) {
                const found = await this.searchYoutube(input);
                if (!found.success || !found.results || found.results.length === 0) {
                    return { success: false, error: found.error || `No YouTube results for "${input}".` };
                }
                picked = found.results[0];
                target = picked.url;
                this.disarmIdle();
            }

            const blocked = this.guard(target);
            if (blocked) return { success: false, error: blocked };

            if (picked) {
                // Agentic path: click the actual result card instead of navigating directly.
                await page.goto(buildYoutubeSearchUrl(input), { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS }).catch(() => {});
                await this.dismissOverlays(page);
                try {
                    await page.locator("ytd-video-renderer a#video-title").first().click({ timeout: 10000 });
                    await page.waitForURL("**/watch*", { timeout: 15000 });
                } catch {
                    await page.goto(target, { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS });
                }
            } else {
                await page.goto(target, { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS });
            }

            await this.dismissOverlays(page);
            await page.waitForSelector("video.html5-main-video", { timeout: 15000 });
            const state = await page.evaluate(() => {
                const v = document.querySelector("video.html5-main-video");
                if (!v) return { found: false };
                if (v.paused) {
                    try { v.muted = false; } catch {}
                    const p = v.play?.();
                    if (p && p.catch) p.catch(() => {});
                }
                return { found: true, paused: v.paused, currentTime: v.currentTime, duration: v.duration };
            }).catch((e) => ({ found: false, error: String(e && e.message || e) }));

            this.lastUrl = page.url();
            this.lastTitle = (await page.title().catch(() => "")) || "";
            const playing = state && state.found && state.paused === false;
            auditLog("play-youtube", `"${input}" -> ${this.lastUrl} playing=${playing}`);
            const out = { success: true, title: this.lastTitle, url: this.lastUrl, playing: !!playing };

            if (opts.show) {
                try {
                    const opened = new AgenticModule().openUrl(this.lastUrl);
                    out.shown = !!(opened && opened.success);
                    if (opened && opened.method) out.showMethod = opened.method;
                    if (!out.shown) out.showError = (opened && opened.error) || "host browser opener failed";
                    auditLog("play-youtube-show", `${this.lastUrl} opened=${out.shown}${out.showMethod ? ` via=${out.showMethod}` : ""}${out.showError ? ` err=${out.showError}` : ""}`);
                } catch (err) {
                    out.shown = false;
                    out.showError = err.message || String(err);
                }
                // Silence our own window so audio doesn't play twice.
                try {
                    await page.evaluate(() => {
                        const v = document.querySelector("video.html5-main-video");
                        if (v && !v.paused) v.pause();
                    });
                    out.controlledPaused = true;
                } catch {}
                // Handoff verified: close the controlled window so it doesn't
                // linger behind. Kept open when the handoff failed.
                await this.settleHandoff(out);
            }
            this.noteIdle();
            return out;
        } catch (err) {
            this.noteIdle();
            return { success: false, error: err.message || String(err) };
        }
    }

    async searchSpotify(query) {
        const q = String(query || "").trim();
        if (!q) return { success: false, error: "Usage: provide a search query." };
        try {
            const page = await this.ensureLaunched();
            await page.goto(buildSpotifySearchUrl(q), { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS });
            await this.dismissOverlays(page);
            const selector = 'a[href*="/track/"], a[href*="/episode/"], a[href*="/show/"], a[href*="/album/"], a[href*="/playlist/"]';
            const playableSel = 'a[href*="/track/"], a[href*="/episode/"]';
            const scrapeLinks = () =>
                page.locator(selector).evaluateAll((links) =>
                    links.slice(0, 25).map((a) => ({ title: ((a.getAttribute("aria-label") || a.textContent) || "").trim(), href: a.getAttribute("href") || "" }))
                ).catch(() => []);
            await page.waitForSelector(selector, { timeout: 25000 });
            // Track/episode sections render after albums/playlists for logged-out
            // sessions; wait for them before scraping so a specific song is found.
            await page.waitForSelector(playableSel, { timeout: 8000 }).catch(() => {});
            let results = await scrapeLinks();
            const hasPlayable = (list) => list.some((r) => /\/(track|episode)\//.test(r.href || ""));
            if (!hasPlayable(results)) {
                // Flaky render (often just 1 playlist): one reload + re-scrape,
                // merging both passes so nothing is lost.
                await page.reload({ waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS }).catch(() => {});
                await this.dismissSpotifyOverlays(page);
                await page.waitForSelector(playableSel, { timeout: 10000 }).catch(() => {});
                const retry = await scrapeLinks();
                results = [...retry, ...results];
            }
            const seen = new Set();
            const items = [];
            for (const r of results) {
                const url = extractSpotifyUrl(r.href);
                if (!r.title || !url || seen.has(url)) continue;
                seen.add(url);
                const kind = (url.match(/open\.spotify\.com\/(track|episode|show|album|playlist|artist)/) || [])[1] || "track";
                items.push({ title: r.title.replace(/\s+/g, " ").slice(0, 160), url, kind });
                if (items.length >= 8) break;
            }
            // Rank tracks/episodes first so a specific song wins over
            // same-name albums/playlists on the results page.
            const ranked = rankSpotifyResults(items);
            this.lastUrl = page.url();
            this.lastTitle = (await page.title().catch(() => "")) || "";
            auditLog("search-spotify", `"${q}" -> ${ranked.length} result(s) first=${ranked[0] ? `${ranked[0].kind}:${ranked[0].url}` : "none"}`);
            this.noteIdle();
            return { success: true, query: q, url: this.lastUrl, results: ranked.slice(0, 5) };
        } catch (err) {
            this.noteIdle();
            return { success: false, error: err.message || String(err) };
        }
    }

    async playSpotify(queryOrUrl, opts = {}) {
        const input = String(queryOrUrl || "").trim();
        if (!input) return { success: false, error: "Usage: @spotify-play <search terms or Spotify URL>" };
        try {
            const page = await this.ensureLaunched();
            let target = extractSpotifyUrl(input);
            let picked = null;

            if (!target) {
                const found = await this.searchSpotify(input);
                if (!found.success || !found.results || found.results.length === 0) {
                    return { success: false, error: found.error || `No Spotify results for "${input}".` };
                }
                picked = pickSpotifyResult(found.results);
                target = picked.url;
                this.disarmIdle();
            }

            const blocked = this.guard(target);
            if (blocked) return { success: false, error: blocked };

            if (picked) {
                // Agentic path: click the result card matching the picked URL
                // instead of navigating directly. Falls back to the first
                // visible card, then to direct navigation.
                await page.goto(buildSpotifySearchUrl(input), { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS }).catch(() => {});
                await this.dismissSpotifyOverlays(page);
                const cardSel = 'a[href*="/track/"], a[href*="/episode/"], a[href*="/show/"], a[href*="/album/"], a[href*="/playlist/"]';
                // Wait for LEAVING the search page: the old "**/open.spotify.com/**"
                // pattern already matched the search URL itself, so a click that
                // went nowhere still counted as "opened".
                const leftSearchPage = (u) => {
                    try {
                        const parsed = new URL(u);
                        return parsed.hostname.endsWith("spotify.com") && !parsed.pathname.startsWith("/search/");
                    } catch {
                        return false;
                    }
                };
                const clickCard = async (idx) => {
                    const card = page.locator(cardSel).nth(idx);
                    if (!(await card.isVisible().catch(() => false))) return false;
                    await card.click({ timeout: 8000 });
                    await page.waitForURL(leftSearchPage, { timeout: 15000 });
                    return true;
                };
                let opened = false;
                try {
                    const hrefs = await page.locator(cardSel).evaluateAll((links) =>
                        links.slice(0, 25).map((a) => a.getAttribute("href") || "")
                    ).catch(() => []);
                    let matchIdx = hrefs.findIndex((h) => extractSpotifyUrl(h) === target);
                    if (matchIdx >= 0) {
                        try {
                            opened = await clickCard(matchIdx);
                        } catch {
                            opened = false;
                        }
                    }
                    if (!opened) {
                        const n = await page.locator(cardSel).count().catch(() => 0);
                        for (let i = 0; i < Math.min(n, 5); i++) {
                            try {
                                opened = await clickCard(i);
                                if (opened) break;
                            } catch {
                                continue;
                            }
                        }
                    }
                } catch {}
                if (!opened) {
                    await page.goto(target, { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS });
                }
                // Arrival check: the search page re-renders between loads, so the
                // clicked card can differ from the picked result. If we did not
                // land on the picked entity, navigate to it directly instead of
                // playing/hand off the wrong item (e.g. a playlist).
                const targetId = (target.match(/\/(track|episode|show|album|playlist|artist)\/([A-Za-z0-9]+)/) || [])[2] || "";
                if (targetId && !page.url().includes(targetId)) {
                    await page.goto(target, { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS }).catch(() => {});
                    auditLog("play-spotify-redirect", `${page.url()} -> ${target}`);
                }
            } else {
                await page.goto(target, { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS });
            }

            await this.dismissSpotifyOverlays(page);
            // Spotify renders slowly: wait for the entity play button, then
            // click (retry once) and VERIFY playback instead of assuming it.
            // Note: full tracks need a Spotify login in this profile; logged
            // out, only 30s previews can start (if at all).
            await page.waitForSelector('button[data-testid="play-button"], button[aria-label^="Play "]', { timeout: 20000 }).catch(() => {});
            let state = { entityPlaying: false, mediaPlaying: false, loginWall: false };
            for (let attempt = 0; attempt < 2; attempt++) {
                await this.clickSpotifyPlayButton(page);
                await page.waitForTimeout(3000).catch(() => {});
                state = await this.readSpotifyPlaying(page);
                if (state.entityPlaying || state.mediaPlaying) break;
                await this.dismissSpotifyOverlays(page);
            }

            this.lastUrl = page.url();
            this.lastTitle = (await page.title().catch(() => "")) || picked?.title || "";
            const kind = (this.lastUrl.match(/open\.spotify\.com\/(track|episode|show|album|playlist|artist)/) || [])[1] || picked?.kind || "track";
            const playing = !!(state.entityPlaying || state.mediaPlaying);
            const needsLogin = !playing && !!state.loginWall;
            auditLog("play-spotify", `"${input}" -> ${this.lastUrl} playing=${playing}${needsLogin ? " needsLogin" : ""}`);
            const out = { success: true, title: this.lastTitle, url: this.lastUrl, kind, playing, needsLogin };

            if (opts.show) {
                try {
                    const opened = new AgenticModule().openUrl(this.lastUrl);
                    out.shown = !!(opened && opened.success);
                    if (opened && opened.method) out.showMethod = opened.method;
                    if (!out.shown) out.showError = (opened && opened.error) || "host browser opener failed";
                    auditLog("play-spotify-show", `${this.lastUrl} opened=${out.shown}${out.showMethod ? ` via=${out.showMethod}` : ""}${out.showError ? ` err=${out.showError}` : ""}`);
                } catch (err) {
                    out.shown = false;
                    out.showError = err.message || String(err);
                }
                // Silence our own window so audio doesn't play twice (only when
                // we actually started playback and handed off).
                if (playing) {
                    try {
                        await page.evaluate(() => {
                            document.querySelectorAll("audio, video").forEach((m) => { try { m.pause(); } catch {} });
                            const pauseBtn = [...document.querySelectorAll('button[data-testid="play-button"]')].find((b) =>
                                /^pause/i.test(b.getAttribute("aria-label") || "")
                            );
                            if (pauseBtn) pauseBtn.click();
                        });
                        out.controlledPaused = true;
                    } catch {}
                }
                // Handoff verified: close the controlled window so it doesn't
                // linger behind (paused, seconds in). Kept open when the
                // handoff failed so the user can press play there.
                await this.settleHandoff(out);
            }
            this.noteIdle();
            return out;
        } catch (err) {
            this.noteIdle();
            return { success: false, error: err.message || String(err) };
        }
    }

    /**
     * Blog-draft editor URLs. A configured self-hosted WordPress site opens
     * its own wp-admin editor; otherwise the hosted WordPress.com / Blogger
     * composers are used (login required, kept in data/browser-profile/).
     */
    blogEditorUrl(platform, settings = {}) {
        const cfg = { ...(this.settings || {}), ...(settings || {}) };
        if (platform === "blogger") {
            const blogId = String(cfg.blogger_blog_id || process.env.BLOGGER_BLOG_ID || "").trim();
            // Blogger's draft host (Blogger in Draft) — the blog's posts page,
            // where "New post" starts a draft.
            if (blogId) return `https://draft.blogger.com/blog/posts/${encodeURIComponent(blogId)}`;
            return "https://draft.blogger.com/home";
        }
        const site = String(
            cfg.wordpress_site_url || cfg.wordpress_url ||
            process.env.WORDPRESS_SITE_URL || process.env.WORDPRESS_URL || ""
        ).trim().replace(/\/+$/, "");
        if (site) return `${site}/wp-admin/post-new.php`;
        return "https://wordpress.com/post";
    }

    /** Allowlist guard that also permits the configured self-hosted WP host. */
    guardBlog(url, settings = {}) {
        const cfg = { ...(this.settings || {}), ...(settings || {}) };
        try {
            const site = String(
                cfg.wordpress_site_url || cfg.wordpress_url ||
                process.env.WORDPRESS_SITE_URL || process.env.WORDPRESS_URL || ""
            ).trim();
            if (site) {
                const host = new URL(String(url)).hostname.toLowerCase();
                const siteHost = new URL(site).hostname.toLowerCase();
                if (host === siteHost) return null;
            }
        } catch {}
        return this.guard(url);
    }

    blogDraftTitleBody(topic, opts = {}) {
        const cleanTopic = String(topic || "").trim().replace(/\s+/g, " ");
        const title = String(opts.title || "").trim() ||
            cleanTopic.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ").slice(0, 120) ||
            "Untitled draft";
        const body = (opts.content && String(opts.content).trim())
            ? String(opts.content)
            : `${title}\n\n${cleanTopic}: introduction — why this topic matters and what this post will cover.\n\nKey points: background, main ideas, and examples about ${cleanTopic}.\n\nTakeaway: conclusions and next steps. (Starter draft — edit freely before publishing.)`;
        return { title, body };
    }

    /**
     * Detect whether the current page actually shows a post editor (vs a
     * login/signup wall). Logged-out wordpress.com / blogger.com redirect
     * to marketing or log-in pages whose generic inputs (e.g. the e-mail
     * field) would otherwise match the fill selectors and produce a false
     * `filled: true`. Never throws.
     */
    async detectBlogEditorState(page, platform) {
        try {
            return await page.evaluate((platform) => {
                const editorSels = platform === "blogger"
                    ? ['[aria-label="Post title"]', ".post-title", "#postingHtmlBox", ".post-editor", '[aria-label="Post body"]', "#postingTitleBox"]
                    : ['[aria-label="Add title"]', ".editor-post-title__input", ".block-editor", "#wpbody", "#post-body", "#postdivrich"];
                const hasEditor = editorSels.some((sel) => {
                    try {
                        return document.querySelectorAll(sel).length > 0;
                    } catch {
                        return false;
                    }
                });
                const text = document.body ? document.body.innerText : "";
                const loginWall = /log in to|sign in|create an account|sign up|need an account/i.test(text);
                return { hasEditor: !!hasEditor, loginWall: !!loginWall };
            }, platform);
        } catch {
            return { hasEditor: false, loginWall: false };
        }
    }

    /**
     * Best-effort fill of the WP (Gutenberg/wp-admin) or Blogger editor.
     * Editors are JS-heavy and vary by login state, so this never fails
     * the draft: it returns { filled } and the editor URL stays usable.
     * Callers must check detectBlogEditorState() first so login-form
     * inputs are never mistaken for the editor.
     */
    async fillBlogEditor(page, platform, title, body) {
        try {
            await page.waitForTimeout(2500).catch(() => {});
            const filled = await page.evaluate(({ platform, title, body }) => {
                const tryFill = (el, value) => {
                    try {
                        el.focus();
                        if (el.isContentEditable) {
                            el.textContent = value;
                        } else {
                            el.value = value;
                        }
                        el.dispatchEvent(new Event("input", { bubbles: true }));
                        el.dispatchEvent(new Event("change", { bubbles: true }));
                        return true;
                    } catch {
                        return false;
                    }
                };
                let titleDone = false;
                let bodyDone = false;
                const titleSels = platform === "blogger"
                    ? ['input[type="text"]', '[aria-label="Post title"]', ".post-title input", 'input[placeholder*="Title" i]']
                    : ['[aria-label="Add title"]', "textarea.editor-post-title__input", "#title", "#post-title-0", 'textarea[placeholder*="title" i]'];
                const bodySels = platform === "blogger"
                    ? ['[aria-label="Post body"]', ".editable", 'div[role="textbox"]', ".kix-page"]
                    : ['.block-editor-rich-text__editable p', '[aria-label^="Start writing"]', "#content", "#post-content-0", 'div[role="textbox"]'];
                const visible = (el) => !!(el && el.offsetParent !== null);
                for (const sel of titleSels) {
                    try {
                        const els = [...document.querySelectorAll(sel)].filter(visible);
                        if (els.length > 0 && (els[0].value || els[0].textContent || "").trim().length === 0) {
                            if (tryFill(els[0], title)) {
                                titleDone = true;
                                break;
                            }
                        } else if (els.length > 0) {
                            titleDone = true;
                            break;
                        }
                    } catch {}
                }
                for (const sel of bodySels) {
                    try {
                        const els = [...document.querySelectorAll(sel)].filter(visible);
                        if (els.length > 0 && (els[0].value || els[0].textContent || "").trim().length === 0) {
                            if (tryFill(els[0], body)) {
                                bodyDone = true;
                                break;
                            }
                        } else if (els.length > 0) {
                            bodyDone = true;
                            break;
                        }
                    } catch {}
                }
                return { titleDone, bodyDone };
            }, { platform, title, body });
            return { filled: !!(filled && (filled.titleDone || filled.bodyDone)), detail: filled };
        } catch {
            return { filled: false };
        }
    }

    async draftBlog(topic, opts = {}) {
        const platform = normalizeBlogPlatform(opts.platform) === "blogger" ? "blogger" : "wordpress";
        return platform === "blogger"
            ? this.draftBlogBlogger(topic, opts)
            : this.draftBlogWordpress(topic, opts);
    }

    async draftBlogWordpress(topic, opts = {}) {
        const input = String(topic || "").trim();
        if (!input && !(opts.content && String(opts.content).trim())) {
            return { success: false, platform: "wordpress", error: "Usage: @blog <topic> [--on wordpress|blogger] [--title <title>]" };
        }
        const { title, body } = this.blogDraftTitleBody(input, opts);
        const target = this.blogEditorUrl("wordpress", opts.settings || this.settings);
        const blocked = this.guardBlog(target, opts.settings || this.settings);
        if (blocked) return { success: false, platform: "wordpress", error: blocked };
        try {
            const page = await this.ensureLaunched();
            await page.goto(target, { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS });
            await this.dismissOverlays(page);
            const editor = await this.detectBlogEditorState(page, "wordpress");
            const { filled } = editor.hasEditor
                ? await this.fillBlogEditor(page, "wordpress", title, body)
                : { filled: false };
            const needsLogin = !editor.hasEditor && editor.loginWall;
            this.lastUrl = page.url();
            this.lastTitle = (await page.title().catch(() => "")) || title;
            auditLog("draft-blog-wordpress", `"${input}" -> ${this.lastUrl} filled=${filled}${needsLogin ? " needsLogin" : ""}`);
            const out = { success: true, platform: "wordpress", title, topic: input, url: this.lastUrl, filled, needsLogin, source: "browser" };
            if (opts.show !== false) {
                try {
                    const opened = new AgenticModule().openUrl(this.lastUrl);
                    out.shown = !!(opened && opened.success);
                    if (opened && opened.method) out.showMethod = opened.method;
                    if (!out.shown) out.showError = (opened && opened.error) || "host browser opener failed";
                    auditLog("draft-blog-wordpress-show", `${this.lastUrl} opened=${out.shown}${out.showMethod ? ` via=${out.showMethod}` : ""}${out.showError ? ` err=${out.showError}` : ""}`);
                } catch (err) {
                    out.shown = false;
                    out.showError = err.message || String(err);
                }
                await this.settleHandoff(out);
            }
            this.noteIdle();
            return out;
        } catch (err) {
            this.noteIdle();
            return { success: false, platform: "wordpress", error: err.message || String(err) };
        }
    }

    async draftBlogBlogger(topic, opts = {}) {
        const input = String(topic || "").trim();
        if (!input && !(opts.content && String(opts.content).trim())) {
            return { success: false, platform: "blogger", error: "Usage: @blog <topic> [--on wordpress|blogger] [--title <title>]" };
        }
        const { title, body } = this.blogDraftTitleBody(input, opts);
        const target = this.blogEditorUrl("blogger", opts.settings || this.settings);
        const blocked = this.guardBlog(target, opts.settings || this.settings);
        if (blocked) return { success: false, platform: "blogger", error: blocked };
        try {
            const page = await this.ensureLaunched();
            await page.goto(target, { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS });
            await this.dismissOverlays(page);
            const editor = await this.detectBlogEditorState(page, "blogger");
            const { filled } = editor.hasEditor
                ? await this.fillBlogEditor(page, "blogger", title, body)
                : { filled: false };
            const needsLogin = !editor.hasEditor && editor.loginWall;
            this.lastUrl = page.url();
            this.lastTitle = (await page.title().catch(() => "")) || title;
            auditLog("draft-blog-blogger", `"${input}" -> ${this.lastUrl} filled=${filled}${needsLogin ? " needsLogin" : ""}`);
            const out = { success: true, platform: "blogger", title, topic: input, url: this.lastUrl, filled, needsLogin, source: "browser" };
            if (opts.show !== false) {
                try {
                    const opened = new AgenticModule().openUrl(this.lastUrl);
                    out.shown = !!(opened && opened.success);
                    if (opened && opened.method) out.showMethod = opened.method;
                    if (!out.shown) out.showError = (opened && opened.error) || "host browser opener failed";
                    auditLog("draft-blog-blogger-show", `${this.lastUrl} opened=${out.shown}${out.showMethod ? ` via=${out.showMethod}` : ""}${out.showError ? ` err=${out.showError}` : ""}`);
                } catch (err) {
                    out.shown = false;
                    out.showError = err.message || String(err);
                }
                await this.settleHandoff(out);
            }
            this.noteIdle();
            return out;
        } catch (err) {
            this.noteIdle();
            return { success: false, platform: "blogger", error: err.message || String(err) };
        }
    }

    async read() {
        try {
            const page = await this.ensureLaunched();
            const text = await page.evaluate(() => (document.body ? document.body.innerText : "").slice(0, 8000));
            this.lastUrl = page.url();
            this.lastTitle = (await page.title().catch(() => "")) || "";
            this.noteIdle();
            return { success: true, url: this.lastUrl, title: this.lastTitle, text: (text || "").trim() };
        } catch (err) {
            this.noteIdle();
            return { success: false, error: err.message || String(err) };
        }
    }

    async screenshot(name = "") {
        try {
            const page = await this.ensureLaunched();
            const safe = String(name || `browser_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
            const outPath = path.join(process.cwd(), "tmp", `${safe}.png`);
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            await page.screenshot({ path: outPath });
            auditLog("screenshot", outPath);
            this.noteIdle();
            return { success: true, path: outPath, url: page.url() };
        } catch (err) {
            this.noteIdle();
            return { success: false, error: err.message || String(err) };
        }
    }

    status() {
        return {
            launched: !!(this.page && !this.page.isClosed()),
            headless: this.isHeadless(),
            url: this.lastUrl,
            title: this.lastTitle,
            allowed: resolveAllowedDomains(this.settings),
            idleCloseMs: resolveIdleCloseMs(this.settings),
        };
    }

    async close() {
        this.disarmIdle();
        try { await this.context?.close(); } catch {}
        this.context = null;
        this.page = null;
        this.lastUrl = "";
        this.lastTitle = "";
        auditLog("close", "browser context closed");
        return { success: true };
    }

    /**
     * Stop a pending idle-close (a new action started or the browser closed).
     */
    disarmIdle() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    /**
     * Arm idle auto-close: the controlled window closes itself after
     * resolveIdleCloseMs() with no new action. Armed only when an action
     * settles — disarmIdle() runs in ensureLaunched()/close() — so it can
     * never fire mid-action. 0/disabled, or no open browser, is a no-op
     * (closeIdle re-checks before doing anything).
     */
    noteIdle() {
        this.disarmIdle();
        const ms = resolveIdleCloseMs(this.settings);
        if (!ms || ms <= 0) return;
        const t = setTimeout(() => {
            this.idleTimer = null;
            this.closeIdle().catch(() => {});
        }, ms);
        if (typeof t.unref === "function") t.unref();
        this.idleTimer = t;
    }

    async closeIdle() {
        if (!this.context && !this.page) return { success: true, idle: true };
        auditLog("close-idle", "no browser action for idle timeout");
        return this.close();
    }

    /**
     * Auto-close the controlled window after a successful host handoff so it
     * doesn't linger (paused, seconds in) after playback moved to the default
     * browser. Only closes when the handoff verified (`shown`); on handoff
     * failure the window stays open so the user can press play there.
     * Never fails the play result: close errors are recorded, not thrown.
     */
    async settleHandoff(out) {
        if (!out || !out.shown) return out;
        try {
            await this.close();
            out.controlledClosed = true;
        } catch (err) {
            out.closeError = err.message || String(err);
        }
        return out;
    }

    /**
     * Verified host-browser handoff. Delegates to AgenticModule.openUrl so a
     * failed opener is reported instead of silently leaving the URL visible
     * only in the controlled Chromium window.
     * Returns { success, url, method? } or { success:false, error }.
     */
    openInHostBrowser(url) {
        try {
            return new AgenticModule().openUrl(url);
        } catch (err) {
            return { success: false, url, error: err.message || String(err) };
        }
    }
}

let shared = null;

/** Shared controller so CLI, bridges and agent tools reuse one browser. */
export function getBrowserController(settings = {}) {
    if (!shared) shared = new BrowserController(settings);
    else shared.settings = { ...(shared.settings || {}), ...(settings || {}) };
    return shared;
}

export async function closeBrowserController() {
    if (shared) {
        const res = await shared.close().catch((e) => ({ success: false, error: e.message }));
        shared = null;
        return res;
    }
    return { success: true };
}

// Thin wrappers used by @ commands and the Ollama CLI tool registry.
export async function browserOpen(url, settings = {}) {
    return getBrowserController(settings).open(url);
}
export async function browserSearchYoutube(query, settings = {}) {
    return getBrowserController(settings).searchYoutube(query);
}
export async function browserPlayYoutube(queryOrUrl, settings = {}, opts = {}) {
    return getBrowserController(settings).playYoutube(queryOrUrl, opts);
}
export async function browserSearchSpotify(query, settings = {}) {
    return getBrowserController(settings).searchSpotify(query);
}
export async function browserPlaySpotify(queryOrUrl, settings = {}, opts = {}) {
    return getBrowserController(settings).playSpotify(queryOrUrl, opts);
}
export async function browserDraftBlog(topic, settings = {}, opts = {}) {
    return getBrowserController(settings).draftBlog(topic, { ...opts, settings });
}
export async function browserDraftWordpress(topic, settings = {}, opts = {}) {
    return getBrowserController(settings).draftBlogWordpress(topic, { ...opts, settings });
}
export async function browserDraftBlogger(topic, settings = {}, opts = {}) {
    return getBrowserController(settings).draftBlogBlogger(topic, { ...opts, settings });
}
export async function browserRead(settings = {}) {
    return getBrowserController(settings).read();
}
export async function browserScreenshot(name = "", settings = {}) {
    return getBrowserController(settings).screenshot(name);
}
export async function browserStatus(settings = {}) {
    return { success: true, ...(getBrowserController(settings).status()) };
}
export async function browserClose() {
    return closeBrowserController();
}

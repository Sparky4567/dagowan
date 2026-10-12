// ---------------------------------------------------------------------------
// Official-API-first blog drafting (WordPress REST API + Blogger API v3).
//
// Default path for @blog/@wordpress/@blogger/@post (and the natural
// "@Parsly, write a blog post about ... on @wordpress / @blogger" callout):
//   1. API draft  -> WordPress REST API (Application Passwords) or Blogger
//      API v3 (OAuth2 access token) creates a real draft post, then hands
//      the editor URL to the host browser. No Chromium needed.
//   2. Fallback   -> the Playwright/Chromium automation in browser.js
//      (opens the WP / Blogger editor in the shared visible window, fills
//      title + body best-effort, hands off to the default browser).
//      Same pattern as @play/@spotify in play_api.js.
//
// Env / settings (settings win after env — same convention as providers.js):
//   WORDPRESS_SITE_URL / settings.wordpress_site_url   (e.g. https://mysite.com)
//   WORDPRESS_USERNAME / settings.wordpress_username
//   WORDPRESS_APP_PASSWORD / settings.wordpress_app_password
//     (generate in WP Admin → Users → Profile → Application Passwords)
//   BLOGGER_BLOG_ID / settings.blogger_blog_id
//   BLOGGER_ACCESS_TOKEN / settings.blogger_access_token
//     (OAuth2 access token with Blogger scope; refresh server-side — the
//     Blogger Data API has no client-credentials flow for writes, so a
//     plain API key alone cannot create drafts)
//   BLOGGER_API_KEY / settings.blogger_api_key (optional, read-only calls)
//   BLOG_SOURCE=auto|api|browser (or settings.blog_source, default "auto")
//     auto    = API first, Chromium fallback (default)
//     api     = API only, never launch Chromium
//     browser = Chromium only (previous behavior, skips the API)
// ---------------------------------------------------------------------------

import { AgenticModule } from "./agentic.js";
import {
    browserDraftBlog,
    normalizeBlogPlatform,
} from "./browser.js";
import { getValidBloggerToken } from "./blogger_auth.js";
import { unifiedChat } from "./providers.js";

export const WORDPRESS_POSTS_PATH = "/wp-json/wp/v2/posts";
export const BLOGGER_POSTS_URL = (blogId) =>
    `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts?isDraft=true`;

export function getWordpressSiteUrl(settings = {}) {
    const raw = (
        (settings && (settings.wordpress_site_url || settings.wordpress_url)) ||
        process.env.WORDPRESS_SITE_URL ||
        process.env.WORDPRESS_URL ||
        ""
    );
    return String(raw || "").trim().replace(/\/+$/, "");
}

export function getWordpressUsername(settings = {}) {
    return (
        (settings && settings.wordpress_username) ||
        process.env.WORDPRESS_USERNAME ||
        ""
    );
}

export function getWordpressAppPassword(settings = {}) {
    return (
        (settings && settings.wordpress_app_password) ||
        process.env.WORDPRESS_APP_PASSWORD ||
        process.env.WORDPRESS_PASSWORD ||
        ""
    );
}

export function isWordpressApiConfigured(settings = {}) {
    return Boolean(
        getWordpressSiteUrl(settings) &&
        getWordpressUsername(settings) &&
        getWordpressAppPassword(settings)
    );
}

export function getBloggerBlogId(settings = {}) {
    return (
        (settings && settings.blogger_blog_id) ||
        process.env.BLOGGER_BLOG_ID ||
        ""
    );
}

export function getBloggerAccessToken(settings = {}) {
    return (
        (settings && settings.blogger_access_token) ||
        process.env.BLOGGER_ACCESS_TOKEN ||
        process.env.BLOGGER_OAUTH_TOKEN ||
        ""
    );
}

export function getBloggerApiKey(settings = {}) {
    return (
        (settings && settings.blogger_api_key) ||
        process.env.BLOGGER_API_KEY ||
        ""
    );
}

export function isBloggerApiConfigured(settings = {}) {
    // Writes require an OAuth2 bearer token (or a refresh-token set that
    // can mint one via @blogger-auth); an API key alone is read-only.
    return Boolean(getBloggerBlogId(settings) && (getBloggerAccessToken(settings) || bloggerCanRefresh(settings)));
}

/** True when a stored refresh-token set can mint fresh access tokens. */
export function bloggerCanRefresh(settings = {}) {
    const has = (v) => Boolean(String(v || "").trim());
    return Boolean(
        (has(settings?.blogger_refresh_token) || has(process.env.BLOGGER_REFRESH_TOKEN)) &&
        (has(settings?.blogger_client_id) || has(process.env.BLOGGER_CLIENT_ID)) &&
        (has(settings?.blogger_client_secret) || has(process.env.BLOGGER_CLIENT_SECRET))
    );
}

/**
 * Which engine to use. Env BLOG_SOURCE wins, then settings.blog_source,
 * otherwise "auto" (API first, Chromium fallback). Mirrors resolvePlaySource.
 */
export function resolveBlogSource(settings = {}) {
    const raw = String(process.env.BLOG_SOURCE ?? settings?.blog_source ?? "auto")
        .trim()
        .toLowerCase();
    if (raw === "api" || raw === "apionly" || raw === "api-only") return "api";
    if (raw === "browser" || raw === "chromium" || raw === "headless") return "browser";
    return "auto";
}

export function getBlogStatus(settings = {}) {
    return {
        source: resolveBlogSource(settings),
        wordpressApi: isWordpressApiConfigured(settings),
        bloggerApi: isBloggerApiConfigured(settings),
    };
}

function httpError(status, bodyText) {
    const detail = String(bodyText || "").slice(0, 300);
    return new Error(`HTTP ${status}${detail ? `: ${detail}` : ""}`);
}

async function fetchJson(url, options, fetchFn) {
    const res = await (fetchFn || fetch)(url, options);
    if (!res.ok) {
        let body = "";
        try {
            body = await res.text();
        } catch {}
        throw httpError(res.status, body);
    }
    return res.json();
}

function handoff(url, show) {
    if (!show) return { shown: false };
    try {
        const opened = new AgenticModule().openUrl(url);
        const out = { shown: !!(opened && opened.success) };
        if (opened && opened.method) out.showMethod = opened.method;
        if (!out.shown) out.showError = (opened && opened.error) || "host browser opener failed";
        return out;
    } catch (err) {
        return { shown: false, showError: err.message || String(err) };
    }
}

function titleCase(s) {
    return String(s || "")
        .trim()
        .replace(/\s+/g, " ")
        .split(" ")
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(" ");
}

function escapeHtml(s) {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * Write a complete, publishable blog post with the configured LLM,
 * in the voice of the requesting character persona.
 * Returns { title, content } (HTML). Throws on LLM failure so callers
 * can fall back to the starter template — drafting must never break
 * just because the model is unreachable.
 *
 * Voice resolution (first non-empty wins):
 *   opts.characterPersona -> opts.settings.character_persona /
 *   settings.system_template -> settings.character_persona.
 * Pass the active (or @mentioned) character's composeSystemTemplate()
 * output as characterPersona and its name as characterName.
 */
export function resolveCharacterVoice(opts = {}, settings = {}) {
    const persona =
        String((opts && (opts.characterPersona || opts.character_persona)) || "").trim() ||
        String((opts && opts.settings && (opts.settings.character_persona || opts.settings.system_template)) || "").trim() ||
        String((settings && (settings.character_persona || settings.system_template)) || "").trim() ||
        "";
    const name =
        String((opts && (opts.characterName || opts.character_name)) || "").trim() ||
        String((opts && opts.settings && (opts.settings.character_name || opts.settings.active_character)) || "").trim() ||
        String((settings && (settings.character_name || settings.active_character)) || "").trim() ||
        "";
    return { persona, name };
}

export async function generateBlogPost(topic, { settings = {}, ollamaClient = null, characterPersona = "", characterName = "", character_persona = "", character_name = "" } = {}) {
    const cleanTopic = String(topic || "").trim().replace(/\s+/g, " ");
    if (!cleanTopic) throw new Error("No topic.");
    const voice = resolveCharacterVoice(
        { characterPersona: characterPersona || character_persona, characterName: characterName || character_name },
        settings
    );
    const modelName = (settings && settings.model) || "smollm2:135m";
    const baseRules = "You write complete, publishable blog posts and return ONLY the post as simple HTML using <h2>, <h3>, <p>, <ul>, <li> tags. No markdown, no code fences, no preamble.";
    const systemContent = voice.persona
        ? `${voice.persona}\n\n---\nTask: ${baseRules} Write in your own voice as ${voice.name || "the requesting character"} — same persona, vocabulary, humor and attitude as your system persona above. Stay in character for the whole post (first person as that character where natural).`
        : baseRules;
    const userContent =
        `Write an engaging blog post about "${cleanTopic}" for a general audience (350-550 words, warm human tone, a few <h3> subheadings, practical takeaway at the end). ` +
        (voice.persona
            ? `Write it as ${voice.name || "the character described in the system prompt"} would write it — fully in that character's voice. `
            : "") +
        `The very first line must be the post title in the form "Title: <title>" on its own line, then the post body HTML.`;
    const res = await unifiedChat({
        modelName,
        settings,
        ollamaClient,
        stream: false,
        messages: [
            {
                role: "system",
                content: systemContent,
            },
            {
                role: "user",
                content: userContent,
            },
        ],
    });
    const raw = String((res && res.content) || "").trim();
    if (!raw) throw new Error("Empty LLM response.");
    let title = "";
    let content = raw;
    const m = raw.match(/^\s*Title\s*:\s*(.+?)\s*$/m);
    if (m) {
        title = m[1].trim().slice(0, 150);
        content = raw.slice(0, m.index).trim() + "\n" + raw.slice(m.index + m[0].length).trim();
        content = content.trim();
    }
    content = content.replace(/```html?|```/g, "").trim().slice(0, 12000);
    if (!content) throw new Error("Empty post body.");
    return { title: title || titleCase(cleanTopic).slice(0, 120), content };
}

/**
 * Resolve final draft { title, content }: explicit opts.content wins,
 * then LLM generation via opts.generateContent (or the built-in
 * generateBlogPost when opts.settings look usable), else the starter
 * template. Never throws — template is the guaranteed fallback.
 * Character voice (opts.characterPersona / opts.characterName) is
 * forwarded to the LLM so the post reads as if that character wrote it.
 */
export async function resolveDraftContent(topic, opts = {}) {
    const cleanTopic = String(topic || "").trim();
    const explicitTitle = String((opts && opts.title) || "").trim();
    if (opts && opts.content && String(opts.content).trim()) {
        return { title: explicitTitle || titleCase(cleanTopic).slice(0, 120) || "Untitled draft", content: String(opts.content) };
    }
    const voice = resolveCharacterVoice(opts, opts.settings || {});
    const voiceOpts = voice.persona || voice.name
        ? { characterPersona: voice.persona, characterName: voice.name }
        : {};
    const gen = (opts && opts.generateContent) || null;
    if (typeof gen === "function") {
        try {
            const out = await gen(clearTopic(cleanTopic), explicitTitle);
            const norm = normalizeGenerated(out);
            if (norm) return { title: explicitTitle || norm.title, content: norm.content };
        } catch {}
    } else if (opts && opts.settings && (opts.settings.model || opts.settings.server_url || voice.persona)) {
        // Caller passed LLM settings (or just a character voice) but no
        // custom generator: use built-in.
        try {
            const out = await generateBlogPost(cleanTopic, { settings: opts.settings, ollamaClient: opts.ollamaClient || null, ...voiceOpts });
            if (out) return { title: explicitTitle || out.title, content: out.content };
        } catch {}
    }
    return buildDraftContent(cleanTopic, { title: explicitTitle, characterName: voice.name });
}

function clearTopic(s) {
    return String(s || "").trim().replace(/\s+/g, " ");
}

function normalizeGenerated(out) {
    if (!out) return null;
    if (typeof out === "string") {
        const content = out.trim().slice(0, 12000);
        if (!content) return null;
        return { title: "", content };
    }
    const content = String(out.content || "").replace(/```html?|```/g, "").trim().slice(0, 12000);
    if (!content) return null;
    return { title: String(out.title || "").trim().slice(0, 150), content };
}
export function buildDraftContent(topic, opts = {}) {
    const cleanTopic = String(topic || "").trim().replace(/\s+/g, " ");
    const title = String(opts.title || "").trim() || titleCase(cleanTopic).slice(0, 120) || "Untitled draft";
    if (opts.content && String(opts.content).trim()) {
        return { title, content: String(opts.content) };
    }
    const voiceName = String(opts.characterName || opts.character_name || "").trim();
    const safeTopic = escapeHtml(cleanTopic || title);
    const byline = voiceName ? `<p><em>By ${escapeHtml(voiceName)}</em></p>` : "";
    const content =
        `<h2>${escapeHtml(title)}</h2>` +
        byline +
        `<p>${safeTopic}: introduction — why this topic matters and what this post will cover.</p>` +
        `<h3>Key points</h3>` +
        `<p>Expand here: background, main ideas, and examples about ${safeTopic}.</p>` +
        `<h3>Takeaway</h3>` +
        `<p>Wrap up with conclusions and next steps. (Starter draft — edit freely before publishing.)</p>`;
    return { title, content };
}

// --- WordPress: REST API (Application Passwords) + XML-RPC fallback --------
// REST: Basic USER:APP_PASSWORD to HOST/wp-json/wp/v2/posts.
// Works on self-hosted WordPress.org. WordPress.com hosted sites do NOT
// expose /wp-json at the site domain (404) — they use public-api + OAuth.
// For those, fall back to XML-RPC wp.newPost at site/xmlrpc.php, which
// accepts the same username/password on wordpress.com.

function escapeXml(s) {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function buildXmlRpcNewPost({ username, password, title, content }) {
    return (
        `<?xml version="1.0"?><methodCall><methodName>wp.newPost</methodName><params>` +
        `<param><value><int>1</int></value></param>` +
        `<param><value><string>${escapeXml(username)}</string></value></param>` +
        `<param><value><string>${escapeXml(password)}</string></value></param>` +
        `<param><value><struct>` +
        `<member><name>post_title</name><value><string>${escapeXml(title)}</string></value></member>` +
        `<member><name>post_content</name><value><string>${escapeXml(content)}</string></value></member>` +
        `<member><name>post_status</name><value><string>draft</string></value></member>` +
        `</struct></value></param></params></methodCall>`
    );
}

function parseXmlRpcNewPost(text) {
    const raw = String(text || "");
    const fault = raw.match(/<name>faultString<\/name>\s*<value><string>([\s\S]*?)<\/string>/i);
    if (/<fault>/i.test(raw)) {
        throw new Error(fault ? fault[1].slice(0, 300) : "XML-RPC fault");
    }
    const m = raw.match(/<methodResponse>[\s\S]*?<string>([^<]+)<\/string>/i)
        || raw.match(/<value><string>([^<]+)<\/string>/i);
    if (m) return m[1].trim();
    const i = raw.match(/<value><int>(\d+)<\/int>/i);
    if (i) return i[1];
    throw new Error(`Unexpected XML-RPC response: ${raw.slice(0, 200)}`);
}

async function postWordpressXmlRpc(site, user, pass, title, content, fetchFn) {
    const res = await (fetchFn || fetch)(`${site}/xmlrpc.php`, {
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        body: buildXmlRpcNewPost({ username: user, password: pass, title, content }),
    });
    const text = await res.text();
    if (!res.ok) throw httpError(res.status, text);
    return parseXmlRpcNewPost(text);
}

export async function postWordpressDraft(topic, settings = {}, opts = {}, fetchFn = fetch) {
    const cleanTopic = String(topic || "").trim();
    if (!cleanTopic && !(opts && opts.content)) {
        return { success: false, error: "Usage: provide a topic for the draft post." };
    }
    const site = getWordpressSiteUrl(settings);
    const user = getWordpressUsername(settings);
    const appPass = getWordpressAppPassword(settings);
    if (!site || !user || !appPass) {
        return { success: false, error: "WordPress API not configured. Set WORDPRESS_SITE_URL/USERNAME/APP_PASSWORD or @set-api-key wordpress <site_url> <username> <app_password>." };
    }
    const { title, content } = await resolveDraftContent(cleanTopic, opts);
    const url = `${site}${WORDPRESS_POSTS_PATH}`;
    const basic = Buffer.from(`${user}:${appPass}`).toString("base64");
    try {
        const data = await fetchJson(
            url,
            {
                method: "POST",
                headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
                body: JSON.stringify({ title, content, status: "draft" }),
            },
            fetchFn
        );
        const id = data && data.id;
        const link = (data && data.link) || (id ? `${site}/?p=${id}` : site);
        const editUrl = id ? `${site}/wp-admin/post.php?post=${id}&action=edit` : link;
        return { success: true, platform: "wordpress", title, url: editUrl, viewUrl: link, id, source: "api" };
    } catch (restErr) {
        // WordPress.com hosted sites 404 on /wp-json — try XML-RPC with same creds.
        try {
            const postId = await postWordpressXmlRpc(site, user, appPass, title, content, fetchFn);
            const editUrl = `${site}/wp-admin/post.php?post=${postId}&action=edit`;
            return { success: true, platform: "wordpress", title, url: editUrl, viewUrl: editUrl, id: postId, source: "api", method: "xmlrpc" };
        } catch (xmlErr) {
            const r = restErr.message || String(restErr);
            return { success: false, platform: "wordpress", error: `WordPress API error: ${r} (XML-RPC fallback: ${xmlErr.message || xmlErr})` };
        }
    }
}

// --- Blogger API v3 (OAuth2) --------------------------------------------------

export async function postBloggerDraft(topic, settings = {}, opts = {}, fetchFn = fetch) {
    const cleanTopic = String(topic || "").trim();
    if (!cleanTopic && !(opts && opts.content)) {
        return { success: false, error: "Usage: provide a topic for the draft post." };
    }
    const blogId = getBloggerBlogId(settings);
    if (!blogId) {
        return { success: false, error: "Blogger API not configured. Set BLOGGER_BLOG_ID and run @blogger-auth (or @set-api-key blogger <blog_id> <access_token>)." };
    }
    const { title, content } = await resolveDraftContent(cleanTopic, opts);
    const onTokens = (opts && opts.onTokens) || undefined;
    const attempt = (token) =>
        fetchJson(
            BLOGGER_POSTS_URL(blogId),
            {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ title, content }),
            },
            fetchFn
        );
    const noToken = { success: false, error: "Blogger API not configured. Run @blogger-auth (or @set-api-key blogger <blog_id> <access_token>)." };
    try {
        let token = await getValidBloggerToken(settings, { onTokens }, fetchFn);
        if (!token) return noToken;
        try {
            const data = await attempt(token);
            const url = (data && data.url) || `https://www.blogger.com/blog/post/edit/${blogId}/${(data && data.id) || ""}`;
            return { success: true, platform: "blogger", title, url, id: data && data.id, source: "api" };
        } catch (err) {
            // Expired/revoked token mid-flight: force one refresh + retry.
            const msg = err.message || String(err);
            if (/^HTTP 401/.test(msg) && bloggerCanRefresh(settings)) {
                if (settings) settings.blogger_token_expiry = 0;
                token = await getValidBloggerToken(settings, { onTokens }, fetchFn);
                if (!token) return noToken;
                const data = await attempt(token);
                const url = (data && data.url) || `https://www.blogger.com/blog/post/edit/${blogId}/${(data && data.id) || ""}`;
                return { success: true, platform: "blogger", title, url, id: data && data.id, source: "api" };
            }
            throw err;
        }
    } catch (err) {
        return { success: false, platform: "blogger", error: `Blogger API error: ${err.message || String(err)}` };
    }
}

// --- Natural-language callout detection --------------------------------------

/**
 * Detect "@Parsly, write a blog post about <topic> on @wordpress/@blogger"
 * style callouts. Leading "@Name," mentions are captured as
 * `mentionedCharacter` (so the draft can be written in that character's
 * voice) and stripped before topic parsing. A platform callout is
 * REQUIRED (explicit "@wordpress" / "@blogger" token or "on
 * wordpress/blogger" phrase) so ordinary chat about blogs never
 * triggers a draft.
 * Returns { topic, platform, mentionedCharacter } or null.
 */
export function detectBlogIntent(text) {
    if (!text) return null;
    const raw = String(text).trim();
    // Capture leading "@Name" / "@Name," callouts (e.g. "@Parsly, ...").
    // Platform tokens (@wordpress/@blogger/@blogspot) are NOT character
    // mentions, so skip them when capturing.
    let mentionedCharacter = "";
    const leadMatch = raw.match(/^((?:@[\w-]+[\s,]*)+)/);
    if (leadMatch) {
        const tokens = [...leadMatch[1].matchAll(/@([\w-]+)/g)].map((m) => m[1]);
        const firstNonPlatform = tokens.find((t) => !/^(wordpress|blogger|blogspot|blog|wp|post)$/i.test(t));
        if (firstNonPlatform) mentionedCharacter = firstNonPlatform;
    }
    let s = raw.replace(/^(?:@[\w-]+[\s,]*)+/, "").trim();
    if (!s) return null;
    const low = s.toLowerCase();
    const hasPlatformToken = /@?(wordpress|blogger|blogspot)\b/.test(low);
    const hasBlogPhrase = /\bblog\b|\bblog\s*post\b|\barticle\b/.test(low);
    const hasWriteVerb = /\b(write|create|compose|draft|publish|post|make)\b/.test(low);
    if (!hasPlatformToken || !hasBlogPhrase || !hasWriteVerb) return null;

    let platform = "auto";
    const onMatch = s.match(/\bon\s+@?(wordpress|blogger|blogspot|blog|\bwp\b)\s*[.!]?\s*$/i);
    const anywhere = s.match(/@?(wordpress|blogger|blogspot)\b/i);
    const platRaw = (onMatch && onMatch[1]) || (anywhere && anywhere[1]) || "";
    platform = normalizeBlogPlatform(platRaw) || "auto";
    if (platform === "auto") return null;

    // Topic: prefer "about <topic> [on <platform>]".
    let topic = "";
    const about = s.match(/\babout\s+(.+?)(?:\s+on\s+@?(?:wordpress|blogger|blogspot|blog|\bwp\b)\s*[.!]?\s*)?$/i);
    if (about) topic = about[1].trim();
    if (!topic) {
        // Fallback: text between the blog phrase and the platform phrase.
        const fb = s.match(/\bblog(?:\s+post)?\b\s*[:\-]?\s*(.+?)(?:\s+on\s+@?(?:wordpress|blogger|blogspot|blog|\bwp\b)\s*[.!]?\s*)?$/i);
        if (fb) topic = fb[1].trim();
    }
    // Strip stray platform tokens / punctuation left in the topic.
    topic = topic
        .replace(/@?(wordpress|blogger|blogspot|\bwp\b)\b/gi, "")
        .replace(/^[:\-,\s]+|[:\-,\s.!]+$/g, "")
        .trim();
    if (!topic) return null;
    return { topic, platform, mentionedCharacter };
}

// --- Default draft entry point (API first, browser fallback) ------------------

/**
 * Compose a blog post draft. Default: official REST APIs + host handoff;
 * falls back to the Chromium editor automation unless BLOG_SOURCE=api.
 * opts: { platform: "wordpress"|"blogger"|"auto", title?, content?, show?,
 *   characterPersona?, characterName? } — voice opts make the LLM write
 * as if that character authored the post.
 */
export async function draftBlog(topic, settings = {}, opts = {}, fetchFn = fetch) {
    const input = String(topic || "").trim();
    if (!input && !(opts && opts.content)) {
        return { success: false, error: "Usage: @blog <topic> [--on wordpress|blogger] [--title <title>] [--no-show]" };
    }
    const show = (opts || {}).show !== false;
    const mode = resolveBlogSource(settings);
    let platform = normalizeBlogPlatform((opts || {}).platform) || "auto";
    if (platform === "auto") {
        if (isWordpressApiConfigured(settings)) platform = "wordpress";
        else if (isBloggerApiConfigured(settings)) platform = "blogger";
        else platform = "wordpress";
    }

    const apiCall = platform === "blogger" ? postBloggerDraft : postWordpressDraft;
    const apiConfigured = platform === "blogger"
        ? isBloggerApiConfigured(settings)
        : isWordpressApiConfigured(settings);

    if (mode !== "browser") {
        if (!apiConfigured) {
            if (mode === "api") {
                const miss = await apiCall(input, settings, opts, fetchFn);
                return { ...miss, source: "api" };
            }
        } else {
            const created = await apiCall(input, settings, opts, fetchFn);
            if (created.success) {
                return { ...created, ...handoff(created.url, show), source: "api" };
            }
            if (mode === "api") return created; // API-only: report the API error, no fallback.
            const fb = await browserDraftBlog(input, settings, { ...opts, platform, show });
            return { ...fb, source: fb.success ? "browser" : fb.source || "browser", fallbackReason: created.error };
        }
    }
    const fb = await browserDraftBlog(input, settings, { ...opts, platform, show });
    return { ...fb, source: fb.success ? "browser" : fb.source || "browser" };
}

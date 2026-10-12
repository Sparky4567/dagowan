import { describe, expect, test } from "bun:test";
import {
    BLOGGER_POSTS_URL,
    buildDraftContent,
    detectBlogIntent,
    draftBlog,
    getBlogStatus,
    getBloggerAccessToken,
    getBloggerBlogId,
    getWordpressSiteUrl,
    isBloggerApiConfigured,
    isWordpressApiConfigured,
    postBloggerDraft,
    postWordpressDraft,
    resolveBlogSource,
    resolveCharacterVoice,
    resolveDraftContent,
    WORDPRESS_POSTS_PATH,
} from "./blog_api.js";
import { findCharacterByName } from "./characters.js";
import {
    formatBlogDraftResult,
    BrowserController,
    isAllowedUrl,
    normalizeBlogPlatform,
    parseBlogInput,
} from "./browser.js";

function jsonResponse(data, ok = true, status = 200) {
    return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

describe("official-API-first blog drafting", () => {
    test("resolves tokens and blog source (env wins, then settings, default auto)", () => {
        const prevSite = process.env.WORDPRESS_SITE_URL;
        const prevSrc = process.env.BLOG_SOURCE;
        try {
            delete process.env.WORDPRESS_SITE_URL;
            delete process.env.BLOG_SOURCE;
            expect(getWordpressSiteUrl({})).toBe("");
            expect(isWordpressApiConfigured({})).toBe(false);
            expect(isBloggerApiConfigured({})).toBe(false);
            expect(getBloggerBlogId({})).toBe("");
            expect(getBloggerAccessToken({})).toBe("");
            expect(isWordpressApiConfigured({
                wordpress_site_url: "https://mysite.com/",
                wordpress_username: "u",
                wordpress_app_password: "p",
            })).toBe(true);
            expect(getWordpressSiteUrl({ wordpress_site_url: "https://mysite.com/" })).toBe("https://mysite.com");
            expect(isBloggerApiConfigured({ blogger_blog_id: "1", blogger_access_token: "t" })).toBe(true);
            // API key alone is read-only: not sufficient for drafts.
            expect(isBloggerApiConfigured({ blogger_blog_id: "1", blogger_api_key: "k" })).toBe(false);
            expect(resolveBlogSource({})).toBe("auto");
            expect(resolveBlogSource({ blog_source: "browser" })).toBe("browser");
            expect(resolveBlogSource({ blog_source: "api" })).toBe("api");
            process.env.BLOG_SOURCE = "browser";
            expect(resolveBlogSource({ blog_source: "api" })).toBe("browser");
            const st = getBlogStatus({ wordpress_site_url: "https://x.com", wordpress_username: "u", wordpress_app_password: "p" });
            expect(st.source).toBe("browser");
            expect(st.wordpressApi).toBe(true);
        } finally {
            if (prevSite === undefined) delete process.env.WORDPRESS_SITE_URL;
            else process.env.WORDPRESS_SITE_URL = prevSite;
            if (prevSrc === undefined) delete process.env.BLOG_SOURCE;
            else process.env.BLOG_SOURCE = prevSrc;
        }
    });

    test("platform normalization", () => {
        expect(normalizeBlogPlatform("wordpress")).toBe("wordpress");
        expect(normalizeBlogPlatform("@wordpress")).toBe("auto"); // raw tokens only; @ handled by parsers
        expect(normalizeBlogPlatform("wp")).toBe("wordpress");
        expect(normalizeBlogPlatform("blogger")).toBe("blogger");
        expect(normalizeBlogPlatform("blogspot")).toBe("blogger");
        expect(normalizeBlogPlatform("blog")).toBe("blogger");
        expect(normalizeBlogPlatform("")).toBe("auto");
        expect(normalizeBlogPlatform("medium")).toBe("auto");
    });

    test("@blog/@wordpress/@blogger/@post parse identically (handoff on unless --no-show)", () => {
        expect(parseBlogInput("@blog the future of local AI")).toEqual({ platform: "auto", topic: "the future of local AI", title: "", show: true });
        expect(parseBlogInput("@blog the future of local AI on wordpress")).toEqual({ platform: "wordpress", topic: "the future of local AI", title: "", show: true });
        expect(parseBlogInput("@blog cats on @blogger --no-show")).toEqual({ platform: "blogger", topic: "cats", title: "", show: false });
        expect(parseBlogInput("@blog cats --on blogger")).toEqual({ platform: "blogger", topic: "cats", title: "", show: true });
        expect(parseBlogInput("@wordpress my week in photos --title Week 12")).toEqual({ platform: "wordpress", topic: "my week in photos", title: "Week 12", show: true });
        expect(parseBlogInput("@wp hello --show")).toEqual({ platform: "wordpress", topic: "hello", title: "", show: true });
        expect(parseBlogInput("@blogger my week in photos")).toEqual({ platform: "blogger", topic: "my week in photos", title: "", show: true });
        expect(parseBlogInput("@post hello world")).toEqual({ platform: "auto", topic: "hello world", title: "", show: true });
        expect(parseBlogInput("@blog")).toEqual({ platform: "auto", topic: "", title: "", show: true });
        expect(parseBlogInput("@play lofi")).toBeNull();
        expect(parseBlogInput("@remember something")).toBeNull();
        expect(parseBlogInput("just chatting")).toBeNull();
    });

    test("detectBlogIntent matches @Parsly callouts with a platform, ignores plain chat", () => {
        expect(detectBlogIntent("@Parsly, write a blog post about local AI on @wordpress")).toEqual({ topic: "local AI", platform: "wordpress", mentionedCharacter: "Parsly" });
        expect(detectBlogIntent("@Parsly write a blog post about cats on @blogger")).toEqual({ topic: "cats", platform: "blogger", mentionedCharacter: "Parsly" });
        expect(detectBlogIntent("Write a blogpost about why it is awesome to be a pet project of open source developer on @blogger")).toEqual({
            topic: "why it is awesome to be a pet project of open source developer",
            platform: "blogger",
            mentionedCharacter: "",
        });
        expect(detectBlogIntent("write a blog post about sourdough on wordpress")).toEqual({ topic: "sourdough", platform: "wordpress", mentionedCharacter: "" });
        expect(detectBlogIntent("please compose a blog post about sourdough on wordpress")).toEqual({ topic: "sourdough", platform: "wordpress", mentionedCharacter: "" });
        expect(detectBlogIntent("@Parsly, draft a blog post about my trip on blogger")).toEqual({ topic: "my trip", platform: "blogger", mentionedCharacter: "Parsly" });
        // No platform -> no trigger (stays a normal chat message).
        expect(detectBlogIntent("@Parsly, write a blog post about cats")).toBeNull();
        // No blog phrase / no write verb -> no trigger.
        expect(detectBlogIntent("@Parsly what do you think about wordpress?")).toBeNull();
        expect(detectBlogIntent("I love reading blogs on wordpress")).toBeNull();
        expect(detectBlogIntent("")).toBeNull();
    });

    test("buildDraftContent derives a title and starter body, honors explicit content", () => {
        const d = buildDraftContent("the future of local AI");
        expect(d.title).toBe("The Future Of Local AI");
        expect(d.content).toContain("the future of local AI");
        const custom = buildDraftContent("x", { title: "My Title", content: "<p>Body</p>" });
        expect(custom).toEqual({ title: "My Title", content: "<p>Body</p>" });
    });

    test("resolveDraftContent prefers explicit content, then generator, then template", async () => {
        const explicit = await resolveDraftContent("cats", { title: "T", content: "<p>Body</p>" });
        expect(explicit).toEqual({ title: "T", content: "<p>Body</p>" });
        const gen = await resolveDraftContent("cats", { generateContent: async (topic) => ({ title: `About ${topic}`, content: "<p>Full post</p>" }) });
        expect(gen).toEqual({ title: "About cats", content: "<p>Full post</p>" });
        const genTitleKept = await resolveDraftContent("cats", { title: "Mine", generateContent: async () => ({ title: "Theirs", content: "<p>Full post</p>" }) });
        expect(genTitleKept.title).toBe("Mine");
        const fallback = await resolveDraftContent("cats", { generateContent: async () => { throw new Error("LLM down"); } });
        expect(fallback.title).toBe("Cats");
        expect(fallback.content).toContain("Starter draft");
    });

    test("postWordpressDraft POSTs a draft with Basic auth to wp-json", async () => {
        const calls = [];
        const fetchFn = async (url, opts) => {
            calls.push({ url: String(url), opts });
            return jsonResponse({ id: 7, link: "https://mysite.com/?p=7" });
        };
        const settings = { wordpress_site_url: "https://mysite.com/", wordpress_username: "u", wordpress_app_password: "p" };
        const res = await postWordpressDraft("local AI", settings, {}, fetchFn);
        expect(res.success).toBe(true);
        expect(res.source).toBe("api");
        expect(res.platform).toBe("wordpress");
        expect(res.url).toBe("https://mysite.com/wp-admin/post.php?post=7&action=edit");
        expect(calls.length).toBe(1);
        expect(calls[0].url).toBe(`https://mysite.com${WORDPRESS_POSTS_PATH}`);
        expect(calls[0].opts.method).toBe("POST");
        expect(calls[0].opts.headers.Authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
        expect(JSON.parse(calls[0].opts.body).status).toBe("draft");
        const missing = await postWordpressDraft("x", {}, {}, fetchFn);
        expect(missing.success).toBe(false);
        expect(missing.error).toMatch(/WordPress API not configured/);
    });

    test("postBloggerDraft POSTs a draft with Bearer token and isDraft", async () => {
        const calls = [];
        const fetchFn = async (url, opts) => {
            calls.push({ url: String(url), opts });
            return jsonResponse({ id: "abc", url: "https://myblog.blogspot.com/2026/09/post.html" });
        };
        const settings = { blogger_blog_id: "123", blogger_access_token: "tok" };
        const res = await postBloggerDraft("cats", settings, { title: "Cats" }, fetchFn);
        expect(res.success).toBe(true);
        expect(res.source).toBe("api");
        expect(res.platform).toBe("blogger");
        expect(res.title).toBe("Cats");
        expect(res.url).toBe("https://myblog.blogspot.com/2026/09/post.html");
        expect(calls[0].url).toBe(BLOGGER_POSTS_URL("123"));
        expect(calls[0].url).toContain("isDraft=true");
        expect(calls[0].opts.headers.Authorization).toBe("Bearer tok");
        const missing = await postBloggerDraft("x", {}, {}, fetchFn);
        expect(missing.success).toBe(false);
        expect(missing.error).toMatch(/Blogger API not configured/);
    });

    test("draftBlog API path returns source=api and formatter labels it", async () => {
        const fetchFn = async () => jsonResponse({ id: 9, link: "https://mysite.com/?p=9" });
        const settings = {
            wordpress_site_url: "https://mysite.com",
            wordpress_username: "u",
            wordpress_app_password: "p",
            blog_source: "api",
        };
        const res = await draftBlog("local AI", settings, { platform: "wordpress", show: false }, fetchFn);
        expect(res.success).toBe(true);
        expect(res.source).toBe("api");
        expect(formatBlogDraftResult(res)).toContain("WordPress");
        const missing = await draftBlog("cats", { blog_source: "api" }, { platform: "blogger", show: false }, fetchFn);
        expect(missing.success).toBe(false);
        expect(missing.error).toMatch(/Blogger API not configured/);
    });

    test("api-only mode surfaces API errors instead of falling back to Chromium", async () => {
        const fetchFn = async () => ({ ok: false, status: 401, text: async () => "rest_forbidden", json: async () => ({}) });
        const settings = {
            wordpress_site_url: "https://mysite.com",
            wordpress_username: "u",
            wordpress_app_password: "bad",
            blog_source: "api",
        };
        const res = await draftBlog("local AI", settings, { platform: "wordpress", show: false }, fetchFn);
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/WordPress API error/);
    });

    test("empty input is rejected without touching network or Chromium", async () => {
        let called = false;
        const fetchFn = async () => {
            called = true;
            return jsonResponse({});
        };
        expect((await draftBlog("", {}, {}, fetchFn)).success).toBe(false);
        expect((await draftBlog("   ", {}, {}, fetchFn)).success).toBe(false);
        expect(called).toBe(false);
    });

    test("formatter renders success, fallback and error replies", () => {
        expect(formatBlogDraftResult({ success: true, platform: "wordpress", title: "T", url: "U", source: "api", shown: true, controlledClosed: true })).toContain("Controlled window closed");
        expect(formatBlogDraftResult({ success: true, platform: "blogger", title: "T", url: "U", source: "browser" })).toContain("Blogger");
        expect(formatBlogDraftResult({ success: true, platform: "wordpress", title: "T", url: "U", source: "browser", filled: false, needsLogin: true })).toContain("Login required");
        expect(formatBlogDraftResult({ success: false, error: "boom" })).toContain("boom");
    });

    test("browser allowlist covers blog editor domains", () => {
        expect(isAllowedUrl("https://wordpress.com/post", {})).toBe(true);
        expect(isAllowedUrl("https://www.blogger.com/home", {})).toBe(true);
        expect(isAllowedUrl("https://draft.blogger.com/blog/post/edit/680361856919837717", {})).toBe(true);
        expect(isAllowedUrl("https://myblog.blogspot.com/2026/09/post.html", {})).toBe(true);
        expect(isAllowedUrl("https://example.com/", {})).toBe(false);
    });

    test("blogger editor opens on the draft host for a known blog", () => {
        const withId = new BrowserController({ blogger_blog_id: "680361856919837717" });
        expect(withId.blogEditorUrl("blogger")).toBe("https://draft.blogger.com/blog/posts/680361856919837717");
        expect(withId.guardBlog("https://draft.blogger.com/blog/posts/680361856919837717")).toBeNull();
        const withoutId = new BrowserController({});
        expect(withoutId.blogEditorUrl("blogger")).toBe("https://draft.blogger.com/home");
    });

    test("resolveCharacterVoice prefers explicit opts, then settings", () => {
        expect(resolveCharacterVoice({ characterPersona: "P", characterName: "N" }, {})).toEqual({ persona: "P", name: "N" });
        expect(resolveCharacterVoice({}, { character_persona: "S", character_name: "M" })).toEqual({ persona: "S", name: "M" });
        expect(resolveCharacterVoice({}, {})).toEqual({ persona: "", name: "" });
    });

    test("buildDraftContent byline carries the character voice on fallback", () => {
        const d = buildDraftContent("cats", { characterName: "Parsly" });
        expect(d.content).toContain("By Parsly");
    });

    test("findCharacterByName matches case/_/-/first-word variants", () => {
        const store = {
            active_character: "Parsly",
            characters: [
                { id: "Parsly", name: "Parsly" },
                { id: "Dungeon master", name: "Dungeon master" },
            ],
        };
        expect(findCharacterByName(store, "parsly")?.name).toBe("Parsly");
        expect(findCharacterByName(store, "Dungeon")?.name).toBe("Dungeon master");
        expect(findCharacterByName(store, "Nobody")).toBeNull();
    });
});

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
    BLOGGER_AUTH_REDIRECT_URI,
    BLOGGER_SCOPES,
    bloggerAuthRedirectUri,
    buildBloggerAuthUrl,
    exchangeCodeForTokens,
    findOAuthClientFile,
    getValidBloggerToken,
    loadOAuthClient,
    refreshBloggerToken,
    resolveAuthHost,
} from "./blogger_auth.js";
import { postBloggerDraft } from "./blog_api.js";

function jsonResponse(data, ok = true, status = 200) {
    return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

const TMP = "/tmp/opencode/blogger_auth_test";
const WEB_FILE = path.join(TMP, "client_secret_web.json");
const INSTALLED_FILE = path.join(TMP, "client_secret_installed.json");

function writeFixtures() {
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(WEB_FILE, JSON.stringify({
        web: { client_id: "web-id", client_secret: "web-secret", auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token" },
    }));
    fs.writeFileSync(INSTALLED_FILE, JSON.stringify({
        installed: { client_id: "desk-id", client_secret: "desk-secret" },
    }));
    fs.writeFileSync(path.join(TMP, "bad.json"), "{not json");
}

describe("blogger oauth", () => {
    test("loadOAuthClient parses web and installed files, rejects junk", () => {
        writeFixtures();
        const web = loadOAuthClient(WEB_FILE);
        expect(web).toEqual({ clientId: "web-id", clientSecret: "web-secret", tokenUri: "https://oauth2.googleapis.com/token", authUri: "https://accounts.google.com/o/oauth2/auth", clientType: "web" });
        const desk = loadOAuthClient(INSTALLED_FILE);
        expect(desk.clientType).toBe("installed");
        expect(desk.clientId).toBe("desk-id");
        expect(() => loadOAuthClient(path.join(TMP, "nope.json"))).toThrow(/not found/);
        expect(() => loadOAuthClient(path.join(TMP, "bad.json"))).toThrow(/valid JSON/);
        expect(findOAuthClientFile({}, WEB_FILE)).toBe(WEB_FILE);
        // Missing explicit path falls back to the cwd glob (finds a real
        // client_secret_*.apps.googleusercontent.com.json when present).
        expect(findOAuthClientFile({}, path.join(TMP, "nope.json"))).toMatch(/client_secret_.*\.apps\.googleusercontent\.com\.json$/);
    });

    test("redirect URI host defaults to 127.0.0.1, localhost opt-in", () => {
        expect(resolveAuthHost({})).toBe("127.0.0.1");
        expect(resolveAuthHost({ blogger_auth_host: "localhost" })).toBe("localhost");
        expect(bloggerAuthRedirectUri({})).toBe("http://127.0.0.1:8791/callback");
        expect(bloggerAuthRedirectUri({ blogger_auth_host: "localhost" })).toBe("http://localhost:8791/callback");
        expect(BLOGGER_AUTH_REDIRECT_URI).toBe("http://127.0.0.1:8791/callback");
    });

    test("buildBloggerAuthUrl requests offline blogger scope with state", () => {
        const url = buildBloggerAuthUrl({ clientId: "id", authUri: "https://accounts.google.com/o/oauth2/v2/auth" }, { state: "s1" });
        expect(url).toContain("client_id=id");
        expect(url).toContain(`redirect_uri=${encodeURIComponent(BLOGGER_AUTH_REDIRECT_URI)}`);
        expect(url).toContain(`scope=${encodeURIComponent(BLOGGER_SCOPES[0])}`);
        expect(url).toContain("access_type=offline");
        expect(url).toContain("prompt=consent");
        expect(url).toContain("state=s1");
    });

    test("exchangeCodeForTokens posts the code grant", async () => {
        const calls = [];
        const fetchFn = async (url, opts) => {
            calls.push({ url: String(url), body: String(opts.body) });
            return jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
        };
        const toks = await exchangeCodeForTokens({ clientId: "id", clientSecret: "sec", tokenUri: "https://oauth2.googleapis.com/token" }, "code123", BLOGGER_AUTH_REDIRECT_URI, fetchFn);
        expect(toks).toEqual({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 });
        expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
        expect(calls[0].body).toContain("grant_type=authorization_code");
        expect(calls[0].body).toContain("code=code123");
    });

    test("getValidBloggerToken reuses unexpired tokens without network", async () => {
        let called = false;
        const fetchFn = async () => {
            called = true;
            return jsonResponse({});
        };
        const settings = { blogger_access_token: "live", blogger_token_expiry: Date.now() + 3600000 };
        expect(await getValidBloggerToken(settings, {}, fetchFn)).toBe("live");
        expect(called).toBe(false);
    });

    test("getValidBloggerToken refreshes expired tokens and persists", async () => {
        const calls = [];
        const fetchFn = async (url, opts) => {
            calls.push(String(url));
            return jsonResponse({ access_token: "fresh", expires_in: 3600 });
        };
        const saved = [];
        const settings = {
            blogger_access_token: "stale",
            blogger_token_expiry: Date.now() - 1000,
            blogger_client_id: "id",
            blogger_client_secret: "sec",
            blogger_refresh_token: "rt",
        };
        const tok = await getValidBloggerToken(settings, { onTokens: async (p) => saved.push(p) }, fetchFn);
        expect(tok).toBe("fresh");
        expect(settings.blogger_access_token).toBe("fresh");
        expect(settings.blogger_token_expiry).toBeGreaterThan(Date.now());
        expect(saved.length).toBe(1);
        expect(calls[0]).toBe("https://oauth2.googleapis.com/token");
    });

    test("postBloggerDraft retries once after a 401 when refresh is available", async () => {
        const seen = [];
        const fetchFn = async (url, opts) => {
            const auth = opts.headers?.Authorization;
            if (auth) seen.push(auth);
            if (String(url).includes("oauth2.googleapis.com")) {
                return jsonResponse({ access_token: "fresh", expires_in: 3600 });
            }
            if (auth === "Bearer stale") {
                return { ok: false, status: 401, text: async () => "Invalid Credentials", json: async () => ({}) };
            }
            return jsonResponse({ id: "p1", url: "https://myblog.blogspot.com/2026/09/t.html" });
        };
        const settings = {
            blogger_blog_id: "123",
            blogger_access_token: "stale",
            blogger_token_expiry: Date.now() + 3600000, // fresh-looking but rejected
            blogger_client_id: "id",
            blogger_client_secret: "sec",
            blogger_refresh_token: "rt",
        };
        const res = await postBloggerDraft("hello", settings, { show: false }, fetchFn);
        expect(res.success).toBe(true);
        expect(res.url).toBe("https://myblog.blogspot.com/2026/09/t.html");
        expect(seen).toEqual(["Bearer stale", "Bearer fresh"]);
    });

    test("postBloggerDraft without any credentials points at @blogger-auth", async () => {
        const res = await postBloggerDraft("x", {}, { show: false }, async () => jsonResponse({}));
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/@blogger-auth/);
    });
});

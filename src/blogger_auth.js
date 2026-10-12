// ---------------------------------------------------------------------------
// Google OAuth2 for the Blogger API (loopback flow for installed use).
//
// The Blogger Data API has no client-credentials grant, so drafts via the
// API need a user OAuth access token. Point the assistant at a
// `client_secret_*.apps.googleusercontent.com.json` file (Google Cloud →
// APIs & Services → Credentials → OAuth client ID) and run @blogger-auth:
// it prints a consent URL, receives the code on a loopback server, and
// stores access + refresh tokens in settings. Refresh is automatic.
//
// One Cloud Console step is required first (the client is type "web" with
// no redirect URIs): add this exact Authorized redirect URI to the OAuth
// client:  http://127.0.0.1:8791/callback
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

export const BLOGGER_SCOPES = ["https://www.googleapis.com/auth/blogger"];
export const BLOGGER_AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
export const BLOGGER_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const BLOGGER_AUTH_PORT = Number(process.env.BLOGGER_AUTH_PORT || 8791);
export const BLOGGER_AUTH_CALLBACK_PATH = "/callback";

/**
 * Loopback host for the OAuth callback. Google compares redirect URIs
 * EXACTLY — http://localhost:... and http://127.0.0.1:... are different
 * registrations, and mixing them up is the classic redirect_uri_mismatch.
 * Default 127.0.0.1; set BLOGGER_AUTH_HOST=localhost (or
 * settings.blogger_auth_host) to match a localhost registration instead.
 */
export function resolveAuthHost(settings = {}) {
    const h = String(settings?.blogger_auth_host || process.env.BLOGGER_AUTH_HOST || "127.0.0.1").trim().toLowerCase();
    return h === "localhost" ? "localhost" : "127.0.0.1";
}

/** Exact redirect URI that must be registered in Cloud Console. */
export function bloggerAuthRedirectUri(settings = {}) {
    return `http://${resolveAuthHost(settings)}:${BLOGGER_AUTH_PORT}${BLOGGER_AUTH_CALLBACK_PATH}`;
}

export const BLOGGER_AUTH_REDIRECT_URI = bloggerAuthRedirectUri();

/** Locate the OAuth client-secret file (explicit path wins, then glob). */
export function findOAuthClientFile(settings = {}, explicitPath = "") {
    const candidates = [
        String(explicitPath || "").trim(),
        String((settings && settings.blogger_oauth_client_file) || "").trim(),
        String(process.env.BLOGGER_OAUTH_CLIENT_FILE || "").trim(),
    ].filter(Boolean);
    for (const c of candidates) {
        const abs = c.startsWith("~")
            ? path.join(process.env.HOME || "", c.slice(1))
            : path.resolve(process.cwd(), c);
        if (fs.existsSync(abs)) return abs;
    }
    try {
        for (const f of fs.readdirSync(process.cwd())) {
            if (/^client_secret_.*\.apps\.googleusercontent\.com\.json$/.test(f)) {
                return path.join(process.cwd(), f);
            }
        }
    } catch {}
    return "";
}

/**
 * Parse a Google client-secret file. Handles both "installed" (Desktop)
 * and "web" (Web application) client types.
 * Returns { clientId, clientSecret, tokenUri, clientType }.
 */
export function loadOAuthClient(filePath) {
    const abs = String(filePath || "").trim();
    if (!abs) throw new Error("No OAuth client file. Pass its path or set blogger_oauth_client_file / BLOGGER_OAUTH_CLIENT_FILE (or drop client_secret_*.json in the project folder).");
    if (!fs.existsSync(abs)) throw new Error(`OAuth client file not found: ${abs}`);
    let data;
    try {
        data = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch (err) {
        throw new Error(`OAuth client file is not valid JSON: ${err.message}`);
    }
    const section = data.installed || data.web;
    if (!section || !section.client_id || !section.client_secret) {
        throw new Error("OAuth client file must contain installed.client_id/client_secret or web.client_id/client_secret.");
    }
    return {
        clientId: String(section.client_id),
        clientSecret: String(section.client_secret),
        tokenUri: String(section.token_endpoint || data.token_uri || BLOGGER_TOKEN_URL),
        authUri: String(section.auth_uri || BLOGGER_AUTH_BASE),
        clientType: data.installed ? "installed" : "web",
    };
}

export function buildBloggerAuthUrl(client, { redirectUri = BLOGGER_AUTH_REDIRECT_URI, state = "", scopes = BLOGGER_SCOPES } = {}) {
    const params = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: [...(scopes || [])].join(" "),
        access_type: "offline", // ask for a refresh token
        prompt: "consent", // re-consent so the refresh token is re-issued
        ...(state ? { state } : {}),
    });
    return `${client.authUri || BLOGGER_AUTH_BASE}?${params.toString()}`;
}

async function postForm(url, fields, fetchFn) {
    const body = new URLSearchParams(fields);
    const res = await (fetchFn || fetch)(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });
    let data = {};
    try {
        data = await res.json();
    } catch {}
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(data && (data.error_description || data.error)) || "token request failed"}`);
    }
    return data;
}

/** Exchange an authorization code for access (+ refresh) tokens. */
export async function exchangeCodeForTokens(client, code, redirectUri = BLOGGER_AUTH_REDIRECT_URI, fetchFn = fetch) {
    const data = await postForm(
        client.tokenUri || BLOGGER_TOKEN_URL,
        {
            code: String(code || ""),
            client_id: client.clientId,
            client_secret: client.clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
        },
        fetchFn
    );
    if (!data.access_token) throw new Error("Token response missing access_token");
    return {
        accessToken: String(data.access_token),
        refreshToken: data.refresh_token ? String(data.refresh_token) : "",
        expiresIn: Number(data.expires_in || 3600),
    };
}

/** Mint a fresh access token from a stored refresh token. */
export async function refreshBloggerToken({ clientId, clientSecret, refreshToken, tokenUri = BLOGGER_TOKEN_URL }, fetchFn = fetch) {
    if (!refreshToken) throw new Error("No Blogger refresh token stored. Run @blogger-auth first.");
    if (!clientId || !clientSecret) throw new Error("No Blogger OAuth client credentials stored. Run @blogger-auth first.");
    const data = await postForm(
        tokenUri,
        {
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "refresh_token",
        },
        fetchFn
    );
    if (!data.access_token) throw new Error("Refresh response missing access_token");
    return {
        accessToken: String(data.access_token),
        expiresIn: Number(data.expires_in || 3600),
    };
}

function readStoredClient(settings = {}) {
    return {
        clientId: (settings && settings.blogger_client_id) || process.env.BLOGGER_CLIENT_ID || "",
        clientSecret: (settings && settings.blogger_client_secret) || process.env.BLOGGER_CLIENT_SECRET || "",
        refreshToken: (settings && settings.blogger_refresh_token) || process.env.BLOGGER_REFRESH_TOKEN || "",
        tokenUri: BLOGGER_TOKEN_URL,
    };
}

/**
 * Return a usable Blogger access token, refreshing (and persisting via
 * onTokens) when the stored one is expired. Falls back to the static
 * blogger_access_token for manually pasted tokens.
 */
export async function getValidBloggerToken(settings = {}, opts = {}, fetchFn = fetch) {
    const { onTokens } = opts || {};
    const stored = readStoredClient(settings);
    const staticToken = (settings && settings.blogger_access_token) || process.env.BLOGGER_ACCESS_TOKEN || process.env.BLOGGER_OAUTH_TOKEN || "";
    const expiry = Number((settings && settings.blogger_token_expiry) || 0);
    if (staticToken && expiry > Date.now() + 60000) return staticToken;
    if (stored.refreshToken && stored.clientId && stored.clientSecret) {
        const fresh = await refreshBloggerToken(stored, fetchFn);
        const patch = {
            blogger_client_id: stored.clientId,
            blogger_client_secret: stored.clientSecret,
            blogger_access_token: fresh.accessToken,
            blogger_token_expiry: Date.now() + fresh.expiresIn * 1000,
        };
        if (settings) Object.assign(settings, patch);
        if (typeof onTokens === "function") {
            try {
                await onTokens(patch);
            } catch {}
        }
        return fresh.accessToken;
    }
    return staticToken;
}

/**
 * Interactive loopback flow: serve the OAuth callback, hand the consent
 * URL to onUrl (print + open), wait for the code, exchange it, and return
 * a settings patch. Never resolves without user approval (timeout).
 */
export async function runBloggerAuthFlow(settings = {}, { clientFile = "", fetchFn = fetch, timeoutMs = 180000, onUrl = null, redirectUri = "" } = {}) {
    const found = findOAuthClientFile(settings, clientFile);
    const client = loadOAuthClient(found);
    const state = crypto.randomBytes(12).toString("hex");
    const redirect = String(redirectUri || "").trim() || bloggerAuthRedirectUri(settings);
    const authUrl = buildBloggerAuthUrl(client, { redirectUri: redirect, state });

    const code = await new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            try {
                const u = new URL(req.url || "/", redirect);
                if (u.pathname !== BLOGGER_AUTH_CALLBACK_PATH) {
                    res.writeHead(404, { "Content-Type": "text/plain" });
                    res.end("Not found. Approve the Blogger consent screen and you will be redirected here.");
                    return;
                }
                if (u.searchParams.get("error")) {
                    res.writeHead(200, { "Content-Type": "text/html" });
                    res.end("<h3>Authorization denied or failed. You can close this tab and retry @blogger-auth.</h3>");
                    finish(new Error(`OAuth error: ${u.searchParams.get("error")}`));
                    return;
                }
                if (u.searchParams.get("state") !== state) {
                    res.writeHead(400, { "Content-Type": "text/plain" });
                    res.end("State mismatch. Retry @blogger-auth.");
                    return;
                }
                const c = u.searchParams.get("code") || "";
                if (!c) {
                    res.writeHead(400, { "Content-Type": "text/plain" });
                    res.end("Missing code. Retry @blogger-auth.");
                    return;
                }
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end("<h3>Blogger connected. You can close this tab and return to the assistant.</h3>");
                finish(null, c);
            } catch (err) {
                finish(err);
            }
        });
        let done = false;
        const timer = setTimeout(() => finish(new Error(`Timed out waiting for approval (${Math.round(timeoutMs / 1000)}s). Retry @blogger-auth.`)), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
        function finish(err, c) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
                server.close();
            } catch {}
            if (err) reject(err);
            else resolve(c);
        }
        server.on("error", (err) => {
            if (err && err.code === "EADDRINUSE") {
                finish(new Error(`Port ${BLOGGER_AUTH_PORT} is busy. Free it and retry @blogger-auth (the Cloud Console redirect URI must stay ${redirect}).`));
            } else {
                finish(err);
            }
        });
        server.listen(BLOGGER_AUTH_PORT, "127.0.0.1", () => {
            if (typeof onUrl === "function") {
                try {
                    onUrl(authUrl);
                } catch {}
            }
        });
    });

    const tokens = await exchangeCodeForTokens(client, code, redirect, fetchFn);
    return {
        blogger_client_id: client.clientId,
        blogger_client_secret: client.clientSecret,
        blogger_access_token: tokens.accessToken,
        ...(tokens.refreshToken ? { blogger_refresh_token: tokens.refreshToken } : {}),
        blogger_token_expiry: Date.now() + tokens.expiresIn * 1000,
        authUrl,
    };
}

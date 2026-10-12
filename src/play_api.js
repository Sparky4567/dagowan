// ---------------------------------------------------------------------------
// Official-API-first playback (YouTube Data API v3 + Spotify Web API).
//
// Default path for @youtube-play/@play and @spotify-play/@spotify:
//   1. Direct URL  -> oEmbed title lookup (no key) + host-browser handoff.
//   2. API search  -> YouTube Data API v3 / Spotify Web API (client
//      credentials) + host-browser handoff. No Chromium needed.
//   3. Fallback    -> the previous Playwright/Chromium automation in
//      browser.js (kept intact as the fallback engine).
//
// Env / settings (settings win after env — same convention as providers.js):
//   YOUTUBE_API_KEY (or settings.youtube_api_key)
//   SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET
//     (or settings.spotify_client_id / settings.spotify_client_secret)
//   PLAY_SOURCE=auto|api|browser (or settings.play_source, default "auto")
//     auto    = API first, Chromium fallback (default)
//     api     = API only, never launch Chromium
//     browser = Chromium only (previous behavior, skips the API)
// ---------------------------------------------------------------------------

import { AgenticModule } from "./agentic.js";
import {
    browserPlaySpotify,
    browserPlayYoutube,
    browserSearchSpotify,
    browserSearchYoutube,
    extractSpotifyUrl,
    extractYoutubeWatchUrl,
    pickSpotifyResult,
    rankSpotifyResults,
} from "./browser.js";

export const YOUTUBE_API_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";

export function getYoutubeApiKey(settings = {}) {
    return (
        (settings && settings.youtube_api_key) ||
        process.env.YOUTUBE_API_KEY ||
        process.env.YOUTUBE_DATA_API_KEY ||
        ""
    );
}

export function getSpotifyClientId(settings = {}) {
    return (settings && settings.spotify_client_id) || process.env.SPOTIFY_CLIENT_ID || "";
}

export function getSpotifyClientSecret(settings = {}) {
    return (settings && settings.spotify_client_secret) || process.env.SPOTIFY_CLIENT_SECRET || "";
}

export function isYoutubeApiConfigured(settings = {}) {
    return Boolean(getYoutubeApiKey(settings));
}

export function isSpotifyApiConfigured(settings = {}) {
    return Boolean(getSpotifyClientId(settings) && getSpotifyClientSecret(settings));
}

/**
 * Which engine to use. Env PLAY_SOURCE wins, then settings.play_source,
 * otherwise "auto" (API first, Chromium fallback).
 */
export function resolvePlaySource(settings = {}) {
    const raw = String(process.env.PLAY_SOURCE ?? settings?.play_source ?? "auto")
        .trim()
        .toLowerCase();
    if (raw === "api" || raw === "apionly" || raw === "api-only") return "api";
    if (raw === "browser" || raw === "chromium" || raw === "headless") return "browser";
    return "auto";
}

export function getPlayStatus(settings = {}) {
    return {
        source: resolvePlaySource(settings),
        youtubeApi: isYoutubeApiConfigured(settings),
        spotifyApi: isSpotifyApiConfigured(settings),
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

/** Best-effort title for a direct URL without any API key (YouTube oEmbed). */
export async function fetchYoutubeOembedTitle(watchUrl, fetchFn = fetch) {
    try {
        const data = await fetchJson(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
            undefined,
            fetchFn
        );
        if (data && data.title) return String(data.title);
    } catch {}
    return "";
}

/** Best-effort title for a direct Spotify URL without any API key. */
export async function fetchSpotifyOembedTitle(spotifyUrl, fetchFn = fetch) {
    try {
        const data = await fetchJson(
            `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`,
            undefined,
            fetchFn
        );
        if (data && data.title) return String(data.title);
    } catch {}
    return "";
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

// --- YouTube Data API v3 ----------------------------------------------------

export async function searchYoutubeApi(query, settings = {}, fetchFn = fetch) {
    const q = String(query || "").trim();
    if (!q) return { success: false, error: "Usage: provide a search query." };
    const key = getYoutubeApiKey(settings);
    if (!key) return { success: false, error: "YouTube Data API key not configured. Set YOUTUBE_API_KEY or @set-api-key youtube <key>." };
    const url =
        `${YOUTUBE_API_SEARCH_URL}?part=snippet&type=video&maxResults=5` +
        `&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`;
    try {
        const data = await fetchJson(url, undefined, fetchFn);
        const items = Array.isArray(data.items) ? data.items : [];
        const results = items
            .map((it) => {
                const videoId = it?.id?.videoId;
                const title = it?.snippet?.title;
                if (!videoId || !title) return null;
                return {
                    title: String(title),
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    videoId,
                    channel: it?.snippet?.channelTitle ? String(it.snippet.channelTitle) : "",
                };
            })
            .filter(Boolean);
        if (results.length === 0) return { success: false, error: `No YouTube results for "${q}".` };
        return { success: true, query: q, url: results[0].url, results, source: "api" };
    } catch (err) {
        return { success: false, error: `YouTube API error: ${err.message || String(err)}` };
    }
}

// --- Spotify Web API (client credentials) -----------------------------------

let spotifyTokenCache = { token: "", expiresAt: 0 };

export function clearSpotifyTokenCache() {
    spotifyTokenCache = { token: "", expiresAt: 0 };
}

async function getSpotifyAppToken(settings = {}, fetchFn = fetch) {
    const id = getSpotifyClientId(settings);
    const secret = getSpotifyClientSecret(settings);
    if (!id || !secret) throw new Error("Spotify API credentials not configured. Set SPOTIFY_CLIENT_ID/SECRET or @set-api-key spotify ...");
    if (spotifyTokenCache.token && Date.now() < spotifyTokenCache.expiresAt - 30000) {
        return spotifyTokenCache.token;
    }
    const basic = Buffer.from(`${id}:${secret}`).toString("base64");
    const data = await fetchJson(
        SPOTIFY_TOKEN_URL,
        {
            method: "POST",
            headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: "grant_type=client_credentials",
        },
        fetchFn
    );
    if (!data.access_token) throw new Error("Spotify token response missing access_token");
    spotifyTokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    };
    return spotifyTokenCache.token;
}

function spotifyTitle(item) {
    const name = String(item?.name || "").trim();
    if (item?.artists && Array.isArray(item.artists)) {
        const artists = item.artists.map((a) => a?.name).filter(Boolean).join(", ");
        return artists ? `${name} — ${artists}` : name;
    }
    const publisher = String(item?.publisher || item?.show?.publisher || "").trim();
    if (publisher) return `${name} (${publisher})`;
    const show = String(item?.show?.name || "").trim();
    if (show) return `${name} (${show})`;
    return name;
}

export async function searchSpotifyApi(query, settings = {}, fetchFn = fetch) {
    const q = String(query || "").trim();
    if (!q) return { success: false, error: "Usage: provide a search query." };
    try {
        const token = await getSpotifyAppToken(settings, fetchFn);
        const url =
            `${SPOTIFY_SEARCH_URL}?q=${encodeURIComponent(q)}` +
            `&type=track,episode,album,playlist,show,artist&limit=8`;
        const data = await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } }, fetchFn);
        const kinds = ["tracks", "episodes", "albums", "playlists", "shows", "artists"];
        const singular = { tracks: "track", episodes: "episode", albums: "album", playlists: "playlist", shows: "show", artists: "artist" };
        const items = [];
        for (const k of kinds) {
            for (const it of data?.[k]?.items || []) {
                if (!it || !it.external_urls?.spotify) continue;
                const urlStr = String(it.external_urls.spotify);
                const title = spotifyTitle(it).replace(/\s+/g, " ").slice(0, 160);
                if (!title) continue;
                items.push({ title, url: urlStr, kind: singular[k] });
                if (items.length >= 8) break;
            }
            if (items.length >= 8) break;
        }
        if (items.length === 0) return { success: false, error: `No Spotify results for "${q}".` };
        const ranked = rankSpotifyResults(items);
        return { success: true, query: q, url: ranked[0].url, results: ranked.slice(0, 5), source: "api" };
    } catch (err) {
        return { success: false, error: `Spotify API error: ${err.message || String(err)}` };
    }
}

// --- Default play/search entry points (API first, browser fallback) ---------

/**
 * Play a YouTube query/URL. Default: official Data API + host handoff;
 * falls back to the Chromium automation unless PLAY_SOURCE=api.
 */
export async function playYoutube(queryOrUrl, settings = {}, opts = {}, fetchFn = fetch) {
    const input = String(queryOrUrl || "").trim();
    if (!input) return { success: false, error: "Usage: @youtube-play <search terms or YouTube URL>" };
    const show = opts.show !== false;
    const mode = resolvePlaySource(settings);

    const direct = extractYoutubeWatchUrl(input);
    if (direct) {
        const title = (await fetchYoutubeOembedTitle(direct, fetchFn)) || "YouTube video";
        return { success: true, title, url: direct, playing: false, ...handoff(direct, show), source: "url-direct" };
    }

    if (mode !== "browser") {
        if (!isYoutubeApiConfigured(settings)) {
            if (mode === "api") {
                return { success: false, error: "YouTube Data API key not configured. Set YOUTUBE_API_KEY or @set-api-key youtube <key>." };
            }
        } else {
            const found = await searchYoutubeApi(input, settings, fetchFn);
            if (found.success) {
                const top = found.results[0];
                return { success: true, title: top.title, url: top.url, playing: false, ...handoff(top.url, show), source: "api" };
            }
            if (mode === "api") return found; // API-only: report the API error, no fallback.
            const fb = await browserPlayYoutube(input, settings, opts);
            return { ...fb, source: fb.success ? "browser" : fb.source || "browser", fallbackReason: found.error };
        }
    }
    const fb = await browserPlayYoutube(input, settings, opts);
    return { ...fb, source: fb.success ? "browser" : fb.source || "browser" };
}

/** API-first YouTube search (used by play; @browser-search stays browser-only). */
export async function searchYoutube(query, settings = {}, fetchFn = fetch) {
    const mode = resolvePlaySource(settings);
    if (mode !== "browser" && isYoutubeApiConfigured(settings)) {
        const res = await searchYoutubeApi(query, settings, fetchFn);
        if (res.success || mode === "api") return res;
        const fb = await browserSearchYoutube(query, settings);
        return { ...fb, source: "browser", fallbackReason: res.error };
    }
    const fb = await browserSearchYoutube(query, settings);
    return { ...fb, source: "browser" };
}

/**
 * Play a Spotify query/URL. Default: official Web API + host handoff;
 * falls back to the Chromium automation unless PLAY_SOURCE=api.
 */
export async function playSpotify(queryOrUrl, settings = {}, opts = {}, fetchFn = fetch) {
    const input = String(queryOrUrl || "").trim();
    if (!input) return { success: false, error: "Usage: @spotify-play <search terms or Spotify URL>" };
    const show = opts.show !== false;
    const mode = resolvePlaySource(settings);

    const direct = extractSpotifyUrl(input);
    if (direct) {
        const kind = (direct.match(/open\.spotify\.com\/(track|episode|show|album|playlist|artist)/) || [])[1] || "track";
        const title = (await fetchSpotifyOembedTitle(direct, fetchFn)) || "Spotify track";
        return { success: true, title, url: direct, kind, playing: false, needsLogin: false, ...handoff(direct, show), source: "url-direct" };
    }

    if (mode !== "browser") {
        if (!isSpotifyApiConfigured(settings)) {
            if (mode === "api") {
                return { success: false, error: "Spotify API credentials not configured. Set SPOTIFY_CLIENT_ID/SECRET or @set-api-key spotify <id> <secret>." };
            }
        } else {
            const found = await searchSpotifyApi(input, settings, fetchFn);
            if (found.success) {
                const picked = pickSpotifyResult(found.results) || found.results[0];
                return {
                    success: true,
                    title: picked.title,
                    url: picked.url,
                    kind: picked.kind || "track",
                    playing: false,
                    needsLogin: false,
                    ...handoff(picked.url, show),
                    source: "api",
                };
            }
            if (mode === "api") return found;
            const fb = await browserPlaySpotify(input, settings, opts);
            return { ...fb, source: fb.success ? "browser" : fb.source || "browser", fallbackReason: found.error };
        }
    }
    const fb = await browserPlaySpotify(input, settings, opts);
    return { ...fb, source: fb.success ? "browser" : fb.source || "browser" };
}

/** API-first Spotify search (used by play; @browser-search-spotify stays browser-only). */
export async function searchSpotify(query, settings = {}, fetchFn = fetch) {
    const mode = resolvePlaySource(settings);
    if (mode !== "browser" && isSpotifyApiConfigured(settings)) {
        const res = await searchSpotifyApi(query, settings, fetchFn);
        if (res.success || mode === "api") return res;
        const fb = await browserSearchSpotify(query, settings);
        return { ...fb, source: "browser", fallbackReason: res.error };
    }
    const fb = await browserSearchSpotify(query, settings);
    return { ...fb, source: "browser" };
}

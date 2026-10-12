import { describe, expect, test } from "bun:test";
import {
    clearSpotifyTokenCache,
    getPlayStatus,
    getSpotifyClientId,
    getYoutubeApiKey,
    isSpotifyApiConfigured,
    isYoutubeApiConfigured,
    playSpotify,
    playYoutube,
    resolvePlaySource,
    searchSpotifyApi,
    searchYoutubeApi,
} from "./play_api.js";
import { formatPlayResult, formatSpotifyPlayResult } from "./browser.js";

function jsonResponse(data, ok = true, status = 200) {
    return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

describe("official-API-first playback", () => {
    test("resolves keys and play source (env wins, then settings, default auto)", () => {
        const prevKey = process.env.YOUTUBE_API_KEY;
        const prevSrc = process.env.PLAY_SOURCE;
        try {
            delete process.env.YOUTUBE_API_KEY;
            delete process.env.PLAY_SOURCE;
            expect(getYoutubeApiKey({})).toBe("");
            expect(isYoutubeApiConfigured({})).toBe(false);
            expect(getYoutubeApiKey({ youtube_api_key: "k" })).toBe("k");
            expect(isYoutubeApiConfigured({ youtube_api_key: "k" })).toBe(true);
            expect(isSpotifyApiConfigured({})).toBe(false);
            expect(isSpotifyApiConfigured({ spotify_client_id: "a", spotify_client_secret: "b" })).toBe(true);
            expect(getSpotifyClientId({})).toBe("");
            expect(resolvePlaySource({})).toBe("auto");
            expect(resolvePlaySource({ play_source: "browser" })).toBe("browser");
            expect(resolvePlaySource({ play_source: "api" })).toBe("api");
            process.env.PLAY_SOURCE = "browser";
            expect(resolvePlaySource({ play_source: "api" })).toBe("browser");
            const st = getPlayStatus({ youtube_api_key: "k" });
            expect(st.source).toBe("browser");
            expect(st.youtubeApi).toBe(true);
        } finally {
            if (prevKey === undefined) delete process.env.YOUTUBE_API_KEY;
            else process.env.YOUTUBE_API_KEY = prevKey;
            if (prevSrc === undefined) delete process.env.PLAY_SOURCE;
            else process.env.PLAY_SOURCE = prevSrc;
        }
    });

    test("searchYoutubeApi maps Data API items to watch URLs", async () => {
        const fetchFn = async () =>
            jsonResponse({ items: [{ id: { videoId: "abc123XYZ_-" }, snippet: { title: "Lofi Mix", channelTitle: "Chill" } }] });
        const res = await searchYoutubeApi("lofi", { youtube_api_key: "key" }, fetchFn);
        expect(res.success).toBe(true);
        expect(res.source).toBe("api");
        expect(res.results[0].url).toBe("https://www.youtube.com/watch?v=abc123XYZ_-");
        expect(res.results[0].title).toBe("Lofi Mix");
        const missing = await searchYoutubeApi("x", {}, fetchFn);
        expect(missing.success).toBe(false);
    });

    test("searchSpotifyApi uses client-credentials token and maps kinds", async () => {
        clearSpotifyTokenCache();
        const calls = [];
        const fetchFn = async (url, opts) => {
            calls.push(String(url));
            if (String(url).includes("accounts.spotify.com")) {
                return jsonResponse({ access_token: "tok", expires_in: 3600 });
            }
            return jsonResponse({
                tracks: { items: [{ name: "Song", artists: [{ name: "Band" }], external_urls: { spotify: "https://open.spotify.com/track/AAA111" } }] },
                episodes: { items: [] },
                albums: { items: [] },
                playlists: { items: [] },
                shows: { items: [] },
                artists: { items: [] },
            });
        };
        const res = await searchSpotifyApi("song", { spotify_client_id: "id", spotify_client_secret: "sec" }, fetchFn);
        expect(res.success).toBe(true);
        expect(res.source).toBe("api");
        expect(res.results[0]).toEqual({ title: "Song — Band", url: "https://open.spotify.com/track/AAA111", kind: "track" });
        expect(calls.some((u) => u.includes("accounts.spotify.com"))).toBe(true);
        clearSpotifyTokenCache();
    });

    test("direct URLs need no API key and hand off without Chromium", async () => {
        const fetchFn = async () => jsonResponse({ title: "Never Gonna Give You Up" });
        const yt = await playYoutube("https://youtu.be/dQw4w9WgXcQ", {}, { show: false }, fetchFn);
        expect(yt.success).toBe(true);
        expect(yt.source).toBe("url-direct");
        expect(yt.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        expect(yt.title).toBe("Never Gonna Give You Up");
        const sp = await playSpotify("spotify:track:4uLU6hMCjMI75M1A2tKUQ3", {}, { show: false }, fetchFn);
        expect(sp.success).toBe(true);
        expect(sp.source).toBe("url-direct");
        expect(sp.kind).toBe("track");
    });

    test("API play path returns source=api and formatters label it", async () => {
        const fetchFn = async () =>
            jsonResponse({ items: [{ id: { videoId: "vid1" }, snippet: { title: "Vid One", channelTitle: "C" } }] });
        const res = await playYoutube("lofi hip hop", { youtube_api_key: "key", play_source: "api" }, { show: false }, fetchFn);
        expect(res.success).toBe(true);
        expect(res.source).toBe("api");
        expect(formatPlayResult(res)).toContain("YouTube Data API");
        const missing = await playSpotify("lofi", { play_source: "api" }, { show: false }, fetchFn);
        expect(missing.success).toBe(false);
        expect(missing.error).toMatch(/Spotify API credentials/);
    });

    test("api-only mode surfaces API errors instead of falling back to Chromium", async () => {
        const fetchFn = async () => ({ ok: false, status: 403, text: async () => "quotaExceeded", json: async () => ({}) });
        const res = await playYoutube("lofi", { youtube_api_key: "key", play_source: "api" }, { show: false }, fetchFn);
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/YouTube API error/);
    });

    test("empty input is rejected without touching network or Chromium", async () => {
        let called = false;
        const fetchFn = async () => {
            called = true;
            return jsonResponse({});
        };
        expect((await playYoutube("", {}, {}, fetchFn)).success).toBe(false);
        expect((await playSpotify("   ", {}, {}, fetchFn)).success).toBe(false);
        expect(called).toBe(false);
    });

    test("spotify formatter labels the API path", () => {
        expect(formatSpotifyPlayResult({ success: true, title: "T", url: "U", kind: "track", source: "api" })).toContain("Spotify Web API");
    });
});

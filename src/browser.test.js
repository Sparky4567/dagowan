import { describe, expect, test } from "bun:test";
import os from "node:os";
import { AgenticModule } from "./agentic.js";
import {
    BROWSER_DEFAULT_ALLOWED_DOMAINS,
    buildSpotifySearchUrl,
    buildYoutubeSearchUrl,
    extractSpotifyUrl,
    extractYoutubeWatchUrl,
    formatPlayResult,
    formatSpotifyPlayResult,
    getBrowserController,
    hasDisplay,
    isAllowedUrl,
    looksLikeSpotifyUrl,
    looksLikeYoutubeUrl,
    parsePlayInput,
    parseSpotifyPlayInput,
    pickSpotifyResult,
    rankSpotifyResults,
    resolveAllowedDomains,
    resolveHeadless,
    resolveIdleCloseMs,
} from "./browser.js";

describe("agentic browser helpers", () => {
    test("builds a youtube search url with encoded query", () => {
        expect(buildYoutubeSearchUrl("lofi hip hop")).toBe(
            "https://www.youtube.com/results?search_query=lofi%20hip%20hop"
        );
    });

    test("normalizes watch, shorts and youtu.be hrefs", () => {
        expect(extractYoutubeWatchUrl("/watch?v=dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        expect(extractYoutubeWatchUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        expect(extractYoutubeWatchUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
        expect(extractYoutubeWatchUrl("https://www.youtube.com/results?search_query=x")).toBeNull();
        expect(looksLikeYoutubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
        expect(looksLikeYoutubeUrl("just some words")).toBe(false);
    });

    test("allowlist permits subdomains and blocks everything else", () => {
        expect(isAllowedUrl("https://www.youtube.com/watch?v=x", {})).toBe(true);
        expect(isAllowedUrl("https://music.youtube.com/", {})).toBe(true);
        expect(isAllowedUrl("https://evil-youtube.com/", {})).toBe(false);
        expect(isAllowedUrl("https://example.com/", {})).toBe(false);
        expect(isAllowedUrl("file:///etc/passwd", {})).toBe(false);
        expect(BROWSER_DEFAULT_ALLOWED_DOMAINS).toContain("youtube.com");
    });

    test("BROWSER_ALLOWED_DOMAINS env overrides the defaults", () => {
        const prev = process.env.BROWSER_ALLOWED_DOMAINS;
        process.env.BROWSER_ALLOWED_DOMAINS = "example.com";
        try {
            expect(resolveAllowedDomains({})).toEqual(["example.com"]);
            expect(isAllowedUrl("https://example.com/", {})).toBe(true);
            expect(isAllowedUrl("https://www.youtube.com/", {})).toBe(false);
        } finally {
            if (prev === undefined) delete process.env.BROWSER_ALLOWED_DOMAINS;
            else process.env.BROWSER_ALLOWED_DOMAINS = prev;
        }
    });

    test("disallowed urls are rejected without launching a browser", async () => {
        const res = await getBrowserController({}).open("https://example.com/");
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/allowlist/);
    });

    test("controller is a shared singleton", () => {
        expect(getBrowserController({})).toBe(getBrowserController({}));
    });

    test("@play and @youtube-play parse identically (handoff on unless --no-show)", () => {
        expect(parsePlayInput("@play lofi hip hop")).toEqual({ query: "lofi hip hop", show: true });
        expect(parsePlayInput("@youtube-play lofi hip hop")).toEqual({ query: "lofi hip hop", show: true });
        expect(parsePlayInput("/play lofi hip hop --show")).toEqual({ query: "lofi hip hop", show: true });
        expect(parsePlayInput("@play lofi hip hop --no-show")).toEqual({ query: "lofi hip hop", show: false });
        expect(parsePlayInput("@youtube-play https://youtu.be/dQw4w9WgXcQ")).toEqual({
            query: "https://youtu.be/dQw4w9WgXcQ",
            show: true,
        });
        expect(parsePlayInput("@play")).toEqual({ query: "", show: true });
        expect(parsePlayInput("@remember something")).toBeNull();
        expect(parsePlayInput("just chatting")).toBeNull();
    });

    test("formatPlayResult renders success and error replies", () => {
        expect(formatPlayResult({ success: true, title: "T", url: "U", playing: true })).toContain("Now playing");
        expect(formatPlayResult({ success: false, error: "boom" })).toContain("boom");
    });

    test("spotify helpers: search url, url normalization, parser, allowlist, formatter", () => {
        expect(buildSpotifySearchUrl("Serial podcast")).toBe("https://open.spotify.com/search/Serial%20podcast");
        expect(extractSpotifyUrl("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3?si=xyz")).toBe(
            "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3"
        );
        expect(extractSpotifyUrl("https://open.spotify.com/episode/2Adzk0QeP5MFcB7fyKq7db")).toBe(
            "https://open.spotify.com/episode/2Adzk0QeP5MFcB7fyKq7db"
        );
        expect(extractSpotifyUrl("spotify:track:4uLU6hMCjMI75M1A2tKUQ3")).toBe(
            "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3"
        );
        expect(extractSpotifyUrl("https://open.spotify.com/search/lofi")).toBeNull();
        expect(looksLikeSpotifyUrl("spotify:episode:2Adzk0QeP5MFcB7fyKq7db")).toBe(true);
        expect(looksLikeSpotifyUrl("just some words")).toBe(false);
        expect(parseSpotifyPlayInput("@spotify-play lofi hip hop")).toEqual({ query: "lofi hip hop", show: true });
        expect(parseSpotifyPlayInput("@spotify Serial podcast")).toEqual({ query: "Serial podcast", show: true });
        expect(parseSpotifyPlayInput("@spotify Serial --no-show")).toEqual({ query: "Serial", show: false });
        expect(parseSpotifyPlayInput("@spotify")).toEqual({ query: "", show: true });
        expect(parseSpotifyPlayInput("@play lofi")).toBeNull();
        expect(isAllowedUrl("https://open.spotify.com/track/abc123", {})).toBe(true);
        expect(BROWSER_DEFAULT_ALLOWED_DOMAINS).toContain("spotify.com");
        expect(formatSpotifyPlayResult({ success: true, title: "T", url: "U", kind: "track", shown: true })).toContain("Spotify");
        expect(formatSpotifyPlayResult({ success: true, title: "T", url: "U", kind: "playlist", playing: true })).toContain("playing");
        expect(formatSpotifyPlayResult({ success: true, title: "T", url: "U", kind: "playlist", playing: false, needsLogin: true })).toContain("login");
        expect(formatSpotifyPlayResult({ success: false, error: "boom" })).toContain("boom");
    });

    test("spotify ranking prefers a specific track over same-name containers", () => {
        const items = [
            { title: "Top Song Lyrics", url: "https://open.spotify.com/playlist/37i9dQZF1CLcTo7UzL0sYK", kind: "playlist" },
            { title: "Bohemian Rhapsody", url: "https://open.spotify.com/album/4HIJDhGd6LexntMzxrOA5a", kind: "album" },
            { title: "Bohemian Rhapsody", url: "https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J", kind: "track" },
        ];
        expect(rankSpotifyResults(items).map((r) => r.kind)).toEqual(["track", "album", "playlist"]);
        expect(pickSpotifyResult(items).kind).toBe("track");
        expect(pickSpotifyResult(items.slice(0, 2)).kind).toBe("album");
        expect(pickSpotifyResult([])).toBeNull();
    });

    test("resolveIdleCloseMs: env wins, then settings, else default; 0 disables", () => {
        const prev = process.env.BROWSER_IDLE_CLOSE_MS;
        try {
            process.env.BROWSER_IDLE_CLOSE_MS = "45000";
            expect(resolveIdleCloseMs({})).toBe(45000);
            expect(resolveIdleCloseMs({ browser_idle_close_ms: 60000 })).toBe(45000);
            process.env.BROWSER_IDLE_CLOSE_MS = "0";
            expect(resolveIdleCloseMs({})).toBe(0);
            delete process.env.BROWSER_IDLE_CLOSE_MS;
            expect(resolveIdleCloseMs({ browser_idle_close_ms: 60000 })).toBe(60000);
            expect(resolveIdleCloseMs({})).toBe(300000);
        } finally {
            if (prev === undefined) delete process.env.BROWSER_IDLE_CLOSE_MS;
            else process.env.BROWSER_IDLE_CLOSE_MS = prev;
        }
    });

    test("idle timer arms on settle and never throws without a browser", async () => {
        const c = getBrowserController({ browser_idle_close_ms: 30 });
        c.noteIdle();
        expect(c.idleTimer !== null).toBe(true);
        c.disarmIdle();
        expect(c.idleTimer).toBeNull();
        c.noteIdle();
        await new Promise((r) => setTimeout(r, 120));
        expect(c.idleTimer).toBeNull();
        expect((await c.closeIdle()).success).toBe(true);
        expect((await c.close()).success).toBe(true);
    });
    test("settleHandoff closes only after a verified handoff, formatters report it", async () => {
        const c = getBrowserController({});
        const kept = await c.settleHandoff({ success: true, shown: false });
        expect(kept.controlledClosed).toBeUndefined();
        const closed = await c.settleHandoff({ success: true, shown: true });
        expect(closed.controlledClosed).toBe(true);
        expect((await c.close()).success).toBe(true);
        expect(formatPlayResult({ success: true, title: "V", url: "U", playing: true, shown: true, controlledClosed: true })).toContain("Controlled window closed");
        expect(formatSpotifyPlayResult({ success: true, title: "T", url: "U", kind: "track", shown: true, controlledClosed: true })).toContain("Controlled window closed");
        expect(formatSpotifyPlayResult({ success: true, title: "T", url: "U", kind: "track", shown: true })).not.toContain("Controlled window closed");
    });
    test("spotify play/search reject empty input without launching a browser", async () => {
        const playRes = await getBrowserController({}).playSpotify("");
        expect(playRes.success).toBe(false);
        expect(playRes.error).toMatch(/Usage/);
        const searchRes = await getBrowserController({}).searchSpotify("   ");
        expect(searchRes.success).toBe(false);
        expect(searchRes.error).toMatch(/Usage/);
    });

    test("openUrl verifies the host-browser handoff instead of fire-and-forget", () => {
        if (os.platform() === "win32" || os.platform() === "darwin") return;
        const prevBrowser = process.env.BROWSER;
        const prevPath = process.env.PATH;
        try {
            // A $BROWSER that exits 0 must report success with the method used.
            process.env.BROWSER = "/bin/true";
            const ok = new AgenticModule().openUrl("https://open.spotify.com/track/abc123");
            expect(ok.success).toBe(true);
            expect(ok.method).toBe("$BROWSER");

            // Nothing resolvable anywhere must report failure with a reason,
            // never a false opened=true.
            process.env.BROWSER = "/nonexistent-opener-xyz";
            process.env.PATH = "/nonexistent-path-xyz";
            const bad = new AgenticModule().openUrl("https://open.spotify.com/track/abc123");
            expect(bad.success).toBe(false);
            expect(typeof bad.error).toBe("string");
        } finally {
            if (prevBrowser === undefined) delete process.env.BROWSER;
            else process.env.BROWSER = prevBrowser;
            if (prevPath === undefined) delete process.env.PATH;
            else process.env.PATH = prevPath;
        }
    });

    test("resolveHeadless: explicit env and settings win, otherwise display-based", () => {
        const prevEnv = process.env.BROWSER_HEADLESS;
        const prevDisplay = process.env.DISPLAY;
        const prevWayland = process.env.WAYLAND_DISPLAY;
        try {
            process.env.BROWSER_HEADLESS = "1";
            expect(resolveHeadless({})).toBe(true);
            process.env.BROWSER_HEADLESS = "0";
            expect(resolveHeadless({})).toBe(false);
            delete process.env.BROWSER_HEADLESS;

            expect(resolveHeadless({ browser_headless: true })).toBe(true);
            expect(resolveHeadless({ browser_headless: false })).toBe(false);

            // Auto mode follows display detection and always returns a boolean.
            delete process.env.DISPLAY;
            delete process.env.WAYLAND_DISPLAY;
            const auto = resolveHeadless({ browser_headless: "auto" });
            expect(typeof auto).toBe("boolean");
            expect(auto).toBe(!hasDisplay());
        } finally {
            if (prevEnv === undefined) delete process.env.BROWSER_HEADLESS;
            else process.env.BROWSER_HEADLESS = prevEnv;
            if (prevDisplay === undefined) delete process.env.DISPLAY;
            else process.env.DISPLAY = prevDisplay;
            if (prevWayland === undefined) delete process.env.WAYLAND_DISPLAY;
            else process.env.WAYLAND_DISPLAY = prevWayland;
        }
    });
});

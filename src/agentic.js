import { spawnSync } from "node:child_process";
import os from "node:os";

export class AgenticModule {
    constructor() {
        this.youtubeUrl = "https://www.youtube.com/";
        this.googleUrl = "https://www.google.com/";
        this.giphyUrl = "https://giphy.com/";
        this.spotifyUrl = "https://open.spotify.com/";
        this.defaultBrowserAddress = "https://www.google.com/";
    }

    /**
     * Opens a URL in the user's default browser and VERIFIES the handoff.
     * The previous fire-and-forget spawn() always reported success even when
     * the opener failed (e.g. garcon unreachable from the app's environment),
     * so callers logged opened=true while nothing reached the host browser
     * and the URL was only visible in the controlled Chromium window.
     * Tries $BROWSER first (ChromeOS containers set it to garcon-url-handler),
     * then the platform opener, then common Linux browsers.
     * Returns { success, url, method? } or { success:false, error }.
     */
    openUrl(url) {
        const platform = os.platform();
        const candidates = [];
        // $BROWSER may be "cmd --flag" style: first token is the binary.
        const browserEnv = String(process.env.BROWSER || "").trim();
        if (browserEnv && platform !== "win32" && platform !== "darwin") {
            const tokens = browserEnv.split(/\s+/).filter(Boolean);
            if (tokens.length > 0) candidates.push({ cmd: tokens[0], args: [...tokens.slice(1), url], method: "$BROWSER" });
        }

        if (platform === "win32") {
            candidates.push({ cmd: "cmd.exe", args: ["/c", "start", "", url], method: "start" });
        } else if (platform === "darwin") {
            candidates.push({ cmd: "open", args: [url], method: "open" });
        } else {
            candidates.push({ cmd: "xdg-open", args: [url], method: "xdg-open" });
            for (const b of ["google-chrome", "chromium", "chromium-browser", "firefox"]) {
                candidates.push({ cmd: b, args: [url], method: b });
            }
        }

        const errors = [];
        for (const c of candidates) {
            try {
                const r = spawnSync(c.cmd, c.args, { timeout: 15000, stdio: "ignore" });
                if (r.error) {
                    errors.push(`${c.method}: ${r.error.message}`);
                    continue;
                }
                if (r.status === 0) return { success: true, url, method: c.method };
                errors.push(`${c.method}: exit ${r.status}`);
            } catch (err) {
                errors.push(`${c.method}: ${err.message || String(err)}`);
            }
        }
        return { success: false, url, error: errors.join("; ") || "no opener available" };
    }

    openBrowser() {
        return this.openUrl(this.defaultBrowserAddress);
    }

    searchYoutube(query) {
        const cleanQuery = encodeURIComponent(query.trim());
        const url = `${this.youtubeUrl}results?search_query=${cleanQuery}`;
        this.openUrl(url);
        return { success: true, query, url };
    }

    searchGoogle(query) {
        const cleanQuery = encodeURIComponent(query.trim());
        const url = `${this.googleUrl}search?q=${cleanQuery}`;
        this.openUrl(url);
        return { success: true, query, url };
    }

    searchGiphy(query) {
        const cleanQuery = encodeURIComponent(query.trim()).replace(/%20/g, "-");
        const url = `${this.giphyUrl}search/${cleanQuery}`;
        this.openUrl(url);
        return { success: true, query, url };
    }

    searchSpotify(query) {
        const cleanQuery = encodeURIComponent(query.trim());
        const url = `${this.spotifyUrl}search/${cleanQuery}`;
        this.openUrl(url);
        return { success: true, query, url };
    }

    /**
     * Evaluates user input against agentic tool triggers.
     */
    selectTool(userInput) {
        const rawStr = String(userInput).trim();
        // Canonical "@" prefix (MCP-style); "/" still accepted and normalized.
        const inputStr = rawStr.startsWith("@") ? "/" + rawStr.slice(1) : rawStr;
        const lower = inputStr.toLowerCase();

        if (lower === "open browser" || lower === "@open-browser" || lower === "/open-browser") {
            this.openBrowser();
            return { handled: true, status: true, message: "🌐 Opening web browser!" };
        }

        // Search YouTube
        if (
            lower.startsWith("/search-youtube-for ") ||
            (lower.includes("search") && lower.includes("youtube") && lower.includes("for"))
        ) {
            let query = inputStr;
            ["/search-youtube-for", "search", "youtube", "for"].forEach((w) => {
                const regex = new RegExp(`\\b${w}\\b`, "gi");
                query = query.replace(regex, "");
            });
            query = query.trim();
            if (query) {
                this.searchYoutube(query);
                return { handled: true, status: true, message: `▶️ Searching YouTube for "${query}"!` };
            }
        }

        // Search Google
        if (
            lower.startsWith("/search-google-for ") ||
            (lower.includes("search") && lower.includes("google") && lower.includes("for"))
        ) {
            let query = inputStr;
            ["/search-google-for", "search", "google", "for"].forEach((w) => {
                const regex = new RegExp(`\\b${w}\\b`, "gi");
                query = query.replace(regex, "");
            });
            query = query.trim();
            if (query) {
                this.searchGoogle(query);
                return { handled: true, status: true, message: `🔍 Searching Google for "${query}"!` };
            }
        }

        // Search Giphy
        if (
            lower.startsWith("/search-giphy-for ") ||
            (lower.includes("search") && lower.includes("giphy") && lower.includes("for"))
        ) {
            let query = inputStr;
            ["/search-giphy-for", "search", "giphy", "for"].forEach((w) => {
                const regex = new RegExp(`\\b${w}\\b`, "gi");
                query = query.replace(regex, "");
            });
            query = query.trim();
            if (query) {
                this.searchGiphy(query);
                return { handled: true, status: true, message: `👾 Searching Giphy for "${query}"!` };
            }
        }

        // Search Spotify (songs + podcasts, legacy fire-and-forget open)
        if (
            lower.startsWith("/search-spotify-for ") ||
            (lower.includes("search") && lower.includes("spotify") && lower.includes("for"))
        ) {
            let query = inputStr;
            ["/search-spotify-for", "search", "spotify", "for"].forEach((w) => {
                const regex = new RegExp(`\\b${w}\\b`, "gi");
                query = query.replace(regex, "");
            });
            query = query.trim();
            if (query) {
                this.searchSpotify(query);
                return { handled: true, status: true, message: `🎧 Searching Spotify for "${query}"!` };
            }
        }

        return { handled: false, status: false, message: null };
    }
}

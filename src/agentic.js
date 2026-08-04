import { spawn } from "node:child_process";
import os from "node:os";

export class AgenticModule {
    constructor() {
        this.youtubeUrl = "https://www.youtube.com/";
        this.googleUrl = "https://www.google.com/";
        this.giphyUrl = "https://giphy.com/";
        this.defaultBrowserAddress = "https://www.google.com/";
    }

    /**
     * Opens a URL using the default system browser cross-platform.
     */
    openUrl(url) {
        const platform = os.platform();
        let command = "";
        let args = [];

        if (platform === "win32") {
            command = "cmd.exe";
            args = ["/c", "start", "", url];
        } else if (platform === "darwin") {
            command = "open";
            args = [url];
        } else {
            command = "xdg-open";
            args = [url];
        }

        try {
            const child = spawn(command, args, { detached: true, stdio: "ignore" });
            child.unref();
            return { success: true, url };
        } catch (err) {
            return { success: false, error: err.message };
        }
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

    /**
     * Evaluates user input against agentic tool triggers.
     */
    selectTool(userInput) {
        const inputStr = String(userInput).trim();
        const lower = inputStr.toLowerCase();

        if (lower === "open browser" || lower === "/open-browser") {
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

        return { handled: false, status: false, message: null };
    }
}

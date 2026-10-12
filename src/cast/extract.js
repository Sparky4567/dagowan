// ---------------------------------------------------------------------------
// Page -> stream extraction (Castor's "cast player" path).
// Launches headless Chromium via Playwright (already a project dependency),
// watches network traffic for media URLs, and runs a short action pipeline:
// click the page, navigate into the largest iframe, click again as fallback.
// ---------------------------------------------------------------------------

export const STREAM_RE = /\.(m3u8|mpd|m4v|mp4|mkv|webm|mov|avi|ts)(\?|#|$)/i;
const NOISE_RE = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map)(\?|#|$)/i;

export function isNoiseUrl(url) {
    const u = String(url || "");
    if (u.startsWith("data:") || u.startsWith("blob:")) return true;
    return NOISE_RE.test(u.split("?")[0]);
}

/** Score stream candidates so direct files beat playlists. Higher wins. */
export function scoreCandidate(url) {
    const u = String(url || "").toLowerCase();
    if (isNoiseUrl(u)) return -1;
    if (u.includes(".mp4")) return 100;
    if (u.includes(".m4v")) return 90;
    if (u.includes(".mkv")) return 80;
    if (u.includes(".webm")) return 70;
    if (u.includes(".mov")) return 60;
    if (u.includes(".avi")) return 55;
    if (u.includes(".m3u8")) return 50;
    if (u.includes(".mpd")) return 40;
    if (u.includes(".ts?") || u.endsWith(".ts")) return 20;
    if (/manifest|playlist|\.m3u8|\/hls\//.test(u)) return 30;
    return 10;
}

/** Dedupe + rank collected URLs. Pure function, unit-tested. */
export function rankCandidates(urls) {
    const seen = new Set();
    const scored = [];
    for (const u of urls || []) {
        const url = String(u || "").trim();
        if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        const score = scoreCandidate(url);
        if (score < 0) continue;
        scored.push({ url, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.url);
}

/** Direct stream/video URL (extension-based). Used for auto mode + UI hints. */
export function looksLikeDirectUrl(url) {
    const u = String(url || "");
    if (!/^https?:\/\//i.test(u)) return false;
    return /\.(m4v|mp4|mkv|webm|mov|avi)(\?|#|$)/i.test(u);
}

async function loadPlaywright() {
    try {
        return await import("playwright");
    } catch {
        return null;
    }
}

async function bestEffortDismiss(page) {
    for (const label of ["Reject all", "Accept", "Close", "Not now", "No thanks", "Got it"]) {
        try {
            const btn = page.getByRole("button", { name: label });
            if ((await btn.count()) > 0) {
                await btn.first().click({ timeout: 1500 }).catch(() => {});
                break;
            }
        } catch {}
    }
}

async function clickCenter(page) {
    try {
        await page.evaluate(() => {
            const el = document.body || document.documentElement;
            if (!el) return;
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = Math.min(r.top + 400, r.top + r.height / 2);
            const target = document.elementFromPoint(x, y) || el;
            try {
                target.click();
            } catch {}
        });
    } catch {}
}

/**
 * Find the page URL's real video stream. Returns { url, candidates }.
 * Note: intentionally NOT gated by the browser domain allowlist — the user
 * explicitly points a cast at the page, like Castor's `cast player <url>`.
 */
export async function extractPlayerStream(pageUrl, { timeoutMs = 30000, settings = {} } = {}) {
    const target = String(pageUrl || "").trim();
    if (!/^https?:\/\//i.test(target)) {
        throw new Error(`Not a page URL: ${target}`);
    }
    const pw = await loadPlaywright();
    if (!pw) {
        throw new Error("Playwright is not installed. Run: bun add playwright && bunx playwright install chromium");
    }

    const found = [];
    const note = (u) => {
        if (typeof u === "string" && (STREAM_RE.test(u) || /manifest|playlist/i.test(u))) found.push(u);
    };

    const browser = await pw.chromium.launch({
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required"],
    });
    try {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent:
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        });
        const page = await context.newPage();
        page.on("response", (res) => {
            try {
                const ct = String(res.headers()["content-type"] || "");
                if (/mpegurl|dash\+xml|mp2t|video\//i.test(ct)) note(res.url());
                else note(res.url());
            } catch {}
        });
        page.on("request", (req) => {
            try {
                note(req.url());
            } catch {}
        });

        await page.goto(target, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 30000) });
        await bestEffortDismiss(page);
        await page.waitForTimeout(4000).catch(() => {});
        await clickCenter(page);
        await page.waitForTimeout(3000).catch(() => {});

        // Castor step: navigate into the largest iframe and click again.
        try {
            const frames = page.frames().filter((f) => {
                try {
                    const u = f.url();
                    return u && u !== target && /^https?:\/\//i.test(u);
                } catch {
                    return false;
                }
            });
            if (frames.length > 0) {
                let biggest = frames[0];
                let biggestArea = 0;
                for (const f of frames) {
                    try {
                        const box = await f.frameElement().then((h) => h.boundingBox()).catch(() => null);
                        const area = box ? box.width * box.height : 0;
                        if (area >= biggestArea) {
                            biggestArea = area;
                            biggest = f;
                        }
                    } catch {}
                }
                const frameUrl = biggest.url();
                if (frameUrl && frameUrl !== page.url()) {
                    await page.goto(frameUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
                    await bestEffortDismiss(page);
                    await page.waitForTimeout(2500).catch(() => {});
                    await clickCenter(page);
                    await page.waitForTimeout(2500).catch(() => {});
                }
            }
        } catch {}

        void settings;
        const ranked = rankCandidates(found);
        if (ranked.length === 0) {
            throw new Error(
                "No video stream found on that page (no .mp4/.m3u8/.mpd in network traffic). The site may block automation or require login/DRM — Castor has the same limit."
            );
        }
        return { url: ranked[0], candidates: ranked.slice(0, 8) };
    } finally {
        try {
            await browser.close();
        } catch {}
    }
}

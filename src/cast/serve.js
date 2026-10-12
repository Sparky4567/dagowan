// ---------------------------------------------------------------------------
// Local relay server: the TV fetches the stream from Castor-like relay here.
// Two modes, both pure Bun + ffmpeg binary:
// - proxy:     forwards bytes (with Range support) for direct MP4/MKV URLs.
// - transcode: spawns ffmpeg per request and pipes MPEG-TS for HLS/MPD.
// ---------------------------------------------------------------------------

import os from "node:os";

export function getLanIp() {
    try {
        const ifaces = os.networkInterfaces();
        const candidates = [];
        for (const list of Object.values(ifaces)) {
            for (const nic of list || []) {
                if (!nic || nic.family !== "IPv4" || nic.internal) continue;
                candidates.push(nic.address);
            }
        }
        const rank = (ip) =>
            ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : ip.startsWith("172.") ? 2 : 3;
        candidates.sort((a, b) => rank(a) - rank(b));
        return candidates[0] || "127.0.0.1";
    } catch {
        return "127.0.0.1";
    }
}

function pickPort(settings) {
    const base = Number(settings.cast_port ?? process.env.CAST_PORT ?? 8901);
    return Number.isFinite(base) && base > 0 ? Math.floor(base) : 8901;
}

function buildFfmpegArgs(sourceUrl, settings = {}) {
    const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        "-i",
        String(sourceUrl),
    ];
    const maxHeight = Number(settings.cast_max_height ?? process.env.CAST_MAX_HEIGHT ?? 0);
    const scale = Number.isFinite(maxHeight) && maxHeight > 0
        ? [`scale=-2:min'(${Math.floor(maxHeight)}\\,ih)'`]
        : [];
    return [
        ...args,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        ...(scale.length > 0 ? ["-vf", scale.join(",")] : []),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-f",
        "mpegts",
        "pipe:1",
    ];
}

/**
 * Start the relay on the LAN interface. Returns { server, url, host, port,
 * mode, stop() }. Tries cast_port..cast_port+20 when the port is busy.
 */
export async function startRelayServer({ sourceUrl, mode = "proxy", settings = {}, path = "/stream" } = {}) {
    const host = getLanIp();
    const basePort = pickPort(settings);
    const ffmpegProcs = new Set();
    let lastError = null;

    const handler = async (req) => {
        const url = new URL(req.url);
        if (url.pathname !== path && url.pathname !== "/") {
            return new Response("not found", { status: 404 });
        }
        if (req.method === "HEAD") {
            return new Response(null, {
                status: 200,
                headers: { "Content-Type": mode === "transcode" ? "video/mp2t" : "video/mp4", "Accept-Ranges": mode === "proxy" ? "bytes" : "none" },
            });
        }

        if (mode === "transcode") {
            const proc = Bun.spawn(["ffmpeg", ...buildFfmpegArgs(sourceUrl, settings)], {
                stdout: "pipe",
                stderr: "pipe",
            });
            ffmpegProcs.add(proc);
            proc.exited.then(() => ffmpegProcs.delete(proc)).catch(() => {});
            try {
                req.signal.addEventListener("abort", () => {
                    try {
                        proc.kill();
                    } catch {}
                });
            } catch {}
            return new Response(proc.stdout, {
                status: 200,
                headers: { "Content-Type": "video/mp2t", "Accept-Ranges": "none", "Connection": "close" },
            });
        }

        // proxy mode: forward the (optional) Range header 1:1.
        const headers = {};
        const range = req.headers.get("range");
        if (range) headers["range"] = range;
        const upstream = await fetch(String(sourceUrl), { headers, signal: req.signal }).catch((err) => ({ error: err }));
        if (upstream && upstream.error) {
            return new Response(`relay fetch failed: ${upstream.error.message || upstream.error}`, { status: 502 });
        }
        const outHeaders = {};
        for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
            const v = upstream.headers.get(key);
            if (v) outHeaders[key] = v;
        }
        if (!outHeaders["content-type"]) outHeaders["content-type"] = "video/mp4";
        return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
    };

    for (let port = basePort; port < basePort + 20; port++) {
        try {
            const server = Bun.serve({ hostname: "0.0.0.0", port, fetch: handler });
            return {
                server,
                host,
                port,
                mode,
                url: `http://${host}:${port}${path}`,
                stop() {
                    for (const p of ffmpegProcs) {
                        try {
                            p.kill();
                        } catch {}
                    }
                    ffmpegProcs.clear();
                    try {
                        server.stop(true);
                    } catch {}
                },
            };
        } catch (err) {
            lastError = err;
        }
    }
    throw new Error(`Could not bind relay port ${basePort}..${basePort + 19}: ${lastError ? lastError.message : "busy"}`);
}

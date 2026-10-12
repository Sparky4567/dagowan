// ---------------------------------------------------------------------------
// ffprobe-based source inspection (Bun.spawn, no JS media deps).
// Decides whether a stream can be relayed untouched (stream copy path)
// or must be transcoded for DLNA TVs (typically HLS / MPD sources).
// ---------------------------------------------------------------------------

const DIRECT_EXTS = ["mp4", "m4v", "mkv", "webm", "mov", "avi"];
const TRANSCODE_EXTS = ["m3u8", "mpd"];

export function urlExtension(url) {
    try {
        const path = new URL(String(url)).pathname.toLowerCase();
        const m = path.match(/\.([a-z0-9]{2,4})$/);
        return m ? m[1] : "";
    } catch {
        return "";
    }
}

/** Cheap static check without spawning ffprobe. Returns "direct" | "transcode" | "unknown". */
export function classifyByExtension(url) {
    const ext = urlExtension(url);
    if (DIRECT_EXTS.includes(ext)) return "direct";
    if (TRANSCODE_EXTS.includes(ext)) return "transcode";
    return "unknown";
}

export async function probeStream(url, { timeoutMs = 15000 } = {}) {
    const proc = Bun.spawn(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", String(url)],
        { stdout: "pipe", stderr: "pipe" }
    );
    const killTimer = setTimeout(() => {
        try {
            proc.kill();
        } catch {}
    }, timeoutMs);
    try {
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            throw new Error(`ffprobe failed (exit ${exitCode}): ${String(stderr).trim().slice(0, 300) || "unreadable stream"}`);
        }
        const raw = JSON.parse(stdout || "{}");
        const streams = Array.isArray(raw.streams) ? raw.streams : [];
        const video = streams.find((s) => s.codec_type === "video") || null;
        const audio = streams.find((s) => s.codec_type === "audio") || null;
        const formatName = String((raw.format && raw.format.format_name) || "");
        const duration = Number((raw.format && raw.format.duration) || NaN);
        const isHls = /hls|m3u8|dash|mpd/.test(formatName) || classifyByExtension(url) === "transcode";
        return {
            formatName,
            videoCodec: video ? String(video.codec_name || "") : "",
            audioCodec: audio ? String(audio.codec_name || "") : "",
            width: video ? Number(video.width || 0) : 0,
            height: video ? Number(video.height || 0) : 0,
            duration: Number.isFinite(duration) ? duration : 0,
            isHls,
            raw,
        };
    } finally {
        clearTimeout(killTimer);
    }
}

/**
 * DLNA TVs usually accept H.264/AAC in MP4/MPEG-TS directly. Everything
 * else (HLS playlists, VP9/AV1, MKV with exotic subs) is safer transcoded.
 */
export function needsTranscode(probe, settings = {}) {
    const force = String(settings.cast_transcode ?? process.env.CAST_TRANSCODE ?? "auto").toLowerCase();
    if (["1", "true", "always", "on"].includes(force)) return true;
    if (["0", "false", "never", "off"].includes(force)) return false;
    if (!probe) return false;
    if (probe.isHls) return true;
    const v = String(probe.videoCodec || "").toLowerCase();
    if (v && !["h264", "mpeg4", "hevc", "h265", "mpeg2video", "mjpeg"].includes(v)) return true;
    const f = String(probe.formatName || "").toLowerCase();
    if (f && !/mp4|mov|matroska|avi|mpegts|mpeg|webm/.test(f)) return true;
    return false;
}

/** MIME advertised to the TV in DIDL-Lite metadata. */
export function mimeForMode(mode) {
    return mode === "transcode" ? "video/vnd.dlna.mpeg-tts" : "video/mp4";
}

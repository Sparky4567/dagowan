// ---------------------------------------------------------------------------
// Bun Cast orchestrator (Castor equivalent): scan -> extract -> probe ->
// relay -> cast. Targets both DLNA renderers (SOAP) and Chromecast /
// Android TV (CastV2 media + DIAL YouTube launches). Single in-process cast
// session, shared by the CLI (@commands), Telegram, and WhatsApp surfaces.
// Only Bun + JavaScript + the ffmpeg/ffprobe + Chromium binaries.
// ---------------------------------------------------------------------------

import {
    discoverDlnaDevices,
    dlnaCast,
    dlnaResume,
    dlnaPause,
    dlnaStop,
    dlnaTransportState,
    formatScanResults,
    resolveTargetDevice as resolveDlnaDevice,
} from "./dlna.js";
import { classifyByExtension, mimeForMode, needsTranscode, probeStream } from "./probe.js";
import { startRelayServer } from "./serve.js";
import { extractPlayerStream, looksLikeDirectUrl } from "./extract.js";
import { discoverGoogleCast } from "./mdns.js";
import {
    dialAppState,
    dialPlayYoutube,
    dialStopApp,
    discoverDialDevices,
    probeCastHost,
} from "./dial.js";
import {
    castLoadMedia,
    castMediaCommand,
    castMediaStatus,
    castStopApp,
    extractYoutubeVideoId,
    isYoutubeUrl,
    parseYoutubeStartTime,
} from "./castv2.js";

const state = {
    active: false,
    device: null, // { kind: 'dlna'|'chromecast', name, host, ... }
    pageUrl: "",
    sourceUrl: "",
    localUrl: "",
    title: "",
    mode: "",
    ytVideoId: "",
    startedAt: 0,
    relay: null,
};

export function getCastState() {
    return { ...state, relay: undefined };
}

export function isCasting() {
    return state.active;
}

export const CAST_USAGE = [
    "📺 Bun Cast — stream to your TV (Castor-style, Bun-only):",
    "• @cast-scan — list TVs/renderers on your LAN (DLNA + Chromecast)",
    "• @cast <url> — auto: direct video URL casts as-is, page URL is extracted first",
    "• @cast <youtube-url> — plays in the TV's native YouTube app (needs Chromecast target)",
    "• @cast-url <url> — cast a direct stream/video URL (.mp4, .mkv, .m3u8, …)",
    "• @cast-player <page-url> — extract the video from a web page, then cast",
    "• @cast-pause / @cast-play — pause / resume playback on the TV",
    "• @cast-status — show current cast session + TV state",
    "• @cast-stop — stop playback and shut down the relay",
    "• @set-cast-device <name|ip|description-url> — select/pin the target TV",
    "💡 No TV found? @set-cast-device 192.168.0.3 pins by IP (unicast, no multicast needed).",
    "💡 YouTube needs a Chromecast/Android TV target — DLNA TVs can't play YouTube URLs.",
].join("\n");

/**
 * Shared parser so CLI / Telegram / WhatsApp behave identically.
 * Accepts "@" or "/" prefixes. Returns null when the text is not a cast
 * command, otherwise { action, arg }.
 */
export function parseCastInput(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const input = raw.startsWith("@") ? "/" + raw.slice(1) : raw;
    const lower = input.toLowerCase();

    if (lower === "/cast-scan" || lower === "/scan-tv" || lower === "/cast-devices") {
        return { action: "scan", arg: "" };
    }
    if (lower === "/cast status" || lower === "/cast-status") return { action: "status", arg: "" };
    if (lower === "/cast stop" || lower === "/cast-stop" || lower === "/stop-cast") {
        return { action: "stop", arg: "" };
    }
    if (lower === "/cast pause" || lower === "/cast-pause") return { action: "pause", arg: "" };
    if (lower === "/cast play" || lower === "/cast-play" || lower === "/cast-resume") {
        return { action: "resume", arg: "" };
    }
    if (lower.startsWith("/set-cast-device")) {
        return { action: "device", arg: input.slice("/set-cast-device".length).trim() };
    }
    if (lower === "/cast-device" || lower.startsWith("/cast-device ")) {
        return { action: "device", arg: input.slice("/cast-device".length).trim() };
    }
    if (lower === "/cast" || lower.startsWith("/cast ")) {
        const rest = input.slice("/cast".length).trim();
        if (!rest) return { action: "help", arg: "" };
        const [sub, ...tail] = rest.split(/\s+/);
        const subLower = String(sub).toLowerCase();
        if (["scan", "devices", "list"].includes(subLower)) return { action: "scan", arg: "" };
        if (subLower === "status") return { action: "status", arg: "" };
        if (subLower === "stop") return { action: "stop", arg: "" };
        if (subLower === "pause") return { action: "pause", arg: "" };
        if (["play", "resume"].includes(subLower)) {
            return tail.length > 0
                ? { action: "auto", arg: tail.join(" ") }
                : { action: "resume", arg: "" };
        }
        if (subLower === "url") return { action: "url", arg: tail.join(" ") };
        if (subLower === "player" || subLower === "page") return { action: "player", arg: tail.join(" ") };
        if (subLower === "device") return { action: "device", arg: tail.join(" ") };
        return { action: "auto", arg: rest };
    }
    if (lower === "/cast-url" || lower.startsWith("/cast-url ")) {
        return { action: "url", arg: input.slice("/cast-url".length).trim() };
    }
    if (lower === "/cast-player" || lower.startsWith("/cast-player ")) {
        return { action: "player", arg: input.slice("/cast-player".length).trim() };
    }
    return null;
}

function looksLikeIpOrHost(value) {
    return /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(value) || /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/i.test(value);
}

/** Persist target-TV selection into settings. Returns the reply line. */
export function setCastDevice(settings, value) {
    const v = String(value || "").trim();
    if (!v) {
        const name = settings.cast_device_name || "(none)";
        const host = settings.cast_device_host || "(auto discovery)";
        const type = settings.cast_device_type || "auto";
        return `📺 Cast target: name=${name} host=${host} type=${type}\n💡 Usage: @set-cast-device <exact TV name|IP|description-url>`;
    }
    if (/^https?:\/\//i.test(v)) {
        settings.cast_device_host = v;
        return `📺 Cast target pinned to description URL:\n${v}`;
    }
    if (looksLikeIpOrHost(v) && /[0-9]/.test(v) && !v.includes(" ")) {
        settings.cast_device_host = v;
        return `📺 Cast target pinned to host ${v} (unicast discovery, skips multicast).`;
    }
    settings.cast_device_name = v;
    settings.cast_device_host = "";
    return `📺 Cast target set to "${v}" (matched by substring against scan results).`;
}

/** Merge DIAL + mDNS discoveries by host IP into one Chromecast list. */
export function mergeCastDevices(dialDevices, mdnsDevices) {
    const byHost = new Map();
    for (const d of dialDevices || []) {
        if (!d.host) continue;
        byHost.set(d.host, {
            kind: "chromecast",
            name: d.name || d.host,
            host: d.host,
            port: 8009,
            model: d.model || "",
            sources: ["dial"],
        });
    }
    for (const d of mdnsDevices || []) {
        if (!d.host) continue;
        const existing = byHost.get(d.host);
        if (existing) {
            if (d.name && (!existing.name || /chromecast device/i.test(existing.name))) existing.name = d.name;
            if (d.model) existing.model = d.model;
            existing.sources.push("mdns");
        } else {
            byHost.set(d.host, {
                kind: "chromecast",
                name: d.name || d.host,
                host: d.host,
                port: d.port || 8009,
                model: d.model || "",
                sources: ["mdns"],
            });
        }
    }
    return [...byHost.values()];
}

export function matchDeviceByName(devices, name) {
    const needle = String(name || "").trim().toLowerCase();
    if (!needle) return null;
    return devices.find((d) => String(d.name || "").toLowerCase().includes(needle)) || null;
}

function castType(settings) {
    const t = String(settings.cast_device_type ?? process.env.CAST_DEVICE_TYPE ?? "auto").toLowerCase();
    return ["dlna", "chromecast", "cast"].includes(t) ? (t === "cast" ? "chromecast" : t) : "auto";
}

/**
 * Resolve the configured target across both protocols.
 * - description URL host -> DLNA description fetch (existing behavior).
 * - bare IP/hostname -> probe CastV2 + DIAL first, DLNA unicast as fallback.
 * - otherwise parallel discovery; `prefer: 'chromecast'` for YouTube URLs.
 */
export async function resolveTargetDevice(settings = {}, { timeoutMs = 4000, prefer = "" } = {}) {
    const hostRaw = String(settings.cast_device_host || process.env.CAST_DEVICE_HOST || "").trim();
    const nameRaw = String(settings.cast_device_name || process.env.CAST_DEVICE_NAME || "").trim();
    const type = castType(settings);

    if (/^https?:\/\//i.test(hostRaw)) {
        if (type === "chromecast") throw new Error("A description URL only applies to DLNA targets; clear it with @set-cast-device <ip-or-name> to use Chromecast.");
        return resolveDlnaDevice(settings, { timeoutMs });
    }

    if (hostRaw) {
        const probe = await probeCastHost(hostRaw, { timeoutMs });
        if (type !== "dlna" && (probe.cast || probe.dial)) {
            return {
                kind: "chromecast",
                name: (probe.dial && probe.dial.name) || hostRaw,
                host: probe.host,
                port: 8009,
                model: (probe.dial && probe.dial.model) || "",
                sources: ["pin"],
            };
        }
        if (type !== "chromecast") {
            try {
                return await resolveDlnaDevice(settings, { timeoutMs });
            } catch (err) {
                if (probe.cast || probe.dial) {
                    return {
                        kind: "chromecast",
                        name: (probe.dial && probe.dial.name) || hostRaw,
                        host: probe.host,
                        port: 8009,
                        model: "",
                        sources: ["pin"],
                    };
                }
                throw err;
            }
        }
        throw new Error(`No Chromecast answered at ${hostRaw} (tried Cast :8009 + DIAL :8008). Is it powered on and on the same network?`);
    }

    const [dlnaRes, dialRes, mdnsRes] = await Promise.allSettled([
        type === "chromecast" ? [] : discoverDlnaDevices({ timeoutMs }),
        type === "dlna" ? [] : discoverDialDevices({ timeoutMs }),
        type === "dlna" ? [] : discoverGoogleCast({ timeoutMs }),
    ]);
    const dlna = dlnaRes.status === "fulfilled" ? dlnaRes.value : [];
    const chromecast = mergeCastDevices(
        dialRes.status === "fulfilled" ? dialRes.value : [],
        mdnsRes.status === "fulfilled" ? mdnsRes.value : []
    );

    if (prefer === "chromecast" || type === "chromecast") {
        const match = matchDeviceByName(chromecast, nameRaw) || (nameRaw ? null : chromecast[0]);
        if (!match) {
            if (nameRaw) throw new Error(`No Chromecast matches "${nameRaw}". Run @cast-scan to list Chromecast targets.`);
            throw new Error("No Chromecast found. If discovery is blocked, pin it: @set-cast-device <tv-ip>.");
        }
        return match;
    }

    const pool = type === "dlna" ? dlna : [...chromecast, ...dlna];
    if (nameRaw) {
        const match = matchDeviceByName(pool, nameRaw);
        if (!match) {
            const names = pool.map((d) => `"${d.name}" (${d.kind})`).join(", ") || "none found";
            throw new Error(`No cast target matches "${nameRaw}". Found: ${names}.`);
        }
        return match;
    }
    if (pool.length === 0) {
        throw new Error(
            "No cast targets found (DLNA or Chromecast). Pin the TV with @set-cast-device <tv-ip>."
        );
    }
    if (pool.length === 1) return pool[0];
    const names = pool.map((d) => `"${d.name}" (${d.kind})`).join(", ");
    throw new Error(`Multiple targets found: ${names}. Pick one with @set-cast-device <name>.`);
}

export function formatCombinedScan({ dlna = [], chromecast = [] }) {
    const sections = [];
    if (chromecast.length > 0) {
        const lines = chromecast.map(
            (d, i) => `  ${i + 1}. "${d.name}" @ ${d.host}${d.model ? ` (${d.model})` : ""}`
        );
        sections.push(`📺 Chromecast / Android TV (${chromecast.length}):\n${lines.join("\n")}`);
    }
    sections.push(formatScanResults(dlna));
    if (chromecast.length === 0 && dlna.length === 0) return sections.join("\n");
    return `${sections.join("\n")}\n💡 Select one: @set-cast-device <exact name> or @set-cast-device <ip>`;
}

export async function scanDevices(settings = {}) {
    const timeoutMs = Number(settings.cast_scan_timeout_ms ?? 4000);
    const hostRaw = String(settings.cast_device_host || "").trim();
    if (hostRaw && !/^https?:\/\//i.test(hostRaw)) {
        const probe = await probeCastHost(hostRaw, { timeoutMs });
        const chromecast = [];
        if (probe.cast || probe.dial) {
            chromecast.push({
                kind: "chromecast",
                name: (probe.dial && probe.dial.name) || hostRaw,
                host: probe.host,
                port: 8009,
                model: (probe.dial && probe.dial.model) || "",
                sources: ["pin"],
            });
        }
        const dlna = await discoverDlnaDevices({ timeoutMs, unicastHost: hostRaw }).catch(() => []);
        return { dlna, chromecast };
    }
    const [dlnaRes, dialRes, mdnsRes] = await Promise.allSettled([
        discoverDlnaDevices({ timeoutMs }),
        discoverDialDevices({ timeoutMs }),
        discoverGoogleCast({ timeoutMs }),
    ]);
    return {
        dlna: dlnaRes.status === "fulfilled" ? dlnaRes.value : [],
        chromecast: mergeCastDevices(
            dialRes.status === "fulfilled" ? dialRes.value : [],
            mdnsRes.status === "fulfilled" ? mdnsRes.value : []
        ),
    };
}

async function stopPreviousQuiet() {
    await stopCast({ quiet: true }).catch(() => {});
}

function markActive({ device, mode, title, sourceUrl, localUrl, pageUrl = "", ytVideoId = "", relay = null }) {
    Object.assign(state, {
        active: true,
        device: { kind: device.kind || "dlna", name: device.name, host: device.host, location: device.location || "" },
        sourceUrl,
        localUrl,
        pageUrl,
        title,
        mode,
        ytVideoId,
        startedAt: Date.now(),
        relay,
    });
}

/** DLNA path: relay (proxy or ffmpeg transcode) + SetAVTransportURI + Play. */
async function startDlnaRelay({ device, sourceUrl, title, settings }) {
    let mode = classifyByExtension(sourceUrl);
    if (mode === "unknown" || mode === "direct") {
        try {
            const probe = await probeStream(sourceUrl);
            mode = needsTranscode(probe, settings) ? "transcode" : "direct";
        } catch {
            if (mode === "unknown") mode = "direct";
        }
    }
    const relayMode = mode === "transcode" ? "transcode" : "proxy";
    const relay = await startRelayServer({ sourceUrl, mode: relayMode, settings });
    const mime = mimeForMode(relayMode === "transcode" ? "transcode" : "direct");
    await dlnaCast(device, relay.url, { title, mime });
    markActive({ device, mode: relayMode, title, sourceUrl, localUrl: relay.url, relay });
    return { device, relay, mode: relayMode };
}

/** Chromecast path for direct media: DMR LOAD (native HLS, relayed files). */
async function startChromecastMedia({ device, sourceUrl, title, settings }) {
    const ext = classifyByExtension(sourceUrl);
    if (ext === "transcode") {
        // Chromecast plays HLS/DASH natively — pass the original playlist URL.
        const isDash = /mpd(\?|#|$)/i.test(sourceUrl);
        const { media } = await castLoadMedia(device.host, {
            contentId: sourceUrl,
            contentType: isDash ? "application/dash+xml" : "application/x-mpegurl",
            streamType: "BUFFERED",
            port: device.port || 8009,
        });
        markActive({ device, mode: "chromecast-media", title, sourceUrl, localUrl: sourceUrl });
        return { device, relay: null, mode: "chromecast-media", media };
    }
    // Files go through our relay (guaranteed Range support for seeking).
    let relayMode = "proxy";
    try {
        const probe = await probeStream(sourceUrl);
        if (needsTranscode(probe, settings)) relayMode = "transcode";
    } catch {}
    const relay = await startRelayServer({ sourceUrl, mode: relayMode, settings });
    try {
        const { media } = await castLoadMedia(device.host, {
            contentId: relay.url,
            contentType: relayMode === "transcode" ? "video/mp2t" : "video/mp4",
            streamType: "BUFFERED",
            port: device.port || 8009,
        });
        markActive({ device, mode: "chromecast-media", title, sourceUrl, localUrl: relay.url, relay });
        return { device, relay, mode: "chromecast-media", media };
    } catch (err) {
        try {
            relay.stop();
        } catch {}
        throw err;
    }
}

/** Route one stream URL to whichever protocol the target speaks. */
async function castStreamUrl(sourceUrl, settings, { title } = {}) {
    await stopPreviousQuiet();
    const device = await resolveTargetDevice(settings);
    const name = title || urlExtensionTitle(sourceUrl);
    if (device.kind === "chromecast") {
        return startChromecastMedia({ device, sourceUrl, title: name, settings });
    }
    return startDlnaRelay({ device, sourceUrl, title: name, settings });
}

/** Cast a direct stream/video URL (Castor's `cast url`). */
export async function castDirectUrl(mediaUrl, settings = {}, { title } = {}) {
    const url = String(mediaUrl || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(`Not a stream URL: ${url || "(empty)"}`);
    if (isYoutubeUrl(url)) {
        throw new Error("That is a YouTube page, not a direct stream. Use @cast <youtube-url> (needs a Chromecast target) or @cast-player for regular video pages.");
    }
    return castStreamUrl(url, settings, { title });
}

/** Extract-then-cast a web page (Castor's `cast player`). */
export async function castPlayerPage(pageUrl, settings = {}, { title } = {}) {
    const page = String(pageUrl || "").trim();
    if (!/^https?:\/\//i.test(page)) throw new Error(`Not a page URL: ${page || "(empty)"}`);
    if (isYoutubeUrl(page)) {
        return castYoutubeUrl(page, settings);
    }
    const found = await extractPlayerStream(page, { settings });
    const res = await castStreamUrl(found.url, settings, { title: title || page });
    state.pageUrl = page;
    return { ...res, extractedUrl: found.url, candidates: found.candidates };
}

/** YouTube URL -> native YouTube app on a Chromecast target (DIAL launch). */
export async function castYoutubeUrl(pageUrl, settings = {}) {
    const videoId = extractYoutubeVideoId(pageUrl);
    if (!videoId) throw new Error(`Could not find a YouTube video ID in: ${pageUrl}`);
    const startSeconds = parseYoutubeStartTime(pageUrl);
    await stopPreviousQuiet();
    const device = await resolveTargetDevice(settings, { prefer: "chromecast" });
    if (device.kind !== "chromecast") {
        throw new Error(`"${device.name}" is a DLNA target, which cannot play YouTube URLs. Select a Chromecast/Android TV with @set-cast-device <name>.`);
    }
    await dialPlayYoutube(device.host, videoId, { startSeconds });
    markActive({
        device,
        mode: "chromecast-youtube",
        title: `YouTube ${videoId}`,
        sourceUrl: String(pageUrl),
        localUrl: "",
        ytVideoId: videoId,
    });
    return { device, videoId, startSeconds, mode: "chromecast-youtube" };
}

function urlExtensionTitle(url) {
    try {
        const u = new URL(String(url));
        const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
        return decodeURIComponent(last).slice(0, 80) || "Bun Cast";
    } catch {
        return "Bun Cast";
    }
}

export async function stopCast({ quiet = false } = {}) {
    const was = state.active;
    const kind = state.device?.kind || "dlna";
    if (was && !quiet && state.device) {
        try {
            if (kind === "chromecast") {
                if (state.mode === "chromecast-youtube") await dialStopApp(state.device.host);
                else await castStopApp(state.device.host).catch(() => null);
            } else {
                await dlnaStop(state.device);
            }
        } catch {}
    }
    try {
        if (state.relay) state.relay.stop();
    } catch {}
    Object.assign(state, {
        active: false,
        device: null,
        pageUrl: "",
        sourceUrl: "",
        localUrl: "",
        title: "",
        mode: "",
        ytVideoId: "",
        startedAt: 0,
        relay: null,
    });
    return { stopped: was };
}

export async function castStatus() {
    if (!state.active || !state.device) {
        return { active: false, reply: "📺 No active cast session. Start one with @cast <url>." };
    }
    const kind = state.device.kind || "dlna";
    const mins = Math.max(0, Math.round((Date.now() - state.startedAt) / 60000));
    if (kind === "chromecast") {
        let extra = "";
        try {
            if (state.mode === "chromecast-youtube") {
                const yt = await dialAppState(state.device.host, "YouTube", { timeoutMs: 4000 });
                extra = `YouTube app: ${yt}`;
            } else {
                const { media } = await castMediaStatus(state.device.host, { timeoutMs: 5000 });
                extra = media ? `${media.playerState} @ ${Math.round(media.currentTime)}s` : "receiver idle";
            }
        } catch {
            extra = "TV unreachable right now";
        }
        const reply = [
            `📺 Casting "${state.title}" (${state.mode})`,
            `TV: "${state.device.name}" @ ${state.device.host} — ${extra}`,
            state.pageUrl ? `Page: ${state.pageUrl}` : `Source: ${state.sourceUrl}`,
            ...(state.localUrl && state.localUrl !== state.sourceUrl ? [`Relay: ${state.localUrl} (${mins}m ago)`] : [`Started ${mins}m ago`]),
        ].join("\n");
        return { active: true, transport: extra, reply };
    }
    const transport = await dlnaTransportState(state.device).catch(() => "unknown");
    const reply = [
        `📺 Casting "${state.title}" (${state.mode})`,
        `TV: "${state.device.name}"${state.device.host ? ` @ ${state.device.host}` : ""} — ${transport}`,
        state.pageUrl ? `Page: ${state.pageUrl}` : `Source: ${state.sourceUrl}`,
        `Relay: ${state.localUrl} (${mins}m ago)`,
    ].join("\n");
    return { active: true, transport, reply };
}

/**
 * Single entry point for all surfaces. Mutates `settings` for device
 * selection (caller persists via saveSettings when settingsChanged).
 * Always returns { handled, reply, settingsChanged? }.
 */
export async function runCastCommand(rawInput, settings = {}) {
    const parsed = parseCastInput(rawInput);
    if (!parsed) return { handled: false };
    const arg = String(parsed.arg || "").trim();

    if (parsed.action === "help") return { handled: true, reply: CAST_USAGE };

    if (parsed.action === "scan") {
        const found = await scanDevices(settings);
        return { handled: true, reply: formatCombinedScan(found) };
    }

    if (parsed.action === "status") {
        const st = await castStatus();
        return { handled: true, reply: st.reply };
    }

    if (parsed.action === "stop") {
        const res = await stopCast();
        return {
            handled: true,
            reply: res.stopped ? "⏹ Cast stopped and relay shut down." : "📺 No active cast session.",
        };
    }

    if (parsed.action === "device") {
        const reply = setCastDevice(settings, arg);
        return { handled: true, reply, settingsChanged: true };
    }

    if (parsed.action === "pause") {
        if (!state.active || !state.device) return { handled: true, reply: "📺 No active cast session." };
        if (state.device.kind === "chromecast") {
            if (state.mode === "chromecast-youtube") {
                return { handled: true, reply: "⏸ The YouTube app has no remote-pause here — use the TV remote." };
            }
            await castMediaCommand(state.device.host, "PAUSE");
            return { handled: true, reply: "⏸ Paused on TV (@cast-play to resume)." };
        }
        await dlnaPause(state.device);
        return { handled: true, reply: "⏸ Paused on TV (@cast-play to resume)." };
    }

    if (parsed.action === "resume") {
        if (!state.active || !state.device) return { handled: true, reply: "📺 No active cast session." };
        if (state.device.kind === "chromecast") {
            if (state.mode === "chromecast-youtube") {
                return { handled: true, reply: "▶️ The YouTube app has no remote-resume here — use the TV remote." };
            }
            await castMediaCommand(state.device.host, "PLAY");
            return { handled: true, reply: "▶️ Resumed on TV." };
        }
        await dlnaResume(state.device);
        return { handled: true, reply: "▶️ Resumed on TV." };
    }

    if (parsed.action === "url") {
        if (!arg) return { handled: true, reply: "⚠️ Usage: @cast-url <direct stream/video URL>" };
        const res = await castDirectUrl(arg, settings);
        const via = res.mode === "transcode" ? " (transcoding for TV)" : res.mode === "chromecast-media" ? " (Chromecast)" : "";
        const relayLine = res.relay ? `\n📡 Relay: ${res.relay.url}` : "";
        return { handled: true, reply: `📺 Casting${via} to "${res.device.name}":\n🔗 ${arg}${relayLine}` };
    }

    if (parsed.action === "player") {
        if (!arg) return { handled: true, reply: "⚠️ Usage: @cast-player <page URL with an embedded video>" };
        const res = await castPlayerPage(arg, settings);
        if (res.mode === "chromecast-youtube") {
            return { handled: true, reply: `📺 Playing in the TV's YouTube app on "${res.device.name}":\n🎬 ${res.videoId}` };
        }
        const via = res.mode === "transcode" ? " (transcoding for TV)" : res.mode === "chromecast-media" ? " (Chromecast)" : "";
        const relayLine = res.relay ? `\n📡 Relay: ${res.relay.url}` : "";
        return { handled: true, reply: `📺 Extracted stream and casting${via} to "${res.device.name}":\n🎬 ${res.extractedUrl}${relayLine}` };
    }

    // auto: YouTube URLs go to the native app; direct-looking URLs skip
    // extraction; other pages go through the extractor.
    if (parsed.action === "auto") {
        if (!arg) return { handled: true, reply: CAST_USAGE };
        const firstToken = arg.split(/\s+/)[0];
        if (!/^https?:\/\//i.test(firstToken)) {
            return { handled: true, reply: `⚠️ @cast needs a URL.\n${CAST_USAGE}` };
        }
        if (isYoutubeUrl(firstToken)) {
            const res = await castYoutubeUrl(firstToken, settings);
            const at = res.startSeconds > 0 ? ` (from ${res.startSeconds}s)` : "";
            return { handled: true, reply: `📺 Playing in the TV's YouTube app on "${res.device.name}":\n🎬 ${res.videoId}${at}` };
        }
        if (looksLikeDirectUrl(firstToken) || classifyByExtension(firstToken) === "transcode") {
            const res = await castDirectUrl(firstToken, settings);
            const via = res.mode === "transcode" ? " (transcoding for TV)" : res.mode === "chromecast-media" ? " (Chromecast)" : "";
            const relayLine = res.relay ? `\n📡 Relay: ${res.relay.url}` : "";
            return { handled: true, reply: `📺 Casting${via} to "${res.device.name}":\n🔗 ${firstToken}${relayLine}` };
        }
        const res = await castPlayerPage(firstToken, settings);
        const via = res.mode === "transcode" ? " (transcoding for TV)" : res.mode === "chromecast-media" ? " (Chromecast)" : "";
        const relayLine = res.relay ? `\n📡 Relay: ${res.relay.url}` : "";
        return { handled: true, reply: `📺 Extracted stream and casting${via} to "${res.device.name}":\n🎬 ${res.extractedUrl}${relayLine}` };
    }

    return { handled: false };
}

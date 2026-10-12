// ---------------------------------------------------------------------------
// DIAL (Discovery And Launch) for Chromecast / Android TV, pure Bun + JS.
// Used for reliable YouTube launches: POST <apps>/YouTube?v=<videoId>
// plays the video in the TV's native YouTube app — no stream ripping.
// Discovery reuses SSDP (same socket pattern as DLNA): DIAL devices answer
// ST urn:dial-multiscreen-org:service:dial:1 with an Application-URL header.
// ---------------------------------------------------------------------------

import { buildMSearch, parseSsdpResponse, SSDP_MULTICAST_ADDR, SSDP_PORT } from "./dlna.js";

export const DIAL_ST = "urn:dial-multiscreen-org:service:dial:1";
export const DIAL_PORT = 8008;

export function appsUrlFromLocation(location, appUrlHeader = "") {
    if (appUrlHeader) return String(appUrlHeader).replace(/\/+$/, "");
    try {
        const u = new URL(String(location));
        const dir = u.pathname.split("/").slice(0, -1).join("/") || "";
        return `${u.protocol}//${u.host}${dir}/apps`.replace(/\/+$/, "");
    } catch {
        return "";
    }
}

/** Parse a DIAL device description (dd.xml) for name/model. */
export function parseDialDescription(xml) {
    const doc = String(xml || "");
    const pick = (tag) => {
        const m = doc.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
        return (m ? m[1] : "").trim();
    };
    return {
        name: pick("friendlyName") || "Chromecast device",
        manufacturer: pick("manufacturer"),
        model: pick("modelName"),
    };
}

async function fetchDialDescription(location, timeoutMs = 6000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(location, { signal: ctrl.signal });
        if (!res.ok) return null;
        const xml = await res.text();
        const info = parseDialDescription(xml);
        let host = "";
        try {
            host = new URL(location).hostname;
        } catch {}
        const appUrlHeader = res.headers.get("application-url") || "";
        return { ...info, location, host, appsUrl: appsUrlFromLocation(location, appUrlHeader) };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Discover DIAL devices (Chromecast, Android TV, Roku, Fire TV) via SSDP. */
export async function discoverDialDevices({ timeoutMs = 4000 } = {}) {
    const { default: dgram } = await import("node:dgram");
    const socket = dgram.createSocket("udp4");
    await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(0, () => {
            socket.removeListener("error", reject);
            resolve();
        });
    });
    try {
        const msg = Buffer.from(buildMSearch(DIAL_ST));
        await new Promise((resolve, reject) => {
            socket.send(msg, 0, msg.length, SSDP_PORT, SSDP_MULTICAST_ADDR, (err) => (err ? reject(err) : resolve()));
        });
        const seen = new Map();
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                socket.removeAllListeners("message");
                resolve();
            }, timeoutMs);
            socket.on("message", (m, rinfo) => {
                try {
                    const parsed = parseSsdpResponse(m.toString("utf8"));
                    if (parsed.location && !seen.has(parsed.location)) {
                        seen.set(parsed.location, { ...parsed, from: rinfo?.address || "" });
                    }
                } catch {}
                void timer;
            });
        });
        const devices = [];
        for (const [location, info] of seen) {
            const desc = await fetchDialDescription(location);
            if (desc) devices.push({ ...desc, st: info.st, usn: info.usn });
        }
        return devices;
    } finally {
        try {
            socket.close();
        } catch {}
    }
}

/**
 * Probe a pinned host for DIAL (GET dd.xml on :8008) and CastV2 (:8009).
 * Returns { dial, cast } booleans — never throws.
 */
export async function probeCastHost(host, { timeoutMs = 4000 } = {}) {
    const clean = String(host || "").replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
    const out = { host: clean, dial: null, cast: false };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`http://${clean}:${DIAL_PORT}/ssdp/device-desc.xml`, { signal: ctrl.signal }).catch(() => null);
        if (res && res.ok) {
            const xml = await res.text();
            out.dial = { ...parseDialDescription(xml), host: clean, appsUrl: `http://${clean}:${DIAL_PORT}/apps` };
        }
    } catch {}
    clearTimeout(timer);
    try {
        const { castReceiverStatus } = await import("./castv2.js");
        await castReceiverStatus(clean, { timeoutMs });
        out.cast = true;
    } catch {}
    return out;
}

function dialAppUrl(host, app = "YouTube") {
    return `http://${host}:${DIAL_PORT}/apps/${app}`;
}

/** DIAL app state: "running" | "stopped" | "unknown". */
export async function dialAppState(host, app = "YouTube", { timeoutMs = 6000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(dialAppUrl(host, app), { signal: ctrl.signal });
        if (!res.ok) return "unknown";
        const xml = await res.text();
        const m = xml.match(/<state>([\s\S]*?)<\/state>/i);
        return (m ? m[1] : "unknown").trim().toLowerCase() || "unknown";
    } catch {
        return "unknown";
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Launch + play a YouTube video on the TV's native app.
 * Sends v (video id) and t (start seconds) as query params and POST body —
 * the YouTube DIAL implementation reads both forms across firmware versions.
 */
export async function dialPlayYoutube(host, videoId, { startSeconds = 0, timeoutMs = 10000 } = {}) {
    const params = new URLSearchParams({ v: String(videoId) });
    if (Number(startSeconds) > 0) params.set("t", String(Math.floor(Number(startSeconds))));
    const query = params.toString();
    const url = `${dialAppUrl(host, "YouTube")}?${query}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: "POST",
            signal: ctrl.signal,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: query,
        });
        if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
            const text = await res.text().catch(() => "");
            throw new Error(`DIAL YouTube launch failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
        }
        return { host, videoId, runUrl: res.headers.get("location") || "" };
    } finally {
        clearTimeout(timer);
    }
}

/** Stop the YouTube app via DIAL. Best-effort, never throws. */
export async function dialStopApp(host, app = "YouTube", { timeoutMs = 6000 } = {}) {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            await fetch(dialAppUrl(host, app), { method: "DELETE", signal: ctrl.signal }).catch(() => null);
        } finally {
            clearTimeout(timer);
        }
    } catch {}
    return { stopped: true };
}

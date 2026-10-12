// ---------------------------------------------------------------------------
// DLNA / UPnP MediaRenderer control over plain Bun + JavaScript.
//
// No native dependencies: SSDP discovery uses node:dgram (UDP multicast or
// unicast), device descriptions are fetched with global fetch(), and
// AVTransport actions are plain SOAP POSTs. Mirrors the DLNA path of
// https://github.com/stupside/castor (scan -> SetAVTransportURI -> Play).
// ---------------------------------------------------------------------------

export const SSDP_MULTICAST_ADDR = "239.255.255.250";
export const SSDP_PORT = 1900;
export const MEDIA_RENDERER_ST = "urn:schemas-upnp-org:device:MediaRenderer:1";
export const AVTRANSPORT_SERVICE = "urn:schemas-upnp-org:service:AVTransport:1";

export function buildMSearch(st = MEDIA_RENDERER_ST, mx = 3) {
    return (
        "M-SEARCH * HTTP/1.1\r\n" +
        `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ns=01; ns=01"\r\n' +
        `MX: ${mx}\r\n` +
        `ST: ${st}\r\n` +
        "USER-AGENT: bun-cast/1.0 UPnP/1.0\r\n" +
        "\r\n"
    );
}

/** Parse a raw SSDP response datagram into a lowercase-header map. */
export function parseSsdpResponse(text) {
    const headers = {};
    const lines = String(text || "").split("\r\n");
    for (const line of lines.slice(1)) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim();
        if (key) headers[key] = val;
    }
    return {
        statusLine: lines[0] || "",
        headers,
        location: headers["location"] || "",
        st: headers["st"] || "",
        usn: headers["usn"] || "",
    };
}

/** Escape text for embedding in SOAP / DIDL-Lite XML. */
export function escapeXml(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/**
 * Minimal DIDL-Lite metadata document pointing at the relayed stream.
 * TVs that ignore metadata still play from the URI set alongside it.
 */
export function buildDidlLite(mediaUrl, title = "Bun Cast", mime = "video/mp4") {
    const safeUrl = escapeXml(mediaUrl);
    const safeTitle = escapeXml(title);
    const safeMime = escapeXml(mime);
    return (
        `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
        `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
        `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">` +
        `<item id="0" parentID="0" restricted="1">` +
        `<dc:title>${safeTitle}</dc:title>` +
        `<upnp:class>object.item.videoItem</upnp:class>` +
        `<res protocolInfo="http-get:*:${safeMime}:*">${safeUrl}</res>` +
        `</item></DIDL-Lite>`
    );
}

function resolveUrl(base, ref) {
    try {
        return new URL(ref, base).toString();
    } catch {
        return ref;
    }
}

/**
 * Pull friendlyName + AVTransport controlURL out of a device description
 * document with regexes (no XML dependency). Returns null when the
 * document has no AVTransport service.
 */
export function parseDeviceDescription(xml, locationUrl) {
    const doc = String(xml || "");
    const nameMatch = doc.match(/<friendlyName>([\s\S]*?)<\/friendlyName>/i);
    const name = (nameMatch ? nameMatch[1] : "").trim() || "Unknown DLNA device";
    const services = [...doc.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => m[1]);
    for (const svc of services) {
        const typeMatch = svc.match(/<serviceType>([\s\S]*?)<\/serviceType>/i);
        const type = (typeMatch ? typeMatch[1] : "").trim();
        if (!type.includes("AVTransport")) continue;
        const ctrlMatch = svc.match(/<controlURL>([\s\S]*?)<\/controlURL>/i);
        const eventMatch = svc.match(/<eventSubURL>([\s\S]*?)<\/eventSubURL>/i);
        const controlPath = (ctrlMatch ? ctrlMatch[1] : "").trim();
        if (!controlPath) continue;
        return {
            name,
            serviceType: type,
            controlUrl: resolveUrl(locationUrl, controlPath),
            eventUrl: eventMatch ? resolveUrl(locationUrl, eventMatch[1].trim()) : "",
        };
    }
    return null;
}

async function fetchDescription(location, timeoutMs = 6000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(location, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${location}`);
        const xml = await res.text();
        return parseDeviceDescription(xml, location);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Listen for SSDP replies on a bound socket and resolve descriptions.
 * Shared by multicast discovery and unicast (pinned-host) discovery.
 */
async function collectReplies(socket, timeoutMs) {
    const seen = new Map();
    await new Promise((resolve) => {
        const timer = setTimeout(() => {
            socket.removeAllListeners("message");
            resolve();
        }, timeoutMs);
        socket.on("message", (msg) => {
            try {
                const parsed = parseSsdpResponse(msg.toString("utf8"));
                if (parsed.location && !seen.has(parsed.location)) {
                    seen.set(parsed.location, parsed);
                }
            } catch {}
            void timer;
        });
    });
    const devices = [];
    for (const [location, info] of seen) {
        try {
            const desc = await fetchDescription(location);
            if (!desc) continue;
            let host = "";
            try {
                host = new URL(location).hostname;
            } catch {}
            devices.push({ ...desc, location, host, st: info.st, usn: info.usn });
        } catch {}
    }
    return devices;
}

/**
 * Discover DLNA renderers on the LAN via SSDP multicast, or query a
 * single host via SSDP unicast when `unicastHost` is set (works where
 * multicast is blocked: VLANs, Termux, Docker without host networking).
 */
export async function discoverDlnaDevices({ timeoutMs = 4000, unicastHost = "" } = {}) {
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
        const msg = Buffer.from(buildMSearch());
        const targetHost = unicastHost || SSDP_MULTICAST_ADDR;
        await new Promise((resolve, reject) => {
            socket.send(msg, 0, msg.length, SSDP_PORT, targetHost, (err) => (err ? reject(err) : resolve()));
        });
        // Multicast responses can trickle in; re-send once to catch sleepy TVs.
        await new Promise((r) => setTimeout(r, Math.min(800, Math.floor(timeoutMs / 3))));
        try {
            await new Promise((resolve, reject) => {
                socket.send(msg, 0, msg.length, SSDP_PORT, targetHost, (err) => (err ? reject(err) : resolve()));
            });
        } catch {}
        return await collectReplies(socket, timeoutMs);
    } finally {
        try {
            socket.close();
        } catch {}
    }
}

/**
 * Resolve the configured target device:
 * 1. `cast_device_host` as a full description URL -> fetch directly.
 * 2. `cast_device_host` as bare IP/hostname -> SSDP unicast to that host.
 * 3. Otherwise SSDP multicast, matched by `cast_device_name` (substring,
 *    case-insensitive) or the first renderer found.
 */
export async function resolveTargetDevice(settings = {}, { timeoutMs = 4000 } = {}) {
    const hostRaw = String(settings.cast_device_host || process.env.CAST_DEVICE_HOST || "").trim();
    const nameRaw = String(settings.cast_device_name || process.env.CAST_DEVICE_NAME || "").trim();

    if (/^https?:\/\//i.test(hostRaw)) {
        const desc = await fetchDescription(hostRaw);
        if (!desc) throw new Error(`No AVTransport service in device description at ${hostRaw}`);
        let host = "";
        try {
            host = new URL(hostRaw).hostname;
        } catch {}
        return { ...desc, location: hostRaw, host };
    }

    if (hostRaw) {
        const found = await discoverDlnaDevices({ timeoutMs, unicastHost: hostRaw });
        const match = matchDeviceByName(found, nameRaw) || found[0];
        if (!match) throw new Error(`No DLNA renderer answered at ${hostRaw}:1900 (is the TV on the same network and powered on?)`);
        return match;
    }

    const found = await discoverDlnaDevices({ timeoutMs });
    if (found.length === 0) {
        throw new Error(
            "No DLNA renderers found. If discovery is blocked on your network, pin the TV with @set-cast-device <tv-ip> (e.g. @set-cast-device 192.168.0.3)."
        );
    }
    const match = matchDeviceByName(found, nameRaw);
    if (nameRaw && !match) {
        const names = found.map((d) => `"${d.name}"`).join(", ");
        throw new Error(`No renderer matches "${nameRaw}". Found: ${names}. Pick one with @set-cast-device <exact name>.`);
    }
    return match || found[0];
}

export function matchDeviceByName(devices, name) {
    const needle = String(name || "").trim().toLowerCase();
    if (!needle) return null;
    return devices.find((d) => String(d.name || "").toLowerCase().includes(needle)) || null;
}

function soapEnvelope(serviceType, action, bodyXml) {
    return (
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
        `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
        `<s:Body><u:${action} xmlns:u="${serviceType}">${bodyXml}</u:${action}></s:Body></s:Envelope>`
    );
}

export async function soapAction(device, action, bodyXml, { timeoutMs = 8000 } = {}) {
    const serviceType = device.serviceType || AVTRANSPORT_SERVICE;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(device.controlUrl, {
            method: "POST",
            signal: ctrl.signal,
            headers: {
                "Content-Type": 'text/xml; charset="utf-8"',
                SOAPAction: `"${serviceType}#${action}"`,
            },
            body: soapEnvelope(serviceType, action, bodyXml),
        });
        const text = await res.text();
        if (!res.ok) {
            const errMatch = text.match(/<errorDescription>([\s\S]*?)<\/errorDescription>/i);
            throw new Error(`DLNA ${action} failed (HTTP ${res.status}): ${(errMatch ? errMatch[1] : text).trim().slice(0, 300)}`);
        }
        return text;
    } finally {
        clearTimeout(timer);
    }
}

/** Point the renderer at our relay URL and start playback (Castor's core cast). */
export async function dlnaCast(device, mediaUrl, { title = "Bun Cast", mime = "video/mp4" } = {}) {
    const metadata = buildDidlLite(mediaUrl, title, mime);
    await soapAction(
        device,
        "SetAVTransportURI",
        `<InstanceID>0</InstanceID>` +
            `<CurrentURI>${escapeXml(mediaUrl)}</CurrentURI>` +
            `<CurrentURIMetaData>${escapeXml(metadata)}</CurrentURIMetaData>`
    );
    await soapAction(device, "Play", `<InstanceID>0</InstanceID><Speed>1</Speed>`);
    return { device, mediaUrl, title, mime };
}

export async function dlnaStop(device) {
    return soapAction(device, "Stop", `<InstanceID>0</InstanceID>`);
}

export async function dlnaPause(device) {
    return soapAction(device, "Pause", `<InstanceID>0</InstanceID>`);
}

export async function dlnaResume(device) {
    return soapAction(device, "Play", `<InstanceID>0</InstanceID><Speed>1</Speed>`);
}

/** Best-effort transport state for @cast-status (STOPPED / PAUSED / PLAYING / unknown). */
export async function dlnaTransportState(device, { timeoutMs = 5000 } = {}) {
    try {
        const xml = await soapAction(device, "GetTransportInfo", `<InstanceID>0</InstanceID>`, { timeoutMs });
        const m = xml.match(/<CurrentTransportState>([\s\S]*?)<\/CurrentTransportState>/i);
        return (m ? m[1] : "unknown").trim() || "unknown";
    } catch {
        return "unknown";
    }
}

export function formatScanResults(devices) {
    if (!devices || devices.length === 0) {
        return (
            "📺 No DLNA renderers found.\n" +
            "💡 Pin the TV by IP instead: @set-cast-device 192.168.0.3 (unicast, works across VLANs/Termux where multicast is blocked)."
        );
    }
    const lines = devices.map(
        (d, i) => `  ${i + 1}. "${d.name}"${d.host ? ` @ ${d.host}` : ""}\n     ${d.location}`
    );
    return `📺 DLNA renderers (${devices.length}):\n${lines.join("\n")}\n💡 Select one: @set-cast-device <exact name> or @set-cast-device <ip>`;
}

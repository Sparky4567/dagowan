// ---------------------------------------------------------------------------
// Minimal mDNS discovery for Chromecast / Google Cast devices.
// Pure Bun + JavaScript (node:dgram): queries _googlecast._tcp.local on
// 224.0.0.251:5353 and parses PTR/SRV/TXT/A records (with DNS compression).
// ---------------------------------------------------------------------------

export const MDNS_ADDR = "224.0.0.251";
export const MDNS_PORT = 5353;
export const GOOGLECAST_SERVICE = "_googlecast._tcp.local";

export function encodeDnsName(name) {
    const parts = [];
    for (const label of String(name).split(".").filter(Boolean)) {
        const bytes = Buffer.from(label, "utf8");
        if (bytes.length > 63) throw new Error(`DNS label too long: ${label}`);
        parts.push(Buffer.from([bytes.length]), bytes);
    }
    parts.push(Buffer.from([0x00]));
    return Buffer.concat(parts);
}

/** DNS query for <service> PTR records. */
export function buildMdnsQuery(service = GOOGLECAST_SERVICE) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x0000, 0); // id (mDNS convention: 0)
    header.writeUInt16BE(0x0000, 2); // flags: standard query
    header.writeUInt16BE(0x0001, 4); // QDCOUNT
    const question = Buffer.concat([encodeDnsName(service), Buffer.from([0x00, 0x0c, 0x00, 0x01])]); // PTR/IN
    return Buffer.concat([header, question]);
}

function readName(buf, offset, jumps = 0) {
    if (jumps > 10) throw new Error("DNS compression loop");
    const labels = [];
    let pos = offset;
    let end = -1;
    for (;;) {
        if (pos >= buf.length) throw new Error("DNS name overruns packet");
        const len = buf[pos];
        if ((len & 0xc0) === 0xc0) {
            if (pos + 1 >= buf.length) throw new Error("DNS pointer overruns packet");
            const target = ((len & 0x3f) << 8) | buf[pos + 1];
            if (end === -1) end = pos + 2;
            const rest = readName(buf, target, jumps + 1);
            labels.push(...rest.name.split(".").filter(Boolean));
            pos = end;
            break;
        }
        if (len === 0) {
            pos += 1;
            if (end === -1) end = pos;
            break;
        }
        pos += 1;
        if (pos + len > buf.length) throw new Error("DNS label overruns packet");
        labels.push(buf.subarray(pos, pos + len).toString("utf8"));
        pos += len;
    }
    return { name: labels.join("."), next: end === -1 ? pos : end };
}

function parseTxt(rdata) {
    const out = {};
    let pos = 0;
    while (pos < rdata.length) {
        const len = rdata[pos];
        pos += 1;
        if (pos + len > rdata.length) break;
        const entry = rdata.subarray(pos, pos + len).toString("utf8");
        pos += len;
        const eq = entry.indexOf("=");
        if (eq === -1) out[entry] = "";
        else out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
}

/** Parse a full mDNS message into questions + resource records. */
export function parseMdnsMessage(buf) {
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (data.length < 12) throw new Error("mDNS packet too short");
    const qd = data.readUInt16BE(4);
    const an = data.readUInt16BE(6);
    const ns = data.readUInt16BE(8);
    const ar = data.readUInt16BE(10);
    let pos = 12;
    const questions = [];
    for (let i = 0; i < qd; i++) {
        const { name, next } = readName(data, pos);
        pos = next;
        if (pos + 4 > data.length) throw new Error("mDNS question overruns packet");
        questions.push({ name, type: data.readUInt16BE(pos), class: data.readUInt16BE(pos + 2) });
        pos += 4;
    }
    const records = [];
    const total = an + ns + ar;
    for (let i = 0; i < total; i++) {
        const { name, next } = readName(data, pos);
        pos = next;
        if (pos + 10 > data.length) throw new Error("mDNS record overruns packet");
        const type = data.readUInt16BE(pos);
        const cls = data.readUInt16BE(pos + 2);
        const ttl = data.readUInt32BE(pos + 4);
        const rdlen = data.readUInt16BE(pos + 8);
        pos += 10;
        if (pos + rdlen > data.length) throw new Error("mDNS rdata overruns packet");
        const rdata = data.subarray(pos, pos + rdlen);
        pos += rdlen;
        const rec = { name, type, class: cls & 0x7fff, ttl, rdata };
        if (type === 12) rec.ptr = readName(data, pos - rdlen).name; // PTR
        else if (type === 33) {
            // SRV
            rec.srv = {
                priority: rdata.readUInt16BE(0),
                weight: rdata.readUInt16BE(2),
                port: rdata.readUInt16BE(4),
                target: readName(data, pos - rdlen + 6).name,
            };
        } else if (type === 16) rec.txt = parseTxt(rdata); // TXT
        else if (type === 1 && rdlen === 4) rec.a = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`; // A
        records.push(rec);
    }
    return { questions, records };
}

/**
 * Fold raw records into device list: PTR -> instance, SRV -> host:port,
 * TXT -> metadata (fn = friendly name), A -> IPs for SRV targets.
 */
export function foldGoogleCastRecords(records) {
    const byInstance = new Map();
    const aRecords = new Map(); // lowercase name -> [ips]
    for (const r of records || []) {
        if (r.type === 1 && r.a) {
            const key = String(r.name || "").toLowerCase();
            if (!aRecords.has(key)) aRecords.set(key, []);
            aRecords.get(key).push(r.a);
        }
    }
    for (const r of records || []) {
        if (r.type !== 12 || !r.ptr) continue; // PTR
        if (!String(r.name || "").toLowerCase().endsWith(GOOGLECAST_SERVICE)) continue;
        if (!byInstance.has(r.ptr)) byInstance.set(r.ptr, { instance: r.ptr });
    }
    for (const r of records || []) {
        const inst = byInstance.get(r.name);
        if (!inst) continue;
        if (r.type === 33 && r.srv) {
            inst.target = r.srv.target;
            inst.port = r.srv.port;
        } else if (r.type === 16 && r.txt) {
            inst.txt = { ...(inst.txt || {}), ...r.txt };
        }
    }
    const devices = [];
    for (const inst of byInstance.values()) {
        const ips = (inst.target && aRecords.get(String(inst.target).toLowerCase())) || [];
        if (ips.length === 0) continue;
        const txt = inst.txt || {};
        const friendly = txt.fn || String(inst.instance).split(".")[0].replace(/-/g, " ");
        devices.push({
            kind: "chromecast",
            name: friendly,
            host: ips[0],
            ips,
            port: inst.port || 8009,
            instance: inst.instance,
            model: txt.md || "",
            id: txt.id || "",
        });
    }
    // Dedupe by IP (responses repeat across packets).
    const seen = new Set();
    return devices.filter((d) => {
        if (seen.has(d.host)) return false;
        seen.add(d.host);
        return true;
    });
}

/**
 * Discover Google Cast devices on the LAN. Resolves [] (never throws for
 * network-level issues) so scans can merge sources independently.
 */
export async function discoverGoogleCast({ timeoutMs = 4000, service = GOOGLECAST_SERVICE } = {}) {
    try {
        const { default: dgram } = await import("node:dgram");
        const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        await new Promise((resolve, reject) => {
            socket.once("error", reject);
            socket.bind(MDNS_PORT, () => {
                socket.removeListener("error", reject);
                resolve();
            });
        });
        try {
            try {
                socket.addMembership(MDNS_ADDR);
            } catch {}
            const query = buildMdnsQuery(service);
            const send = () =>
                new Promise((resolve) => {
                    socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDR, () => resolve());
                });
            await send();
            const packets = [];
            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    socket.removeAllListeners("message");
                    resolve();
                }, timeoutMs);
                socket.on("message", (msg) => {
                    packets.push(Buffer.from(msg));
                    void timer;
                });
            });
            await send().catch(() => {});
            const allRecords = [];
            for (const p of packets) {
                try {
                    const parsed = parseMdnsMessage(p);
                    allRecords.push(...parsed.records);
                } catch {}
            }
            return foldGoogleCastRecords(allRecords);
        } finally {
            try {
                socket.close();
            } catch {}
        }
    } catch (err) {
        throw new Error(`mDNS discovery unavailable (${err.message || err}); pin the device IP with @set-cast-device <ip> instead.`);
    }
}

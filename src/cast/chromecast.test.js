import { describe, expect, test } from "bun:test";
import {
    buildConnect,
    buildGetStatus,
    buildLaunch,
    buildLoad,
    buildMediaCommand,
    decodeCastMessage,
    encodeCastMessage,
    extractYoutubeVideoId,
    findAppSession,
    frameMessage,
    isYoutubeUrl,
    parseMediaStatus,
    parseReceiverStatus,
    parseYoutubeStartTime,
    splitFrames,
} from "./castv2.js";
import {
    buildMdnsQuery,
    encodeDnsName,
    foldGoogleCastRecords,
    parseMdnsMessage,
} from "./mdns.js";
import { appsUrlFromLocation, parseDialDescription } from "./dial.js";
import { formatCombinedScan, mergeCastDevices } from "./caster.js";

describe("cast protobuf codec", () => {
    test("encode/decode round-trips a receiver message", () => {
        const payload = { type: "GET_STATUS", requestId: 42 };
        const bytes = encodeCastMessage({
            sourceId: "sender-0",
            destinationId: "receiver-0",
            namespace: "urn:x-cast:com.google.cast.receiver",
            payloadUtf8: payload,
        });
        const back = decodeCastMessage(bytes);
        expect(back.sourceId).toBe("sender-0");
        expect(back.destinationId).toBe("receiver-0");
        expect(back.namespace).toBe("urn:x-cast:com.google.cast.receiver");
        expect(JSON.parse(back.payloadUtf8)).toEqual(payload);
        expect(back.protocolVersion).toBe(0);
        expect(back.payloadType).toBe(0);
    });

    test("decoder skips unknown fields", () => {
        const base = encodeCastMessage({
            sourceId: "s",
            destinationId: "d",
            namespace: "n",
            payloadUtf8: { type: "PING" },
        });
        // unknown varint field 9 + unknown length-delimited field 10
        const extra = Buffer.concat([Buffer.from([0x48, 0x07]), Buffer.from([0x52, 0x03, 0x61, 0x62, 0x63])]);
        const back = decodeCastMessage(Buffer.concat([base, extra]));
        expect(back.sourceId).toBe("s");
        expect(JSON.parse(back.payloadUtf8)).toEqual({ type: "PING" });
    });

    test("framing splits concatenated messages and keeps partial tail", () => {
        const a = frameMessage(encodeCastMessage({ sourceId: "a", destinationId: "b", namespace: "n", payloadUtf8: "x" }));
        const b = frameMessage(encodeCastMessage({ sourceId: "c", destinationId: "d", namespace: "n", payloadUtf8: "y" }));
        const half = b.subarray(0, 6);
        const { messages, rest } = splitFrames(Buffer.concat([a, b, half.subarray(0, 3)]));
        expect(messages).toHaveLength(2);
        expect(rest.length).toBe(3);
        expect(decodeCastMessage(messages[0]).sourceId).toBe("a");
        expect(decodeCastMessage(messages[1]).sourceId).toBe("c");
        void half;
    });
});

describe("cast message builders + parsers", () => {
    test("builders produce protocol shapes", () => {
        expect(buildConnect()).toEqual({ type: "CONNECT" });
        expect(buildGetStatus(7)).toEqual({ type: "GET_STATUS", requestId: 7 });
        expect(buildLaunch("CC1AD845", 8)).toEqual({ type: "LAUNCH", appId: "CC1AD845", requestId: 8 });
        expect(buildMediaCommand("PAUSE", { requestId: 9 })).toEqual({ type: "PAUSE", requestId: 9 });
        const load = buildLoad({ sessionId: "s1", contentId: "http://h/stream", requestId: 10 });
        expect(load.type).toBe("LOAD");
        expect(load.media.contentId).toBe("http://h/stream");
        expect(load.sessionId).toBe("s1");
    });

    test("parseReceiverStatus finds DMR session", () => {
        const apps = parseReceiverStatus({
            status: {
                applications: [
                    { appId: "E8C28D3C", sessionId: "x", transportId: "t0", namespaces: [] },
                    { appId: "CC1AD845", displayName: "Default Media Receiver", sessionId: "s1", transportId: "t1", namespaces: [{ name: "urn:x-cast:com.google.cast.media" }] },
                ],
            },
        });
        expect(apps).toHaveLength(2);
        const dmr = findAppSession(apps, "CC1AD845");
        expect(dmr.transportId).toBe("t1");
        expect(dmr.namespaces).toContain("urn:x-cast:com.google.cast.media");
        expect(findAppSession(apps, "NOPE")).toBeNull();
        expect(parseReceiverStatus({})).toEqual([]);
    });

    test("parseMediaStatus reads player state", () => {
        const st = parseMediaStatus({ status: [{ mediaSessionId: 3, playerState: "PLAYING", currentTime: 12.5, media: { contentId: "u", duration: 300 } }] });
        expect(st.playerState).toBe("PLAYING");
        expect(st.currentTime).toBe(12.5);
        expect(st.duration).toBe(300);
        expect(parseMediaStatus({ status: [] })).toBeNull();
        expect(parseMediaStatus({})).toBeNull();
    });
});

describe("youtube url handling", () => {
    test("extracts video ids from all url shapes", () => {
        expect(extractYoutubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
        expect(extractYoutubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
        expect(extractYoutubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
        expect(extractYoutubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
        expect(extractYoutubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
        expect(extractYoutubeVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=90")).toBe("dQw4w9WgXcQ");
        expect(extractYoutubeVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
        expect(extractYoutubeVideoId("https://www.youtube.com/results?search_query=x")).toBeNull();
        expect(extractYoutubeVideoId("https://example.com/v.mp4")).toBeNull();
        expect(extractYoutubeVideoId("")).toBeNull();
    });

    test("isYoutubeUrl distinguishes pages from bare ids", () => {
        expect(isYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
        expect(isYoutubeUrl("dQw4w9WgXcQ")).toBe(false);
        expect(isYoutubeUrl("https://example.com/v.mp4")).toBe(false);
    });

    test("parses start times", () => {
        expect(parseYoutubeStartTime("https://www.youtube.com/watch?v=x&t=90")).toBe(90);
        expect(parseYoutubeStartTime("https://www.youtube.com/watch?v=x&t=1m30s")).toBe(90);
        expect(parseYoutubeStartTime("https://www.youtube.com/watch?v=x&t=1h2m3s")).toBe(3723);
        expect(parseYoutubeStartTime("https://www.youtube.com/watch?v=x&start=45")).toBe(45);
        expect(parseYoutubeStartTime("https://www.youtube.com/watch?v=x")).toBe(0);
    });
});

describe("mdns packets", () => {
    test("query encodes service PTR question", () => {
        const q = buildMdnsQuery();
        expect(q.readUInt16BE(4)).toBe(1); // QDCOUNT
        expect(q.subarray(12).toString("utf8")).toContain("_googlecast");
    });

    function txtEntry(s) {
        const b = Buffer.from(s, "utf8");
        return Buffer.concat([Buffer.from([b.length]), b]);
    }

    function rr(name, type, rdata, ttl = 120) {
        const head = Buffer.alloc(10);
        head.writeUInt16BE(type, 0);
        head.writeUInt16BE(1, 2); // IN
        head.writeUInt32BE(ttl, 4);
        head.writeUInt16BE(rdata.length, 8);
        return Buffer.concat([name, head, rdata]);
    }

    test("parses response with compression pointer and folds devices", () => {
        const service = "_googlecast._tcp.local";
        const instance = "Living-Room-TV-abc123._googlecast._tcp.local";
        const target = "Living-Room-TV-abc123.local";
        const header = Buffer.alloc(12);
        header.writeUInt16BE(0, 0);
        header.writeUInt16BE(0x8400, 2); // response
        header.writeUInt16BE(1, 4); // QD
        header.writeUInt16BE(4, 6); // AN
        const question = Buffer.concat([encodeDnsName(service), Buffer.from([0x00, 0x0c, 0x00, 0x01])]);
        // AN1 owner = pointer to question name (offset 12) -> exercises 0xC0 path
        const an1 = rr(Buffer.from([0xc0, 0x0c]), 12, encodeDnsName(instance));
        const srvData = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x00, 0x1f, 0x49]), encodeDnsName(target)]);
        const an2 = rr(encodeDnsName(instance), 33, srvData);
        const txt = Buffer.concat([txtEntry("fn=Living Room TV"), txtEntry("md=Chromecast"), txtEntry("id=abc123")]);
        const an3 = rr(encodeDnsName(instance), 16, txt);
        const an4 = rr(encodeDnsName(target), 1, Buffer.from([192, 168, 0, 5]));
        const packet = Buffer.concat([header, question, an1, an2, an3, an4]);

        const parsed = parseMdnsMessage(packet);
        expect(parsed.questions[0].name).toBe(service);
        expect(parsed.records).toHaveLength(4);
        expect(parsed.records[0].ptr).toBe(instance);

        const devices = foldGoogleCastRecords(parsed.records);
        expect(devices).toHaveLength(1);
        expect(devices[0].name).toBe("Living Room TV");
        expect(devices[0].host).toBe("192.168.0.5");
        expect(devices[0].port).toBe(8009);
        expect(devices[0].model).toBe("Chromecast");
    });

    test("fold skips instances without A records and dedupes", () => {
        const recs = [
            { name: "_googlecast._tcp.local", type: 12, ptr: "A._googlecast._tcp.local" },
            { name: "A._googlecast._tcp.local", type: 33, srv: { port: 8009, target: "a.local" } },
            { name: "a.local", type: 1, a: "192.168.0.6" },
            { name: "a.local", type: 1, a: "192.168.0.6" },
            { name: "_googlecast._tcp.local", type: 12, ptr: "B._googlecast._tcp.local" },
        ];
        const devices = foldGoogleCastRecords(recs);
        expect(devices).toHaveLength(1); // B has no A record; A deduped
        expect(devices[0].host).toBe("192.168.0.6");
    });
});

describe("dial helpers", () => {
    test("parses dd.xml and derives apps url", () => {
        const xml = `<root><device><friendlyName>Living Room TV</friendlyName><manufacturer>Google</manufacturer><modelName>Chromecast</modelName></device></root>`;
        expect(parseDialDescription(xml).name).toBe("Living Room TV");
        expect(appsUrlFromLocation("http://192.168.0.5:8008/ssdp/device-desc.xml", "")).toBe("http://192.168.0.5:8008/ssdp/apps");
        expect(appsUrlFromLocation("http://192.168.0.5:8008/ssdp/device-desc.xml", "http://192.168.0.5:8008/apps/")).toBe("http://192.168.0.5:8008/apps");
    });
});

describe("device merge + combined scan", () => {
    test("merges dial and mdns by host", () => {
        const merged = mergeCastDevices(
            [{ host: "192.168.0.5", name: "Chromecast device", model: "" }],
            [{ host: "192.168.0.5", name: "Living Room TV", port: 8009, model: "Chromecast" }]
        );
        expect(merged).toHaveLength(1);
        expect(merged[0].name).toBe("Living Room TV");
        expect(merged[0].kind).toBe("chromecast");
    });

    test("combined scan lists both protocols", () => {
        const out = formatCombinedScan({
            chromecast: [{ name: "Living Room TV", host: "192.168.0.5", model: "" }],
            dlna: [{ name: "Bedroom", host: "192.168.0.6", location: "http://x" }],
        });
        expect(out).toContain("Chromecast / Android TV");
        expect(out).toContain("Living Room TV");
        expect(out).toContain("Bedroom");
        expect(out).toContain("@set-cast-device");
    });
});

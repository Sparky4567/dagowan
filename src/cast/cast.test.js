import { describe, expect, test } from "bun:test";
import {
    buildDidlLite,
    escapeXml,
    formatScanResults,
    matchDeviceByName,
    parseDeviceDescription,
    parseSsdpResponse,
} from "./dlna.js";
import { classifyByExtension, mimeForMode, needsTranscode } from "./probe.js";
import { looksLikeDirectUrl, rankCandidates, scoreCandidate } from "./extract.js";
import { CAST_USAGE, parseCastInput, setCastDevice } from "./caster.js";

describe("ssdp parsing", () => {
    test("extracts location/st/usn case-insensitively", () => {
        const raw =
            "HTTP/1.1 200 OK\r\n" +
            "LOCATION: http://192.168.0.3:9197/dmr\r\n" +
            "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n" +
            "USN: uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
        const p = parseSsdpResponse(raw);
        expect(p.location).toBe("http://192.168.0.3:9197/dmr");
        expect(p.st).toBe("urn:schemas-upnp-org:device:MediaRenderer:1");
        expect(p.usn).toContain("uuid:abc");
    });

    test("missing location yields empty string", () => {
        expect(parseSsdpResponse("HTTP/1.1 200 OK\r\nST: x\r\n\r\n").location).toBe("");
    });
});

describe("device description parsing", () => {
    const xml = `<?xml version="1.0"?><root><device><friendlyName>Living Room TV</friendlyName></device>
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
<controlURL>/dmr/control</controlURL><eventSubURL>/dmr/events</eventSubURL></service></root>`;
    test("finds name + absolute control url", () => {
        const d = parseDeviceDescription(xml, "http://192.168.0.3:9197/dmr");
        expect(d.name).toBe("Living Room TV");
        expect(d.controlUrl).toBe("http://192.168.0.3:9197/dmr/control");
    });

    test("returns null without AVTransport", () => {
        expect(parseDeviceDescription("<root></root>", "http://x/")).toBeNull();
    });

    test("matchDeviceByName is case-insensitive substring", () => {
        const devices = [{ name: "Living Room TV" }, { name: "Bedroom" }];
        expect(matchDeviceByName(devices, "living").name).toBe("Living Room TV");
        expect(matchDeviceByName(devices, "KITCHEN")).toBeNull();
        expect(matchDeviceByName(devices, "")).toBeNull();
    });
});

describe("didl + escaping", () => {
    test("escapes special chars in url and title", () => {
        expect(escapeXml(`a&b<"c'>`)).toBe("a&amp;b&lt;&quot;c&apos;&gt;");
        const didl = buildDidlLite("http://h/s?a=1&b=2", "T<1>", "video/mp4");
        expect(didl).toContain("http://h/s?a=1&amp;b=2");
        expect(didl).toContain("T&lt;1&gt;");
    });

    test("scan formatter handles empty + populated", () => {
        expect(formatScanResults([])).toContain("No DLNA renderers");
        const out = formatScanResults([{ name: "TV", host: "1.2.3.4", location: "http://1.2.3.4/d" }]);
        expect(out).toContain('"TV"');
        expect(out).toContain("@set-cast-device");
    });
});

describe("candidate ranking", () => {
    test("direct mp4 outranks hls playlist, noise filtered", () => {
        const ranked = rankCandidates([
            "https://cdn.example.com/master.m3u8",
            "https://cdn.example.com/app.js",
            "https://cdn.example.com/video.mp4?token=1",
            "data:video/mp4;base64,xx",
        ]);
        expect(ranked[0]).toBe("https://cdn.example.com/video.mp4?token=1");
        expect(ranked).toContain("https://cdn.example.com/master.m3u8");
        expect(ranked.join("")).not.toContain("app.js");
    });

    test("scoreCandidate prefers mp4 over mkv over m3u8 over mpd", () => {
        const order = [
            scoreCandidate("https://x/a.mp4"),
            scoreCandidate("https://x/a.mkv"),
            scoreCandidate("https://x/a.m3u8"),
            scoreCandidate("https://x/a.mpd"),
        ];
        expect([...order].sort((a, b) => b - a)).toEqual(order);
        expect(scoreCandidate("https://x/a.js")).toBe(-1);
    });

    test("looksLikeDirectUrl checks extension only", () => {
        expect(looksLikeDirectUrl("https://x/v.mp4")).toBe(true);
        expect(looksLikeDirectUrl("https://x/watch/abc")).toBe(false);
        expect(looksLikeDirectUrl("https://x/s.m3u8")).toBe(false);
    });
});

describe("probe classification", () => {
    test("classifyByExtension direct/transcode/unknown", () => {
        expect(classifyByExtension("https://x/v.mp4")).toBe("direct");
        expect(classifyByExtension("https://x/s.m3u8")).toBe("transcode");
        expect(classifyByExtension("https://x/watch")).toBe("unknown");
    });

    test("needsTranscode respects auto + force flags", () => {
        expect(needsTranscode({ isHls: true, videoCodec: "h264", formatName: "hls" }, {})).toBe(true);
        expect(needsTranscode({ isHls: false, videoCodec: "h264", formatName: "mp4" }, {})).toBe(false);
        expect(needsTranscode({ isHls: false, videoCodec: "av1", formatName: "webm" }, {})).toBe(true);
        expect(needsTranscode({ isHls: false, videoCodec: "h264", formatName: "mp4" }, { cast_transcode: "always" })).toBe(true);
        expect(needsTranscode({ isHls: true }, { cast_transcode: "never" })).toBe(false);
        expect(mimeForMode("transcode")).toContain("mpeg-tts");
        expect(mimeForMode("proxy")).toBe("video/mp4");
    });
});

describe("cast command parser", () => {
    test("parses all command shapes", () => {
        expect(parseCastInput("@cast-scan")).toEqual({ action: "scan", arg: "" });
        expect(parseCastInput("/scan-tv")).toEqual({ action: "scan", arg: "" });
        expect(parseCastInput("@cast status")).toEqual({ action: "status", arg: "" });
        expect(parseCastInput("@cast-stop")).toEqual({ action: "stop", arg: "" });
        expect(parseCastInput("@cast-pause")).toEqual({ action: "pause", arg: "" });
        expect(parseCastInput("@cast-play")).toEqual({ action: "resume", arg: "" });
        expect(parseCastInput("@cast-url https://x/v.mp4")).toEqual({ action: "url", arg: "https://x/v.mp4" });
        expect(parseCastInput("@cast player https://x/watch")).toEqual({ action: "player", arg: "https://x/watch" });
        expect(parseCastInput("@cast https://x/v.mp4")).toEqual({ action: "auto", arg: "https://x/v.mp4" });
        expect(parseCastInput("@cast")).toEqual({ action: "help", arg: "" });
        expect(parseCastInput("@set-cast-device 192.168.0.3")).toEqual({ action: "device", arg: "192.168.0.3" });
        expect(parseCastInput("@cast-device Living Room TV")).toEqual({ action: "device", arg: "Living Room TV" });
    });

    test("ignores non-cast commands", () => {
        expect(parseCastInput("@character main")).toBeNull();
        expect(parseCastInput("@browser-status")).toBeNull();
        expect(parseCastInput("hello world")).toBeNull();
        expect(parseCastInput("")).toBeNull();
    });

    test("setCastDevice routes ip vs name vs url", () => {
        const s1 = {};
        expect(setCastDevice(s1, "192.168.0.3")).toContain("unicast");
        expect(s1.cast_device_host).toBe("192.168.0.3");

        const s2 = {};
        setCastDevice(s2, "Living Room TV");
        expect(s2.cast_device_name).toBe("Living Room TV");
        expect(s2.cast_device_host).toBe("");

        const s3 = {};
        setCastDevice(s3, "http://192.168.0.3:9197/dmr");
        expect(s3.cast_device_host).toContain("http");

        expect(setCastDevice({}, "")).toContain("Usage");
    });

    test("usage text documents all commands", () => {
        for (const cmd of ["@cast-scan", "@cast-url", "@cast-player", "@cast-status", "@cast-stop", "@set-cast-device"]) {
            expect(CAST_USAGE).toContain(cmd);
        }
    });
});

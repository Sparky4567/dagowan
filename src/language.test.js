import { test, expect, describe, beforeEach } from "bun:test";
import { BotDatabase } from "./db/database.js";
import { MemoryStore, MemoryRetriever } from "./memory.js";
import {
    bridgeTranslateToken,
    detectLanguage,
    languageName,
    normalizeLanguageCode,
    languageFileFor,
    languageFromFilePath,
    expandTokensWithBridge,
    extractLanguageFilter,
    buildLanguageScopeNote,
} from "./language.js";

describe("Language detection", () => {
    test("detects Lithuanian via diacritics", () => {
        const d = detectLanguage("Labas, kaip sekasi? Ačiū už pagalbą!");
        expect(d.code).toBe("lt");
        expect(d.confidence).toBeGreaterThan(0.8);
    });

    test("detects Lithuanian via stopwords (no diacritics)", () => {
        const d = detectLanguage("kaip tu šiandien jautiesi, ar viskas gerai su tavimi");
        expect(d.code).toBe("lt");
    });

    test("detects English", () => {
        const d = detectLanguage("What is my favorite project and what are my goals for today?");
        expect(d.code).toBe("en");
    });

    test("detects Russian via Cyrillic", () => {
        const d = detectLanguage("Привет, как дела?");
        expect(d.code).toBe("ru");
    });

    test("empty / numeric input is undetermined", () => {
        expect(detectLanguage("").code).toBe("und");
        expect(detectLanguage("12345").code).toBe("und");
    });

    test("code normalization", () => {
        expect(normalizeLanguageCode("Lithuanian")).toBe("lt");
        expect(normalizeLanguageCode("EN")).toBe("en");
        // Open-ended: any ISO-shaped code is a valid pool (no allowlist).
        expect(normalizeLanguageCode("xx")).toBe("xx");
        expect(normalizeLanguageCode("xx-bogus")).toBeNull();
        expect(normalizeLanguageCode("pt-BR")).toBe("pt");
    });

    test("per-language file mapping", () => {
        expect(languageFileFor("memory.json", "lt")).toBe("memory.lt.json");
        expect(languageFileFor("memory.json", "en")).toBe("memory.en.json");
        expect(languageFileFor("memory.json", "shared")).toBe("memory.json");
        expect(languageFromFilePath("memory.lt.json")).toBe("lt");
        expect(languageFromFilePath("memory.json")).toBe(null);
    });

    test("bridge expands LT tokens to EN", () => {
        const out = expandTokensWithBridge(["labas", "katė"], "lt", "en");
        expect(out).toContain("hello");
        expect(out).toContain("cat");
    });

    test("--lang filter extraction", () => {
        const p = extractLanguageFilter("cats --lang lt");
        expect(p.lang).toBe("lt");
        expect(p.rest).toBe("cats");
    });

    test("scope note mentions reply language", () => {
        const note = buildLanguageScopeNote("lt", 2);
        expect(note).toContain("lt");
        expect(note).toContain("2");
    });
});

describe("Multilanguage memory layer", () => {
    let db;
    let store;

    beforeEach(() => {
        db = new BotDatabase(":memory:");
        store = new MemoryStore(db);
    });

    test("addMemory auto-tags language", () => {
        const lt = store.addMemory("Labas, ačiū už pagalbą su kompiuteriu!");
        expect(lt.language).toBe("lt");
        const en = store.addMemory("The user prefers TypeScript over Python for new projects.");
        expect(en.language).toBe("en");
    });

    test("explicit language override wins", () => {
        const m = store.addMemory({ content: "Hello world test memory", language: "lt" });
        expect(m.language).toBe("lt");
    });

    test("listMemories filters by language (+shared)", () => {
        store.addMemory("Labas, kaip sekasi šiandien su tavimi?");
        store.addMemory("The user prefers tea over coffee in the morning meetings.");
        const ltOnly = store.listMemories({ status: "active", language: "lt" });
        expect(ltOnly.length).toBeGreaterThanOrEqual(1);
        expect(ltOnly.every((m) => !m.language || m.language === "lt")).toBe(true);
        const enOnly = store.listMemories({ status: "active", language: "en" });
        expect(enOnly.every((m) => !m.language || m.language === "en")).toBe(true);
    });

    test("retrieval prefers same-language pool", () => {
        store.addMemory({ content: "Vartotojas mėgsta kavą ryte su draugais.", importance: 0.9 });
        store.addMemory({ content: "The user likes tea in the evening meetings.", importance: 0.9 });
        const retriever = new MemoryRetriever(store);
        const ltHits = retriever.search("ką vartotojas mėgsta gerti ryte su draugais", 5);
        expect(ltHits.length).toBeGreaterThan(0);
        // Same-language hit must rank first.
        expect(ltHits[0].memory.language).toBe("lt");
    });

    test("cross-lingual bridge surfaces other-language memory when flagged", () => {
        store.addMemory({ content: "The user has a cat named Whiskers.", importance: 0.95 });
        const retriever = new MemoryRetriever(store);
        // LT query containing the bridge word "katė" -> EN "cat".
        const hits = retriever.search("mano katė yra labai graži ir miela", 5);
        const bridged = hits.filter((h) => h.viaBridge);
        expect(bridged.length).toBeGreaterThan(0);
        expect(bridged[0].memory.content).toContain("Whiskers");
    });

    test("crossLingual:false disables bridge", () => {
        store.addMemory({ content: "The user has a cat named Whiskers.", importance: 0.95 });
        const retriever = new MemoryRetriever(store);
        const hits = retriever.search("mano katė yra labai graži ir miela", 5, null, { crossLingual: false });
        expect(hits.filter((h) => h.viaBridge).length).toBe(0);
    });

    test("language pools aggregate separately", () => {
        store.addMemory("Labas, kaip sekasi šiandien su tavimi?");
        store.addMemory("The user prefers tea over coffee in the morning meetings.");
        const lt = store.listMemories({ status: "active", language: "lt" });
        const en = store.listMemories({ status: "active", language: "en" });
        const all = store.listMemories({ status: "active" });
        // Pools are subsets of the whole; no memory counted twice across
        // concrete pools (shared rows appear in both filtered views by design).
        expect(all.length).toBe(2);
        expect(lt.length + en.length).toBeGreaterThanOrEqual(2);
    });

    test("updateMemory re-detects language", () => {
        const m = store.addMemory("The user prefers tea over coffee in the morning meetings.");
        const res = store.updateMemory(m.id, "Labas, ačiū už pagalbą su kompiuteriu šiandien!");
        expect(res.success).toBe(true);
        const updated = store.getMemory(m.id);
        expect(updated.language).toBe("lt");
    });

    test("detectLanguage routes Spanish and Italian turns", () => {
        expect(detectLanguage("Hola, ¿cómo estás? Gracias por tu ayuda hoy").code).toBe("es");
        expect(detectLanguage("Ciao, come stai? Grazie per il tuo aiuto oggi").code).toBe("it");
        expect(normalizeLanguageCode("Italian")).toBe("it");
        expect(normalizeLanguageCode("Spanish")).toBe("es");
        expect(normalizeLanguageCode("Portuguese")).toBe("pt");
    });

    test("bridge translates between any supported pair via pivots", () => {
        expect(bridgeTranslateToken("gatto", "it", "en")).toBe("cat");
        expect(bridgeTranslateToken("cat", "en", "it")).toBe("gatto");
        expect(bridgeTranslateToken("gato", "es", "it")).toBe("gatto");
        expect(bridgeTranslateToken("libro", "it", "es")).toBe("libro");
        expect(bridgeTranslateToken("question", "en", "es")).toBe("pregunta");
        expect(bridgeTranslateToken("obrigado", "pt", "en")).toBe("thanks");
    });

    test("Spanish query bridges to Italian memory", () => {
        store.addMemory({ content: "Il mio gatto si chiama Whiskers e come stai oggi con questo nome.", importance: 0.95 });
        const retriever = new MemoryRetriever(store);
        const hits = retriever.search("mi gato es muy bonito y lo quiero mucho", 5);
        const bridged = hits.filter((h) => h.viaBridge);
        expect(bridged.length).toBeGreaterThan(0);
        expect(bridged[0].memory.content).toContain("Whiskers");
    });

    test("no closed list: any ISO code is a valid pool", () => {
        expect(normalizeLanguageCode("ja")).toBe("ja");
        expect(normalizeLanguageCode("nl")).toBe("nl");
        expect(normalizeLanguageCode("pt-BR")).toBe("pt");
        expect(normalizeLanguageCode("xx-bogus")).toBeNull();
        expect(languageName("ja")).toBe("Japanese");
        // Unlisted codes fall back to the code itself, never "Unknown".
        expect(languageName("sw")).toBe("SW");
        const m = store.addMemory({ content: "Whatever the words, explicit code wins.", language: "sw" });
        expect(m.language).toBe("sw");
        const only = store.listMemories({ status: "active", language: "sw" });
        expect(only.some((x) => x.id === m.id)).toBe(true);
    });

    test("detectLanguage routes scripts and Ukrainian", () => {
        expect(detectLanguage("こんにちは、元気ですか").code).toBe("ja");
        expect(detectLanguage("안녕하세요, 어떻게 지내세요").code).toBe("ko");
        expect(detectLanguage("你好，你好吗").code).toBe("zh");
        expect(detectLanguage("مرحبا، كيف حالك").code).toBe("ar");
        expect(detectLanguage("Привіт, як справи").code).toBe("uk");
        expect(detectLanguage("Hallo, hoe gaat het vandaag met jou").code).toBe("nl");
    });
});

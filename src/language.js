/**
 * Multilanguage memory layer — language detection + translation bridge.
 *
 * Mental model (human-brain-like):
 * - Each memory is stored in the language it was learned in (`language` code,
 *   e.g. "lt", "en", "ja"). This gives per-language pools backed by
 *   per-language files (`memory.lt.json`, `memory.en.json`, ...).
 * - There is NO closed language list: any ISO 639 code (any language the
 *   model supports) gets its own pool automatically. The name table below is
 *   display-only; unknown codes fall back to the code itself.
 * - Retrieval is language-scoped: the current turn language selects its own
 *   pool first (+ shared/undetermined memories which belong to everyone).
 * - The overall pool still works together: high-value memories from other
 *   languages can surface through a lightweight cross-lingual bridge
 *   (translated query tokens, importance-gated, penalised score, flagged
 *   as `viaBridge`), enabling intersections / associations / cross-references
 *   without polluting the active language context.
 */

export const LANGUAGE_SHARED = "shared";
export const LANGUAGE_UNKNOWN = "und";

// Display names only — NOT an allowlist. Any ISO 639-1/639-3 code is a valid
// pool (see normalizeLanguageCode); codes missing here render uppercased.
export const SUPPORTED_LANGUAGES = {
    en: "English",
    lt: "Lithuanian",
    ru: "Russian",
    uk: "Ukrainian",
    de: "German",
    fr: "French",
    es: "Spanish",
    it: "Italian",
    pt: "Portuguese",
    nl: "Dutch",
    sv: "Swedish",
    da: "Danish",
    no: "Norwegian",
    fi: "Finnish",
    cs: "Czech",
    sk: "Slovak",
    ro: "Romanian",
    hu: "Hungarian",
    pl: "Polish",
    lv: "Latvian",
    el: "Greek",
    tr: "Turkish",
    ja: "Japanese",
    ko: "Korean",
    zh: "Chinese",
    hi: "Hindi",
    ar: "Arabic",
    he: "Hebrew",
    th: "Thai",
    vi: "Vietnamese",
    id: "Indonesian",
    ms: "Malay",
    ka: "Georgian",
    hy: "Armenian",
};

const CODE_ALIASES = {
    english: "en",
    en: "en",
    eng: "en",
    lithuanian: "lt",
    lietuviu: "lt",
    lietuvių: "lt",
    lt: "lt",
    lit: "lt",
    russian: "ru",
    ru: "ru",
    rus: "ru",
    ukrainian: "uk",
    ukraina: "uk",
    uk: "uk",
    ukr: "uk",
    german: "de",
    deutsch: "de",
    de: "de",
    ger: "de",
    french: "fr",
    francais: "fr",
    français: "fr",
    fr: "fr",
    spanish: "es",
    espanol: "es",
    español: "es",
    es: "es",
    italian: "it",
    italiano: "it",
    it: "it",
    ita: "it",
    portuguese: "pt",
    portugues: "pt",
    português: "pt",
    pt: "pt",
    por: "pt",
    dutch: "nl",
    nederlands: "nl",
    nl: "nl",
    dut: "nl",
    swedish: "sv",
    svenska: "sv",
    sv: "sv",
    swe: "sv",
    danish: "da",
    dansk: "da",
    da: "da",
    dan: "da",
    norwegian: "no",
    norsk: "no",
    no: "no",
    nor: "no",
    nb: "no",
    nn: "no",
    finnish: "fi",
    suomi: "fi",
    fi: "fi",
    fin: "fi",
    czech: "cs",
    cestina: "cs",
    čeština: "cs",
    cs: "cs",
    cze: "cs",
    slovak: "sk",
    slovencina: "sk",
    slovenčina: "sk",
    sk: "sk",
    slo: "sk",
    romanian: "ro",
    romana: "ro",
    română: "ro",
    ro: "ro",
    rum: "ro",
    hungarian: "hu",
    magyar: "hu",
    hu: "hu",
    hun: "hu",
    japanese: "ja",
    ja: "ja",
    jpn: "ja",
    korean: "ko",
    ko: "ko",
    kor: "ko",
    chinese: "zh",
    zh: "zh",
    chi: "zh",
    zho: "zh",
    hindi: "hi",
    hi: "hi",
    hin: "hi",
    arabic: "ar",
    ara: "ar",
    ar: "ar",
    hebrew: "he",
    heb: "he",
    he: "he",
    thai: "th",
    tha: "th",
    th: "th",
    vietnamese: "vi",
    vi: "vi",
    vie: "vi",
    indonesian: "id",
    indonesia: "id",
    id: "id",
    ind: "id",
    malay: "ms",
    melayu: "ms",
    ms: "ms",
    msa: "ms",
    greek: "el",
    ellinika: "el",
    ελληνικά: "el",
    el: "el",
    gre: "el",
    ell: "el",
    turkish: "tr",
    turkce: "tr",
    türkçe: "tr",
    tr: "tr",
    tur: "tr",
    georgian: "ka",
    ka: "ka",
    geo: "ka",
    kat: "ka",
    armenian: "hy",
    hy: "hy",
    arm: "hy",
    hye: "hy",
    polish: "pl",
    polski: "pl",
    pl: "pl",
    latvian: "lv",
    latviesu: "lv",
    latviešu: "lv",
    lv: "lv",
    shared: LANGUAGE_SHARED,
    global: LANGUAGE_SHARED,
    all: LANGUAGE_SHARED,
    und: LANGUAGE_UNKNOWN,
    unknown: LANGUAGE_UNKNOWN,
};

export function normalizeLanguageCode(code) {
    if (code === undefined || code === null) return null;
    let clean = String(code).trim().toLowerCase();
    if (!clean) return null;
    if (CODE_ALIASES[clean]) return CODE_ALIASES[clean];
    // BCP 47 tags ("pt-BR", "en_US") collapse to their primary subtag, but
    // only with a well-formed region (2 letters / 3 digits) — anything else
    // ("xx-bogus") is rejected rather than guessed.
    if (/[-_]/.test(clean)) {
        const parts = clean.split(/[-_]/);
        const restOk = parts.slice(1).every((p) => /^[a-z]{2}$/.test(p) || /^[0-9]{3}$/.test(p));
        if (!/^[a-z]{2,3}$/.test(parts[0]) || !restOk) return null;
        clean = parts[0];
        if (CODE_ALIASES[clean]) return CODE_ALIASES[clean];
    }
    // Bare ISO-639 lookup for known display names.
    const short = clean.slice(0, 2);
    if (SUPPORTED_LANGUAGES[short]) return short;
    // Open-ended: any ISO 639-1/639-2 code is a valid pool — the layer
    // supports whatever languages the model supports, no allowlist.
    if (/^[a-z]{2,3}$/.test(clean)) return clean;
    return null;
}

export function languageName(code) {
    const norm = normalizeLanguageCode(code);
    if (!norm) return "Unknown";
    if (norm === LANGUAGE_SHARED) return "Shared";
    if (norm === LANGUAGE_UNKNOWN) return "Undetermined";
    return SUPPORTED_LANGUAGES[norm] || norm.toUpperCase();
}

export function isSharedLanguage(code) {
    const norm = normalizeLanguageCode(code);
    return norm === LANGUAGE_SHARED || norm === LANGUAGE_UNKNOWN || norm === null;
}

// --- Heuristic detection -------------------------------------------------

const LT_DIACRITICS = /[ąčęėįšųūžĄČĘĖĮŠŲŪŽ]/;
const CYRILLIC = /[\u0400-\u04FF]/;
const UK_MARKERS = /[іїєґІЇЄҐ]/;
const HIRAGANA_KATAKANA = /[\u3040-\u30FF]/;
const HANGUL = /[\u1100-\u11FF\uAC00-\uD7AF]/;
const HAN = /[\u4E00-\u9FFF]/;
const ARABIC = /[\u0600-\u06FF]/;
const HEBREW = /[\u0590-\u05FF]/;
const THAI = /[\u0E00-\u0E7F]/;
const DEVANAGARI = /[\u0900-\u097F]/;
const GREEK = /[\u0370-\u03FF]/;
const GEORGIAN = /[\u10A0-\u10FF]/;
const ARMENIAN = /[\u0530-\u058F]/;
const GERMAN_HINT = /[äöüßÄÖÜ]/;
const FRENCH_HINT = /[àâçéèêëîïôûùÿœæ]/;
const SPANISH_HINT = /[áéíóúñ¿¡]/;
const POLISH_HINT = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;

const STOPWORDS = {
    lt: new Set("ir,yra,kaip,kas,aš,tu,jis,ji,mes,jūs,jie,ne,tai,su,į,iš,ar,bet,kad,kur,kada,labai,mano,tavo,mūsų,noriu,norėčiau,prašau,ačiū,taip,ne,koks,kokia,kuris,kuri,dėl,apie,tačiau,jei,nes,kol,per,po,prie,tarp,visi,visas,gal,galite,gali,nėra,nėra,yra,buvo,bus,turėtų,reikia,kaip,čia,ten,dabar,tada,šiandien,kas,ko,ką,kam,kuo,kur,kodėl,vartotojas,naudotojas,mėgsta,patinka,pageidauja,nori,prisiminti,pokalbis,padėjėjas,lietuvių,anglų,labas,viso,gero,ačiū".split(",")),
    en: new Set("the,and,that,with,have,this,from,they,will,would,there,their,what,about,which,when,your,can,said,each,make,like,into,over,after,before,between,through,remember,please,thanks,hello,know,think,want,need,could,should,my,favorite,project,goal,memory,because,while,user,users,prefers,prefer,wants,conversation,assistant,english,lithuanian,language,today,tomorrow,good,morning,evening,night".split(",")),
    ru: new Set("и,в,не,на,что,это,как,для,или,его,ее,меня,тебя,хочу,пожалуйста,спасибо,да,нет,мой,моя,твой,твоя,есть,был,была,будет,можно,нужно,потому,чтобы,когда,где,почему,сегодня,меня,нас,вас,этот,эта,который,которая,меня".split(",")),
    de: new Set("und,der,die,das,ist,nicht,mit,von,für,auf,haben,werden,dass,diese,dieser,meine,deine,bitte,danke,heute,hier,dort,jetzt,dann,warum,wo,wann,welche,mein,mein,kein,auch,nur,oder,aber,weil,wenn".split(",")),
    fr: new Set("les,des,une,est,sont,avec,pour,dans,plus,cette,mon,ton,merci,bonjour,oui,non,mais,comme,avec,être,avoir,faire,peut,doit,parce,quand,comment,pourquoi,aujourd,ici,maintenant".split(",")),
    es: new Set("los,las,una,está,están,con,para,pero,porque,gracias,hola,hoy,aquí,ahora,donde,cuando,cómo,por,qué,mi,tu,mis,muy,también,solo,hacer,puede,debe,tiene,soy,eres,somos,quiero,recuerda,nombre,pregunta,idioma,español,nuevo,buenos,días".split(",")),
    it: new Set("che,una,uno,sono,come,con,per,alla,dal,dei,delle,questo,questa,quello,quella,grazie,ciao,prego,oggi,domani,dove,quando,perché,quanto,quale,come,può,deve,fare,molto,anche,solo,sono,siamo,sono,voglio,ricorda,nome,domanda,lingua,italiano,buongiorno,buonasera".split(",")),
    pt: new Set("que,uma,como,com,para,pelo,pela,este,esta,isso,obrigado,olá,hoje,amanhã,onde,quando,porque,quanto,qual,pode,deve,fazer,muito,também,quero,lembra,nome,pergunta,idioma,português,bom,dia".split(",")),
    pl: new Set("nie,jest,są,moje,twoje,proszę,dziękuję,tak,nie,ale,jak,gdzie,kiedy,dlaczego,dzisiaj,tutaj,teraz,ponieważ,chcę,potrzebuję,może,który,która,przez,dla,przy,witam".split(",")),
    lv: new Set("ir,nav,es,tu,mans,tavs,paldies,lūdzu,jā,nē,bet,kā,kur,kad,kadēļ,jo,ja,kad,šodien,šeit,tagad,kāpēc,vēlos,vajag,var".split(",")),
    uk: new Set("і,та,що,це,як,для,або,його,її,мене,тебе,хочу,будь,ласка,дякую,так,ні,мій,моя,твій,твоя,є,був,була,буде,можна,треба,тому,щоб,коли,де,чому,сьогодні,цей,ця,який,яка".split(",")),
    nl: new Set("een,van,het,niet,met,voor,naar,heeft,hebben,worden,maar,omdat,als,toen,waar,wanneer,welke,mijn,jouw,alstublieft,bedankt,hallo,vandaag,hier,daar,nu,dan,waarom,hoe,wat,wie,ook,alleen,maar,door,graag,wil,herinner,naam,vraag,taal,nederlands".split(",")),
    sv: new Set("och,det,att,med,för,från,har,inte,men,eftersom,när,var,när,vem,vilken,min,din,tack,hej,idag,här,där,nu,då,varför,hur,också,bara,genom,gärna,vill,minns,namn,fråga,språk,svenska".split(",")),
    da: new Set("ikke,også,men,fordi,når,hvor,hvem,hvilken,min,din,tak,hej,idag,her,der,nu,så,hvorfor,hvordan,også,kun,gennem,gerne,vil,husker,navn,spørgsmål,sprog,dansk".split(",")),
    no: new Set("ikke,også,men,fordi,når,hvor,hvem,hvilken,min,din,takk,hei,idag,her,der,nå,så,hvorfor,hvordan,også,bare,gjennom,gjerne,vil,husker,navn,spørsmål,språk,norsk".split(",")),
    fi: new Set("minä,sinä,hän,se,olemme,olette,ovat,eivät,mutta,koska,kun,missä,milloin,miksi,miten,minun,sinun,kiitos,hei,tänään,täällä,nyt,silloin,myös,vain,haluan,muista,nimi,kysymys,kieli,suomi".split(",")),
    cs: new Set("ne,jsou,moje,tvoje,prosím,děkuji,ano,ale,jak,kde,kdy,proč,dnes,tady,teď,protože,chci,pamatuj,jméno,otázka,jazyk,čeština".split(",")),
    sk: new Set("nie,sú,moje,tvoje,prosím,ďakujem,áno,ale,ako,kde,kedy,prečo,dnes,tu,teraz,pretože,chcem,pamätaj,meno,otázka,jazyk,slovenčina".split(",")),
    ro: new Set("nu,sunt,mele,tale,vă,rog,mulțumesc,bună,azi,aici,acum,atunci,de,ce,cum,când,unde,cine,care,vreau,amintește,nume,întrebare,limbă,română".split(",")),
    hu: new Set("nem,vannak,enyém,tied,kérem,köszönöm,igen,de,hogyan,hol,mikor,miért,ma,itt,most,akkor,mert,akarom,emlékezz,név,kérdés,nyelv,magyar".split(",")),
    id: new Set("yang,dan,dari,untuk,dengan,ini,itu,saya,kamu,tidak,telah,karena,ketika,dimana,kapan,mengapa,bagaimana,ingin,ingat,nama,pertanyaan,bahasa,indonesia,terima,kasih".split(",")),
};

function countStopwords(tokens, lang) {
    const set = STOPWORDS[lang];
    if (!set) return 0;
    let n = 0;
    for (const t of tokens) if (set.has(t)) n++;
    return n;
}

/**
 * Heuristic language detection (offline, dependency-free).
 * Returns { code, confidence, scores }.
 * - `code` is any ISO 639 code ("lt", "en", "ja", ...) or "und" (undetermined
 *   → treated as shared). Non-Latin scripts route by Unicode block; Latin
 *   text scores against per-language stopword sets. Languages with no
 *   stopword table still work end-to-end (explicit codes, per-language
 *   files, scoped pools) — only auto-detection falls back to shared.
 */
export function detectLanguage(text) {
    if (!text || typeof text !== "string" || !text.trim()) {
        return { code: LANGUAGE_UNKNOWN, confidence: 0, scores: {} };
    }
    const t = text.trim();
    // Very short / code-like / numeric turns carry no language signal.
    if (t.length < 3 || /^[\d\s\p{P}]+$/u.test(t)) {
        return { code: LANGUAGE_UNKNOWN, confidence: 0, scores: {} };
    }

    if (LT_DIACRITICS.test(t)) return { code: "lt", confidence: 0.95, scores: { lt: 1 } };
    // Non-Latin scripts route by Unicode block — no tables needed, so any
    // model-supported language in these scripts gets its own pool for free.
    // Kana is checked before Han so Japanese (kanji + kana mix) wins over Chinese.
    if (HIRAGANA_KATAKANA.test(t)) return { code: "ja", confidence: 0.9, scores: { ja: 1 } };
    if (HANGUL.test(t)) return { code: "ko", confidence: 0.9, scores: { ko: 1 } };
    if (HAN.test(t)) return { code: "zh", confidence: 0.85, scores: { zh: 1 } };
    if (ARABIC.test(t)) return { code: "ar", confidence: 0.9, scores: { ar: 1 } };
    if (HEBREW.test(t)) return { code: "he", confidence: 0.9, scores: { he: 1 } };
    if (THAI.test(t)) return { code: "th", confidence: 0.9, scores: { th: 1 } };
    if (DEVANAGARI.test(t)) return { code: "hi", confidence: 0.9, scores: { hi: 1 } };
    if (GREEK.test(t)) return { code: "el", confidence: 0.9, scores: { el: 1 } };
    if (GEORGIAN.test(t)) return { code: "ka", confidence: 0.9, scores: { ka: 1 } };
    if (ARMENIAN.test(t)) return { code: "hy", confidence: 0.9, scores: { hy: 1 } };
    if (CYRILLIC.test(t)) {
        // Ukrainian-specific letters disambiguate; otherwise score ru/uk tables.
        if (UK_MARKERS.test(t)) return { code: "uk", confidence: 0.9, scores: { uk: 1 } };
        const tokens = t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
        const ru = countStopwords(tokens, "ru");
        const uk = countStopwords(tokens, "uk");
        if (uk > ru && uk > 0) return { code: "uk", confidence: 0.7, scores: { uk, ru } };
        if (ru > 0) return { code: "ru", confidence: 0.7, scores: { ru, uk } };
        return { code: "ru", confidence: 0.5, scores: { ru: 0, uk: 0 } };
    }

    const tokens = t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { code: LANGUAGE_UNKNOWN, confidence: 0, scores: {} };

    const scores = {};
    for (const lang of Object.keys(STOPWORDS)) {
        scores[lang] = countStopwords(tokens, lang);
    }

    // Script hints (weak signals, only when stopwords tie).
    if (GERMAN_HINT.test(t)) scores.de = (scores.de || 0) + 0.5;
    if (FRENCH_HINT.test(t)) scores.fr = (scores.fr || 0) + 0.5;
    if (SPANISH_HINT.test(t)) scores.es = (scores.es || 0) + 0.5;
    if (POLISH_HINT.test(t)) scores.pl = (scores.pl || 0) + 0.5;

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [best, bestCount] = ranked[0];
    const secondCount = ranked[1] ? ranked[1][1] : 0;

    if (bestCount === 0) return { code: LANGUAGE_UNKNOWN, confidence: 0, scores };
    // Single stopword hit on a short text is weak — keep it but low confidence.
    const confidence = bestCount >= 3
        ? Math.min(0.95, 0.6 + 0.1 * (bestCount - secondCount))
        : bestCount >= 2
            ? 0.6
            : tokens.length <= 4 ? 0.45 : 0.35;
    return { code: best, confidence, scores };
}

export function detectLanguageCode(text, fallback = LANGUAGE_UNKNOWN) {
    try {
        return detectLanguage(text).code || fallback;
    } catch {
        return fallback;
    }
}

// --- Per-language memory files -------------------------------------------

/** memory.json  ->  memory.lt.json / memory.en.json (shared pool stays in memory.json). */
export function languageFileFor(baseFilePath, langCode) {
    const norm = normalizeLanguageCode(langCode);
    if (!norm || norm === LANGUAGE_SHARED || norm === LANGUAGE_UNKNOWN) return baseFilePath;
    if (!baseFilePath || typeof baseFilePath !== "string") return `memory.${norm}.json`;
    const dot = baseFilePath.lastIndexOf(".");
    if (dot === -1) return `${baseFilePath}.${norm}`;
    return `${baseFilePath.slice(0, dot)}.${norm}${baseFilePath.slice(dot)}`;
}

/** memory.lt.json -> "lt"; memory.json -> null. */
export function languageFromFilePath(filePath) {
    if (!filePath || typeof filePath !== "string") return null;
    const m = filePath.match(/\.([a-z]{2})\.json$/i);
    if (!m) return null;
    return normalizeLanguageCode(m[1]);
}

// --- Multilingual translation bridge -------------------------------------
// Offline keyword bridge for cross-lingual association recall. This is NOT a
// full translator — it expands retrieval queries through English pivots so a
// question in ANY supported language can still match a high-value memory
// stored in another language (e.g. Spanish question -> Italian memory).
// LLM reply language is always the user's active language; bridge hits are
// labelled as such. Tables below map each language's core retrieval words to
// English; English->X inverses are derived automatically.

const LT_EN_BRIDGE = {
    "labas": "hello", "ačiū": "thanks", "prašau": "please", "taip": "yes", "ne": "no",
    "vardas": "name", "mėgstamiausias": "favorite", "mėgstama": "favorite", "mėgstu": "like",
    "patinka": "like", "noriu": "want", "norėčiau": "would like", "projektas": "project",
    "dirbu": "working", "kurti": "building", "tikslas": "goal", "atsimink": "remember",
    "atsiminti": "remember", "kalba": "language", "lietuvių": "lithuanian", "anglų": "english",
    "knyga": "book", "diena": "day", "šiandien": "today", "rytoj": "tomorrow",
    "namas": "house", "darbas": "work", "pinigai": "money", "laikas": "time",
    "žmogus": "person", "draugas": "friend", "šeima": "family", "maistas": "food",
    "vanduo": "water", "kava": "coffee", "arbata": "tea", "katė": "cat", "šuo": "dog",
    "kompiuteris": "computer", "telefonas": "phone", "programa": "program", "kodas": "code",
    "duomenys": "data", "saugumas": "security", "tinklas": "network", "serveris": "server",
    "naršyklė": "browser", "žaidimas": "game", "istorija": "story", "daina": "song",
    "filmas": "movie", "oras": "weather", "sveikata": "health", "meilė": "love",
    "bėda": "problem", "klausimas": "question", "atsakymas": "answer", "pagalba": "help",
    "aš": "i", "tu": "you", "jis": "he", "ji": "she", "mes": "we", "jie": "they",
    "mano": "my", "tavo": "your", "mūsų": "our", "yra": "is", "buvo": "was",
    "bus": "will be", "kaip": "how", "kas": "what", "kur": "where", "kada": "when",
    "kodėl": "why", "kiek": "how much", "kuris": "which", "geras": "good",
    "blogas": "bad", "didelis": "big", "mažas": "small", "naujas": "new",
    "senas": "old", "greitas": "fast", "lėtas": "slow",
};

const EN_LT_BRIDGE = {};
for (const [lt, en] of Object.entries(LT_EN_BRIDGE)) {
    const key = String(en).toLowerCase();
    if (!EN_LT_BRIDGE[key]) EN_LT_BRIDGE[key] = lt;
}

// Retrieval tokenizers (memory.js / knowledge.js) use ASCII-only `\w`, so
// LT diacritics are folded away before bridge lookup ("katė" -> "kat").
// Fold both sides so the offline bridge still matches those tokens.
function foldDiacritics(s) {
    try {
        return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    } catch {
        return String(s || "");
    }
}

const LT_EN_FOLD = {};
for (const [lt, en] of Object.entries(LT_EN_BRIDGE)) {
    const folded = foldDiacritics(lt).toLowerCase();
    if (folded && !LT_EN_FOLD[folded]) LT_EN_FOLD[folded] = en;
}

// Per-language core-word tables (-> English pivots) for every supported
// language beyond LT (LT keeps its richer table above). Accent-stripped
// variants are included so ASCII-folded retrieval tokens still match.
const TO_EN_ANY = {
    es: {
        "hola": "hello", "gracias": "thanks", "favor": "please", "sí": "yes", "si": "yes",
        "nombre": "name", "favorito": "favorite", "favorita": "favorite", "gusta": "like",
        "quiero": "want", "proyecto": "project", "trabajando": "working", "construyendo": "building",
        "objetivo": "goal", "meta": "goal", "recordar": "remember", "recuerda": "remember",
        "idioma": "language", "lengua": "language", "lituano": "lithuanian", "inglés": "english",
        "ingles": "english", "español": "spanish", "espanol": "spanish", "italiano": "italian",
        "libro": "book", "día": "day", "dia": "day", "hoy": "today", "mañana": "tomorrow",
        "manana": "tomorrow", "casa": "house", "trabajo": "work", "tiempo": "time",
        "persona": "person", "amigo": "friend", "familia": "family", "comida": "food",
        "agua": "water", "café": "coffee", "cafe": "coffee", "té": "tea", "gato": "cat",
        "perro": "dog", "ordenador": "computer", "computadora": "computer", "teléfono": "phone",
        "telefono": "phone", "programa": "program", "código": "code", "codigo": "code",
        "datos": "data", "seguridad": "security", "red": "network", "servidor": "server",
        "navegador": "browser", "juego": "game", "historia": "story", "canción": "song",
        "cancion": "song", "película": "movie", "pelicula": "movie", "clima": "weather",
        "salud": "health", "amor": "love", "problema": "problem", "pregunta": "question",
        "respuesta": "answer", "ayuda": "help",
        "yo": "i", "tú": "you", "tu": "you", "él": "he", "ella": "she",
        "nosotros": "we", "ellos": "they", "mi": "my", "nuestro": "our",
        "es": "is", "fue": "was", "será": "will be", "sera": "will be", "cómo": "how",
        "como": "how", "qué": "what", "dónde": "where", "donde": "where",
        "cuándo": "when", "cuando": "when", "porque": "why", "porqué": "why",
        "cuánto": "how much", "cuanto": "how much", "cuál": "which", "cual": "which",
        "bueno": "good", "malo": "bad", "grande": "big", "pequeño": "small",
        "pequeno": "small", "nuevo": "new", "viejo": "old", "rápido": "fast",
        "rapido": "fast", "lento": "slow",
    },
    it: {
        "ciao": "hello", "grazie": "thanks", "prego": "please", "sì": "yes",
        "nome": "name", "preferito": "favorite", "preferita": "favorite", "piace": "like",
        "voglio": "want", "progetto": "project", "lavorando": "working", "costruendo": "building",
        "obiettivo": "goal", "ricordare": "remember", "ricorda": "remember",
        "lingua": "language", "lituano": "lithuanian", "inglese": "english",
        "spagnolo": "spanish", "italiano": "italian",
        "libro": "book", "giorno": "day", "oggi": "today", "domani": "tomorrow",
        "casa": "house", "lavoro": "work", "tempo": "time", "persona": "person",
        "amico": "friend", "famiglia": "family", "cibo": "food", "acqua": "water",
        "caffè": "coffee", "caffe": "coffee", "tè": "tea", "gatto": "cat", "cane": "dog",
        "computer": "computer", "telefono": "phone", "programma": "program", "codice": "code",
        "dati": "data", "sicurezza": "security", "rete": "network", "server": "server",
        "browser": "browser", "gioco": "game", "storia": "story", "canzone": "song",
        "film": "movie", "meteo": "weather", "salute": "health", "amore": "love",
        "problema": "problem", "domanda": "question", "risposta": "answer", "aiuto": "help",
        "io": "i", "tu": "you", "lui": "he", "lei": "she", "noi": "we", "loro": "they",
        "mio": "my", "tuo": "your", "nostro": "our", "è": "is", "era": "was",
        "sarà": "will be", "sara": "will be", "come": "how", "cosa": "what",
        "dove": "where", "quando": "when", "perché": "why", "perche": "why",
        "quanto": "how much", "quale": "which", "buono": "good", "cattivo": "bad",
        "grande": "big", "piccolo": "small", "nuovo": "new", "vecchio": "old",
        "veloce": "fast", "lento": "slow",
    },
    pt: {
        "olá": "hello", "ola": "hello", "obrigado": "thanks", "obrigada": "thanks",
        "favor": "please", "sim": "yes", "não": "no", "nao": "no",
        "nome": "name", "favorito": "favorite", "favorita": "favorite", "gosta": "like",
        "quero": "want", "projeto": "project", "trabalhando": "working", "construindo": "building",
        "objetivo": "goal", "lembrar": "remember", "lembra": "remember",
        "idioma": "language", "língua": "language", "lingua": "language",
        "lituano": "lithuanian", "inglês": "english", "ingles": "english",
        "espanhol": "spanish", "italiano": "italian",
        "livro": "book", "dia": "day", "hoje": "today", "amanhã": "tomorrow",
        "amanha": "tomorrow", "casa": "house", "trabalho": "work", "tempo": "time",
        "pessoa": "person", "amigo": "friend", "família": "family", "familia": "family",
        "comida": "food", "água": "water", "agua": "water", "café": "coffee",
        "cafe": "coffee", "chá": "tea", "cha": "tea", "gato": "cat", "cão": "dog",
        "cao": "dog", "computador": "computer", "telefone": "phone", "programa": "program",
        "código": "code", "codigo": "code", "dados": "data", "segurança": "security",
        "seguranca": "security", "rede": "network", "servidor": "server",
        "navegador": "browser", "jogo": "game", "história": "story", "historia": "story",
        "canção": "song", "cancao": "song", "filme": "movie", "saúde": "health",
        "saude": "health", "amor": "love", "problema": "problem", "pergunta": "question",
        "resposta": "answer", "ajuda": "help",
        "eu": "i", "você": "you", "voce": "you", "ele": "he", "ela": "she",
        "nós": "we", "nos": "we", "eles": "they", "meu": "my", "seu": "your",
        "nosso": "our", "é": "is", "foi": "was", "será": "will be", "sera": "will be",
        "como": "how", "que": "what", "onde": "where", "quando": "when",
        "quanto": "how much", "qual": "which",
        "bom": "good", "mau": "bad", "grande": "big", "pequeno": "small",
        "novo": "new", "velho": "old", "rápido": "fast", "rapido": "fast", "lento": "slow",
    },
    de: {
        "hallo": "hello", "danke": "thanks", "bitte": "please", "ja": "yes", "nein": "no",
        "name": "name", "favorit": "favorite", "mag": "like", "will": "want",
        "projekt": "project", "arbeitend": "working", "bauen": "building", "ziel": "goal",
        "erinnern": "remember", "sprache": "language", "litauisch": "lithuanian",
        "englisch": "english", "spanisch": "spanish", "italienisch": "italian",
        "buch": "book", "tag": "day", "heute": "today", "morgen": "tomorrow",
        "haus": "house", "arbeit": "work", "zeit": "time", "person": "person",
        "freund": "friend", "familie": "family", "essen": "food", "wasser": "water",
        "kaffee": "coffee", "tee": "tea", "katze": "cat", "hund": "dog",
        "computer": "computer", "telefon": "phone", "programm": "program", "code": "code",
        "daten": "data", "sicherheit": "security", "netzwerk": "network", "server": "server",
        "browser": "browser", "spiel": "game", "geschichte": "story", "lied": "song",
        "film": "movie", "wetter": "weather", "gesundheit": "health", "liebe": "love",
        "problem": "problem", "frage": "question", "antwort": "answer", "hilfe": "help",
        "ich": "i", "du": "you", "er": "he", "wir": "we",
        "mein": "my", "dein": "your", "unser": "our", "ist": "is", "war": "was",
        "wird": "will be", "wie": "how", "was": "what", "wo": "where", "wann": "when",
        "warum": "why", "wieviel": "how much", "welche": "which", "gut": "good",
        "schlecht": "bad", "groß": "big", "gross": "big", "klein": "small",
        "neu": "new", "alt": "old", "schnell": "fast", "langsam": "slow",
    },
    fr: {
        "bonjour": "hello", "salut": "hello", "merci": "thanks", "plaît": "please",
        "plait": "please", "oui": "yes", "non": "no",
        "nom": "name", "favori": "favorite", "aime": "like", "veux": "want",
        "projet": "project", "travaillant": "working", "construire": "building",
        "objectif": "goal", "rappeler": "remember", "langue": "language",
        "lituanien": "lithuanian", "anglais": "english", "espagnol": "spanish",
        "italien": "italian",
        "livre": "book", "jour": "day", "demain": "tomorrow", "maison": "house",
        "travail": "work", "temps": "time", "personne": "person", "ami": "friend",
        "famille": "family", "nourriture": "food", "eau": "water", "café": "coffee",
        "cafe": "coffee", "thé": "tea", "chat": "cat", "chien": "dog",
        "ordinateur": "computer", "téléphone": "phone", "telephone": "phone",
        "programme": "program", "code": "code", "données": "data", "donnees": "data",
        "sécurité": "security", "securite": "security", "réseau": "network", "reseau": "network",
        "serveur": "server", "navigateur": "browser", "jeu": "game", "histoire": "story",
        "chanson": "song", "film": "movie", "météo": "weather", "meteo": "weather",
        "santé": "health", "sante": "health", "amour": "love", "problème": "problem",
        "probleme": "problem", "question": "question", "réponse": "answer", "reponse": "answer",
        "aide": "help",
        "je": "i", "tu": "you", "il": "he", "elle": "she", "nous": "we", "ils": "they",
        "mon": "my", "ton": "your", "notre": "our", "est": "is", "était": "was",
        "etait": "was", "sera": "will be", "comment": "how", "quoi": "what",
        "où": "where", "quand": "when", "pourquoi": "why",
        "combien": "how much", "quel": "which", "bon": "good", "mauvais": "bad",
        "grand": "big", "petit": "small", "nouveau": "new", "vieux": "old",
        "rapide": "fast", "lent": "slow",
    },
    ru: {
        "привет": "hello", "спасибо": "thanks", "пожалуйста": "please", "да": "yes", "нет": "no",
        "имя": "name", "любимый": "favorite", "нравится": "like", "хочу": "want",
        "проект": "project", "цель": "goal", "запомнить": "remember", "помнить": "remember",
        "язык": "language", "книга": "book", "день": "day", "сегодня": "today",
        "завтра": "tomorrow", "дом": "house", "работа": "work", "время": "time",
        "друг": "friend", "семья": "family", "еда": "food", "вода": "water",
        "кот": "cat", "кошка": "cat", "собака": "dog", "компьютер": "computer",
        "телефон": "phone", "код": "code", "данные": "data", "игра": "game",
        "история": "story", "песня": "song", "фильм": "movie", "любовь": "love",
        "проблема": "problem", "вопрос": "question", "ответ": "answer", "помощь": "help",
        "хороший": "good", "плохой": "bad", "большой": "big", "маленький": "small",
        "новый": "new", "старый": "old", "быстрый": "fast", "медленный": "slow",
        "что": "what", "где": "where", "когда": "when", "почему": "why", "как": "how",
    },
    pl: {
        "cześć": "hello", "czesc": "hello", "dziękuję": "thanks", "dziekuje": "thanks",
        "proszę": "please", "prosze": "please", "tak": "yes", "nie": "no",
        "imię": "name", "imie": "name", "ulubiony": "favorite", "lubię": "like",
        "lubie": "like", "chcę": "want", "chce": "want", "projekt": "project",
        "cel": "goal", "pamiętać": "remember", "pamietac": "remember", "język": "language",
        "jezyk": "language", "pytanie": "question", "odpowiedź": "answer", "odpowiedz": "answer",
        "książka": "book", "ksiazka": "book", "dzień": "day", "dzien": "day",
        "dzisiaj": "today", "jutro": "tomorrow", "dom": "house", "praca": "work",
        "czas": "time", "przyjaciel": "friend", "rodzina": "family", "jedzenie": "food",
        "woda": "water", "kot": "cat", "pies": "dog", "komputer": "computer",
        "telefon": "phone", "kod": "code", "gra": "game", "miłość": "love",
        "milosc": "love", "problem": "problem", "pomoc": "help",
        "dobry": "good", "zły": "bad", "zly": "bad", "duży": "big", "duzy": "big",
        "mały": "small", "maly": "small", "nowy": "new", "stary": "old",
        "co": "what", "gdzie": "where", "kiedy": "when", "dlaczego": "why", "jak": "how",
    },
    lv: {
        "sveiki": "hello", "paldies": "thanks", "lūdzu": "please", "ludzu": "please",
        "jā": "yes", "nē": "no",
        "vārds": "name", "vards": "name", "mīļākais": "favorite", "milakais": "favorite",
        "patīk": "like", "patik": "like", "gribu": "want", "vēlos": "want", "velos": "want",
        "projekts": "project", "mērķis": "goal", "merkis": "goal", "atcerēties": "remember",
        "atcereties": "remember", "valoda": "language", "jautājums": "question",
        "jautajums": "question", "atbilde": "answer", "grāmata": "book", "gramata": "book",
        "diena": "day", "šodien": "today", "sodien": "today", "rīt": "tomorrow", "rit": "tomorrow",
        "māja": "house", "maja": "house", "darbs": "work", "laiks": "time",
        "draugs": "friend", "ģimene": "family", "gimene": "family", "ēdiens": "food",
        "ediens": "food", "ūdens": "water", "udens": "water", "kaķis": "cat", "kakis": "cat",
        "suns": "dog", "dators": "computer", "tālrunis": "phone", "talrunis": "phone",
        "kods": "code", "spēle": "game", "spele": "game", "mīlestība": "love",
        "milestiba": "love", "problēma": "problem", "problema": "problem", "palīdzība": "help",
        "palidziba": "help", "labs": "good", "slikts": "bad", "liels": "big",
        "mazs": "small", "jauns": "new", "vecs": "old",
        "kas": "what", "kur": "where", "kad": "when", "kāpēc": "why", "kapec": "why",
        "kā": "how", "ka": "how",
    },
};

// English->X inverses (first spelling wins) + folded-key fallbacks so
// ASCII-folded tokens (memory.js uses diacritic-folded matching) resolve.
const EN_TO_ANY = {};
const FOLD_ANY = {};
for (const [lang, dict] of Object.entries(TO_EN_ANY)) {
    const inv = {};
    const fold = {};
    for (const [word, pivot] of Object.entries(dict)) {
        const key = String(pivot).toLowerCase();
        if (!inv[key]) inv[key] = word;
        const folded = foldDiacritics(word).toLowerCase();
        if (folded && folded !== word.toLowerCase() && !fold[folded]) fold[folded] = pivot;
    }
    EN_TO_ANY[lang] = inv;
    FOLD_ANY[lang] = fold;
}

export function bridgeTranslateToken(token, from, to) {
    const t = String(token || "").toLowerCase();
    if (!t) return null;
    const f = normalizeLanguageCode(from);
    const target = normalizeLanguageCode(to);
    if (!f || !target || f === target) return null;
    if (f === "lt" && target === "en") return LT_EN_BRIDGE[t] || LT_EN_FOLD[foldDiacritics(t)] || null;
    if (f === "en" && target === "lt") return EN_LT_BRIDGE[t] || null;
    // General path: any supported pair via English pivots.
    if (f === "en") return EN_TO_ANY[target]?.[t] || null;
    const dict = TO_EN_ANY[f];
    let pivot = dict?.[t] || null;
    if (!pivot && dict) {
        const folded = foldDiacritics(t);
        pivot = dict[folded] || FOLD_ANY[f]?.[folded] || null;
    }
    if (!pivot) return null;
    if (target === "en") return pivot;
    return EN_TO_ANY[target]?.[String(pivot).toLowerCase()] || null;
}

/** Expand a token list with bridge translations (deduped). */
export function expandTokensWithBridge(tokens, from, to) {
    const out = [...tokens];
    const seen = new Set(tokens.map((t) => String(t).toLowerCase()));
    for (const tok of tokens) {
        const tr = bridgeTranslateToken(tok, from, to);
        if (tr) {
            for (const part of String(tr).toLowerCase().split(/\s+/)) {
                if (part && !seen.has(part)) {
                    seen.add(part);
                    out.push(part);
                }
            }
        }
    }
    return out;
}

// --- Prompt helpers -------------------------------------------------------

/** Short system-prompt note describing the active language memory scope. */
export function buildLanguageScopeNote(activeLang, bridgeHits = 0) {
    const norm = normalizeLanguageCode(activeLang);
    if (!norm || norm === LANGUAGE_SHARED || norm === LANGUAGE_UNKNOWN) return "";
    const name = languageName(norm);
    let note = `[Language scope: user is writing in ${name} (${norm}). Prefer ${name} memories + shared memories.`;
    if (bridgeHits > 0) {
        note += ` ${bridgeHits} related memorie(s) from other language(s) are included via translation bridge — use them for associations, but reply in ${name}.`;
    } else {
        note += ` Reply in ${name}.`;
    }
    return note + "]";
}

/** Extract an explicit `--lang xx` / `lang:xx` filter from a command string. */
export function extractLanguageFilter(text) {
    if (!text || typeof text !== "string") return { rest: text, lang: null };
    let lang = null;
    let rest = text;
    const m = rest.match(/(?:^|\s)--lang\s+([A-Za-z]{2,12})/);
    if (m) {
        lang = normalizeLanguageCode(m[1]);
        rest = rest.replace(m[0], " ").trim().replace(/\s+/g, " ");
    }
    const m2 = rest.match(/(?:^|\s)lang:([A-Za-z]{2,12})/i);
    if (m2 && !lang) {
        lang = normalizeLanguageCode(m2[1]);
        rest = rest.replace(m2[0], " ").trim().replace(/\s+/g, " ");
    }
    return { rest, lang };
}

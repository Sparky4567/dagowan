import fs from "node:fs";
import path from "node:path";

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 180;
const MAX_RETRIEVED_CHUNKS = 6;
const MAX_WRITE_ABOUT_CHUNKS = 12;

/**
 * Recursively scans directory for .md files.
 */
export function getMarkdownFiles(dirPath = "notes") {
    let target = path.isAbsolute(dirPath) ? dirPath : path.join(process.cwd(), dirPath);
    if (!fs.existsSync(target) && dirPath === "notes") {
        target = process.cwd();
    }
    if (!fs.existsSync(target)) return [];

    const files = [];
    function scan(current) {
        const stat = fs.statSync(current);
        if (stat.isFile() && current.endsWith(".md")) {
            const base = path.basename(current).toLowerCase();
            if (!base.startsWith(".") && !current.includes("node_modules") && !current.includes("pdfs") && !current.includes("backups")) {
                files.push(current);
            }
        } else if (stat.isDirectory()) {
            const base = path.basename(current);
            if (!base.startsWith(".") && base !== "node_modules" && base !== "pdfs" && base !== "backups") {
                const entries = fs.readdirSync(current);
                for (const entry of entries) {
                    scan(path.join(current, entry));
                }
            }
        }
    }

    scan(target);
    return files;
}

/**
 * Normalizes text content.
 */
export function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
}

/**
 * Splits document text into overlapping chunks.
 */
export function chunkText(text, filename, chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP) {
    const norm = normalizeText(text);
    if (!norm) return [];

    const chunks = [];
    let start = 0;
    let index = 1;

    while (start < norm.length) {
        const end = Math.min(start + chunkSize, norm.length);
        const content = norm.slice(start, end).trim();
        if (content) {
            chunks.push({
                filename,
                chunk_index: index++,
                text: content,
            });
        }
        if (end === norm.length) break;
        start = Math.max(0, end - overlap);
    }
    return chunks;
}

/**
 * Retrieves matching note chunks based on query word intersection.
 */
export function retrieveNotesChunks(query, dirPath = "notes", limit = MAX_RETRIEVED_CHUNKS) {
    if (!query || !query.trim()) return [];

    const queryWords = new Set(
        query.toLowerCase().match(/\w+/g) || []
    );
    if (queryWords.size === 0) return [];

    const mdFiles = getMarkdownFiles(dirPath);
    const allChunks = [];

    for (const file of mdFiles) {
        try {
            const content = fs.readFileSync(file, "utf8");
            const relName = path.relative(process.cwd(), file);
            const chunks = chunkText(content, relName);
            allChunks.push(...chunks);
        } catch {}
    }

    const scored = [];
    for (const chunk of allChunks) {
        const chunkWords = new Set(chunk.text.toLowerCase().match(/\w+/g) || []);
        let score = 0;
        for (const word of queryWords) {
            if (chunkWords.has(word)) score++;
        }
        if (score > 0) {
            scored.push({ score, chunk });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((item) => item.chunk);
}

/**
 * Builds a write-about prompt using note excerpts.
 */
export function writeAboutPrompt(topic, dirPath = "notes", limit = MAX_WRITE_ABOUT_CHUNKS) {
    const cleanTopic = normalizeText(topic);
    if (!cleanTopic) return { prompt: null, chunks: [] };

    let chunks = retrieveNotesChunks(cleanTopic, dirPath, limit);
    if (chunks.length === 0) {
        // Fallback to top chunks of any available markdown note
        const mdFiles = getMarkdownFiles(dirPath);
        for (const file of mdFiles) {
            try {
                const content = fs.readFileSync(file, "utf8");
                const relName = path.relative(process.cwd(), file);
                chunks.push(...chunkText(content, relName));
                if (chunks.length >= limit) break;
            } catch {}
        }
        chunks = chunks.slice(0, limit);
    }

    if (chunks.length === 0) {
        return { prompt: null, chunks: [] };
    }

    const excerptBlock = chunks
        .map(
            (c) => `[${c.filename} | chunk ${c.chunk_index}]\n${c.text}`
        )
        .join("\n\n");

    const prompt = `Write about the following topic using only the workspace note excerpts provided below. If the excerpts do not contain enough information, state what is missing instead of inventing details. Cite filenames when useful.\n\nTopic: ${cleanTopic}\n\nWorkspace note excerpts:\n${excerptBlock}`;

    return { prompt, chunks };
}

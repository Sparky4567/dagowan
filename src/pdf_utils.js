import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { marked } from "marked";
import { PDFParse } from "pdf-parse";
import { memoize } from "./utils/memoize.js";
import { renderManyPdfs, extractPdfInWorker } from "./utils/pdf_parallel.js";
import { getOptimalWorkerCount } from "./utils/concurrency.js";

/**
 * Parses a date filter string (e.g. "2026-07", "2026-07-15", "2026") into a Date object.
 */
function parseDateUncached(dateStr, defaultEnd = false) {
    if (!dateStr) return null;
    const str = dateStr.trim();
    try {
        if (/^\d{4}-\d{2}$/.test(str)) {
            const [y, m] = str.split("-").map(Number);
            if (defaultEnd) {
                return new Date(y, m, 0, 23, 59, 59);
            }
            return new Date(y, m - 1, 1, 0, 0, 0);
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
            const [y, m, d] = str.split("-").map(Number);
            if (defaultEnd) {
                return new Date(y, m - 1, d, 23, 59, 59);
            }
            return new Date(y, m - 1, d, 0, 0, 0);
        } else if (/^\d{4}$/.test(str)) {
            const y = Number(str);
            if (defaultEnd) {
                return new Date(y, 11, 31, 23, 59, 59);
            }
            return new Date(y, 0, 1, 0, 0, 0);
        }
    } catch {
        return null;
    }
    return null;
}

// Pure date-string parser reused across file filtering/sorting.
export const parseDate = memoize(parseDateUncached, { maxSize: 500 });

/**
 * Extracts a date from a file name or returns file modification time.
 */
export function extractFileDate(filePath) {
    const filename = path.basename(filePath);
    const matchYMD = filename.match(/(\d{4}-\d{2}-\d{2})/);
    if (matchYMD) {
        const [y, m, d] = matchYMD[1].split("-").map(Number);
        return new Date(y, m - 1, d);
    }
    const matchYM = filename.match(/(\d{4}-\d{2})/);
    if (matchYM) {
        const [y, m] = matchYM[1].split("-").map(Number);
        return new Date(y, m - 1, 1);
    }
    const stats = fs.statSync(filePath);
    return stats.mtime;
}

/**
 * Retrieves markdown files filtered by date range and sorted.
 */
export function getMarkdownFiles(directory, fromDate = "", toDate = "", sortMode = "name") {
    let files = [];
    const dirPath = path.resolve(directory);

    if (fs.existsSync(dirPath)) {
        const stat = fs.statSync(dirPath);
        if (stat.isFile() && dirPath.endsWith(".md")) {
            files = [dirPath];
        } else if (stat.isDirectory()) {
            function walk(dir) {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        const low = entry.name.toLowerCase();
                        if (!low.startsWith(".") && !["node_modules", "pdfs", "backups", "venv", ".venv"].includes(low)) {
                            walk(fullPath);
                        }
                    } else if (entry.isFile() && entry.name.endsWith(".md")) {
                        files.push(fullPath);
                    }
                }
            }
            walk(dirPath);
        }
    }

    const fromDt = parseDate(fromDate, false);
    const toDt = parseDate(toDate, true);

    const filtered = files.filter((filePath) => {
        const fileDt = extractFileDate(filePath);
        if (fromDt && fileDt < fromDt) return false;
        if (toDt && fileDt > toDt) return false;
        return true;
    });

    if (sortMode === "time") {
        filtered.sort((a, b) => extractFileDate(a) - extractFileDate(b));
    } else {
        filtered.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    }

    return filtered;
}

/**
 * Renders Markdown tokens into a PDFKit document.
 */
function renderMarkdownToPdfDoc(doc, markdownContent) {
    const tokens = marked.lexer(markdownContent);
    for (const token of tokens) {
        switch (token.type) {
            case "heading": {
                const size = token.depth === 1 ? 20 : token.depth === 2 ? 16 : 14;
                doc.moveDown(0.5);
                doc.font("Helvetica-Bold").fontSize(size).fillColor(token.depth === 1 ? "#0056b3" : "#222222");
                doc.text(token.text);
                doc.font("Helvetica").fontSize(11).fillColor("#333333");
                doc.moveDown(0.3);
                break;
            }
            case "paragraph": {
                doc.font("Helvetica").fontSize(11).fillColor("#333333");
                doc.text(token.text, { lineGap: 3 });
                doc.moveDown(0.5);
                break;
            }
            case "list": {
                doc.font("Helvetica").fontSize(11).fillColor("#333333");
                if (Array.isArray(token.items)) {
                    for (const item of token.items) {
                        doc.text(`  • ${item.text}`, { indent: 10, lineGap: 2 });
                    }
                }
                doc.moveDown(0.5);
                break;
            }
            case "code": {
                doc.font("Courier").fontSize(9.5).fillColor("#222222");
                doc.text(token.text, {
                    background: "#f4f4f4",
                    lineGap: 2,
                });
                doc.font("Helvetica").fontSize(11).fillColor("#333333");
                doc.moveDown(0.5);
                break;
            }
            case "blockquote": {
                doc.font("Helvetica-Oblique").fontSize(10.5).fillColor("#555555");
                doc.text(token.text, { indent: 15 });
                doc.font("Helvetica").fontSize(11).fillColor("#333333");
                doc.moveDown(0.5);
                break;
            }
            case "hr": {
                doc.moveDown(0.5);
                doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.options.margin * 2, doc.y).strokeColor("#cccccc").stroke();
                doc.moveDown(0.5);
                break;
            }
            case "space": {
                break;
            }
            default: {
                if (token.text) {
                    doc.font("Helvetica").fontSize(11).fillColor("#333333");
                    doc.text(token.text);
                    doc.moveDown(0.3);
                }
            }
        }
    }
}

/**
 * Creates a single PDF file from markdown content using PDFKit stream.
 * Exported so the worker fallback path and callers share one implementation.
 */
export function createPdfFromMarkdown(markdownContent, outputPath, title = "") {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40 });
        const stream = fs.createWriteStream(outputPath);

        doc.pipe(stream);

        if (title) {
            doc.font("Helvetica-Bold").fontSize(22).fillColor("#0056b3").text(title);
            doc.moveDown(0.5);
            doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor("#0056b3").stroke();
            doc.moveDown(0.8);
        }

        renderMarkdownToPdfDoc(doc, markdownContent);

        doc.end();

        stream.on("finish", () => resolve(outputPath));
        stream.on("error", (err) => reject(err));
    });
}

/**
 * Converts Markdown notes to PDF in output directory using pure JavaScript (PDFKit + Marked).
 *
 * Individual per-note PDFs render in parallel worker_threads
 * (`src/utils/pdf_worker.js`, bounded by CPU count); the merged batch PDF
 * stays single-threaded since it is one PDFKit document. Set
 * `useWorkers: false` to force the legacy sequential path.
 */
export async function convertNotesToPdf(inputDir = "notes", outputDir = "pdfs", fromDate = "", toDate = "", options = {}) {
    const inputPath = path.resolve(inputDir);
    const pdfDir = path.resolve(outputDir);

    if (!fs.existsSync(pdfDir)) {
        fs.mkdirSync(pdfDir, { recursive: true });
    }

    let mdFiles = getMarkdownFiles(inputPath, fromDate, toDate);
    if (mdFiles.length === 0 && path.basename(inputPath) === "notes" && !fs.existsSync(inputPath)) {
        mdFiles = getMarkdownFiles(".", fromDate, toDate);
    }

    if (mdFiles.length === 0) {
        return {
            success: false,
            error: `No markdown files found matching date range (${fromDate || "beginning"} to ${toDate || "latest"}).`,
        };
    }

    const createdPdfs = [];
    const { useWorkers = true, concurrency = 0, workerTimeoutMs = 60000 } = options || {};

    try {
        // 1. Generate individual PDF for each markdown note (parallel workers).
        const jobs = mdFiles.map((file) => {
            const stem = path.basename(file, ".md");
            return {
                file,
                stem,
                markdownContent: fs.readFileSync(file, "utf8"),
                title: stem,
                outputPath: path.join(pdfDir, `${stem}.pdf`),
            };
        });
        if (useWorkers && jobs.length > 1) {
            const workerLimit = concurrency > 0 ? concurrency : getOptimalWorkerCount(jobs.length);
            const rendered = await renderManyPdfs(
                jobs.map(({ markdownContent, title, outputPath }) => ({ markdownContent, title, outputPath })),
                {
                    concurrency: workerLimit,
                    timeoutMs: workerTimeoutMs,
                    onFallback: async (job) => createPdfFromMarkdown(job.markdownContent, job.outputPath, job.title),
                }
            );
            createdPdfs.push(...rendered);
        } else {
            for (const job of jobs) {
                await createPdfFromMarkdown(job.markdownContent, job.outputPath, job.title);
                createdPdfs.push(job.outputPath);
            }
        }

        // 2. Generate merged batch PDF
        const dFrom = fromDate ? fromDate.trim().replace(/:/g, "-") : "start";
        const dTo = toDate ? toDate.trim().replace(/:/g, "-") : "end";
        const batchFilename = `notes_${dFrom}_to_${dTo}.pdf`;
        const batchPdfPath = path.join(pdfDir, batchFilename);

        const doc = new PDFDocument({ margin: 40 });
        const batchStream = fs.createWriteStream(batchPdfPath);
        doc.pipe(batchStream);

        doc.font("Helvetica-Bold").fontSize(24).fillColor("#0056b3").text("Batch Markdown Notes", { align: "center" });
        doc.font("Helvetica").fontSize(11).fillColor("#666666").text(`Date Filter: ${fromDate || "Start"} to ${toDate || "End"}`, { align: "center" });
        doc.moveDown(1);

        for (let i = 0; i < mdFiles.length; i++) {
            if (i > 0) doc.addPage();
            const file = mdFiles[i];
            const stem = path.basename(file, ".md");
            const content = fs.readFileSync(file, "utf8");

            doc.font("Helvetica-Bold").fontSize(18).fillColor("#0056b3").text(stem);
            doc.moveDown(0.3);
            doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor("#e0e0e0").stroke();
            doc.moveDown(0.6);

            renderMarkdownToPdfDoc(doc, content);
        }

        doc.end();
        await new Promise((resolve, reject) => {
            batchStream.on("finish", resolve);
            batchStream.on("error", reject);
        });

        createdPdfs.push(batchPdfPath);

        return {
            success: true,
            output: `Converted ${mdFiles.length} note file(s) to PDF in '${outputDir}'. (${createdPdfs.length} PDFs generated)`,
            createdPdfs,
        };
    } catch (err) {
        return { success: false, error: `JS PDF generation error: ${err.message}` };
    }
}

/**
 * Converts PDF file back to Markdown note using pure JavaScript (pdf-parse).
 * Set `useWorkers: true` to run the CPU-bound parse in a worker_thread
 * (falls back to in-process parsing if the worker fails).
 */
export async function convertPdfToMd(pdfFile, outputDir = "notes", options = {}) {
    let pdfPath = path.resolve(pdfFile);
    const notesDir = path.resolve(outputDir);

    if (!fs.existsSync(notesDir)) {
        fs.mkdirSync(notesDir, { recursive: true });
    }

    if (!fs.existsSync(pdfPath)) {
        const altPath = path.resolve("pdfs", path.basename(pdfFile));
        if (fs.existsSync(altPath)) {
            pdfPath = altPath;
        } else {
            return { success: false, error: `PDF file '${pdfFile}' not found.` };
        }
    }

    try {
        const { useWorkers = false, workerTimeoutMs = 60000 } = options || {};
        let text = "";
        if (useWorkers) {
            try {
                text = await extractPdfInWorker(pdfPath, { timeoutMs: workerTimeoutMs });
            } catch {
                text = await extractPdfTextSync(pdfPath);
            }
        } else {
            text = await extractPdfTextSync(pdfPath);
        }
        if (!text.trim()) {
            return { success: false, error: `No text could be extracted from '${path.basename(pdfPath)}'.` };
        }

        const stem = path.basename(pdfPath, ".pdf");
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

        const mdLines = [];
        let firstLine = true;
        for (const line of lines) {
            if (firstLine) {
                mdLines.push(`# ${line}\n`);
                firstLine = false;
            } else if (line.endsWith("?") || (line.length < 60 && !line.endsWith(".") && !line.endsWith(":"))) {
                mdLines.push(`\n## ${line}\n`);
            } else {
                mdLines.push(line);
            }
        }

        const mdContent = mdLines.join("\n");
        const outPath = path.join(notesDir, `${stem}.md`);
        fs.writeFileSync(outPath, mdContent, "utf8");

        return {
            success: true,
            output: `Converted PDF '${path.basename(pdfPath)}' to Markdown note: '${outPath}'`,
            createdFiles: [outPath],
        };
    } catch (err) {
        return { success: false, error: `JS PDF extraction error: ${err.message}` };
    }
}

async function extractPdfTextSync(pdfPath) {
    const dataBuffer = fs.readFileSync(pdfPath);
    const parser = new PDFParse(new Uint8Array(dataBuffer));
    await parser.load();
    const parsedResult = await parser.getText();
    return parsedResult.text || "";
}

/**
 * Batch-convert many PDFs to Markdown with bounded worker parallelism.
 * Each file is independent, so throughput scales with CPU count.
 */
export async function convertPdfsToMdBatch(pdfFiles, outputDir = "notes", options = {}) {
    const { concurrency = 0, workerTimeoutMs = 60000 } = options || {};
    const { mapWithConcurrency } = await import("./utils/concurrency.js");
    const list = (pdfFiles || []).filter(Boolean);
    return mapWithConcurrency(
        list,
        (f) => convertPdfToMd(f, outputDir, { useWorkers: true, workerTimeoutMs }),
        { concurrency: concurrency > 0 ? concurrency : getOptimalWorkerCount(list.length) }
    );
}

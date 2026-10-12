/**
 * One-shot worker_threads entry for PDF batch work.
 *
 * Each job renders/extracts exactly one file so batch converts scale
 * with CPU count. Main thread still owns directory walks, DB writes
 * and the final merged batch PDF (single PDFKit document).
 *
 * In:  { kind: "md-to-pdf", markdownContent, title, outputPath }
 *      { kind: "pdf-to-md", pdfPath }
 * Out: { ok: true, outputPath?, markdown? } / { ok: false, error }
 */
import { parentPort } from "node:worker_threads";
import fs from "node:fs";
import PDFDocument from "pdfkit";
import { marked } from "marked";
import { PDFParse } from "pdf-parse";

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
                    for (const item of token.items) doc.text(`  • ${item.text}`, { indent: 10, lineGap: 2 });
                }
                doc.moveDown(0.5);
                break;
            }
            case "code": {
                doc.font("Courier").fontSize(9.5).fillColor("#222222");
                doc.text(token.text, { background: "#f4f4f4", lineGap: 2 });
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
            case "space": break;
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

function mdToPdf({ markdownContent, title, outputPath }) {
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
        stream.on("error", reject);
    });
}

async function pdfToMarkdown({ pdfPath }) {
    const dataBuffer = fs.readFileSync(pdfPath);
    const parser = new PDFParse(new Uint8Array(dataBuffer));
    await parser.load();
    const parsed = await parser.getText();
    return parsed.text || "";
}

try {
    parentPort?.on("message", (job) => {
        (async () => {
            try {
                if (job.kind === "md-to-pdf") {
                    const out = await mdToPdf(job);
                    parentPort.postMessage({ ok: true, jobId: job.jobId, outputPath: out });
                } else if (job.kind === "pdf-to-md") {
                    const markdown = await pdfToMarkdown(job);
                    parentPort.postMessage({ ok: true, jobId: job.jobId, markdown });
                } else {
                    throw new Error(`unknown pdf job kind: ${job.kind}`);
                }
            } catch (err) {
                parentPort.postMessage({ ok: false, jobId: job?.jobId, error: err?.message || String(err) });
            }
        })();
    });
} catch {}

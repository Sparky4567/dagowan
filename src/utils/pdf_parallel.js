import { Worker } from "node:worker_threads";
import { mapWithConcurrency, getOptimalWorkerCount } from "./concurrency.js";

const PDF_WORKER_URL = new URL("./pdf_worker.js", import.meta.url);
let pdfSeq = 0;

export function renderPdfInWorker({ markdownContent, title, outputPath }, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(PDF_WORKER_URL);
        } catch (err) {
            reject(err);
            return;
        }
        const timer = setTimeout(() => {
            try { worker.terminate(); } catch {}
            reject(new Error("pdf worker timed out"));
        }, timeoutMs);
        timer.unref?.();
        worker.once("message", (msg) => {
            clearTimeout(timer);
            try { worker.terminate(); } catch {}
            if (msg?.ok) resolve(msg.outputPath);
            else reject(new Error(msg?.error || "pdf worker failed"));
        });
        worker.once("error", (err) => {
            clearTimeout(timer);
            try { worker.terminate(); } catch {}
            reject(err);
        });
        worker.postMessage({ kind: "md-to-pdf", markdownContent, title, outputPath, jobId: `pdf_${Date.now()}_${pdfSeq++}` });
    });
}

export function extractPdfInWorker(pdfPath, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(PDF_WORKER_URL);
        } catch (err) {
            reject(err);
            return;
        }
        const timer = setTimeout(() => {
            try { worker.terminate(); } catch {}
            reject(new Error("pdf extract worker timed out"));
        }, timeoutMs);
        timer.unref?.();
        worker.once("message", (msg) => {
            clearTimeout(timer);
            try { worker.terminate(); } catch {}
            if (msg?.ok) resolve(msg.markdown);
            else reject(new Error(msg?.error || "pdf extract worker failed"));
        });
        worker.once("error", (err) => {
            clearTimeout(timer);
            try { worker.terminate(); } catch {}
            reject(err);
        });
        worker.postMessage({ kind: "pdf-to-md", pdfPath, jobId: `pdfx_${Date.now()}_${pdfSeq++}` });
    });
}

/** Render many markdown files to PDF with bounded worker parallelism. */
export async function renderManyPdfs(jobs, { concurrency = 0, timeoutMs = 60000, onFallback } = {}) {
    const limit = concurrency > 0 ? concurrency : getOptimalWorkerCount(jobs.length);
    return mapWithConcurrency(jobs, async (job) => {
        try {
            return await renderPdfInWorker(job, { timeoutMs });
        } catch (err) {
            if (typeof onFallback === "function") return onFallback(job, err);
            throw err;
        }
    }, { concurrency: limit });
}

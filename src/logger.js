import fs from "node:fs";
import path from "node:path";

const LOGS_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export const ERROR_LOG_PATH = path.join(LOGS_DIR, "error.log");
export const APP_LOG_PATH = path.join(LOGS_DIR, "app.log");
export const PROMPTS_LOG_PATH = path.join(LOGS_DIR, "prompts.log");

export function logError(err, context = "") {
    const time = new Date().toISOString();
    const message = err?.stack || err?.message || String(err);
    const entry = `[${time}] ${context ? `[${context}] ` : ""}${message}\n`;

    try {
        fs.appendFileSync(ERROR_LOG_PATH, entry, "utf8");
    } catch (_) {}
}

export function logInfo(msg, context = "") {
    const time = new Date().toISOString();
    const entry = `[${time}] ${context ? `[${context}] ` : ""}${msg}\n`;

    try {
        fs.appendFileSync(APP_LOG_PATH, entry, "utf8");
    } catch (_) {}
}

export function logPrompt(promptText, source = "web") {
    if (!promptText || !promptText.trim()) return;
    const time = new Date().toISOString();
    const entry = `[${time}] [${source.toUpperCase()}] ${promptText.trim()}\n`;

    try {
        fs.appendFileSync(PROMPTS_LOG_PATH, entry, "utf8");
    } catch (_) {}
}

// Redirect native OS file descriptor 2 (stderr) to /dev/null using bun:ffi to 100% suppress native C++ ONNX runtime warnings
try {
    const { dlopen, FFIType } = require("bun:ffi");
    const libc = dlopen("libc.so.6", {
        dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        open: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
    });
    const nullFd = libc.symbols.open(Buffer.from("/dev/null\0"), 1);
    if (nullFd >= 0) {
        libc.symbols.dup2(nullFd, 2);
        libc.symbols.close(nullFd);
    }
} catch (_) {}

// Intercept JS console.error to log to logs/error.log
const originalConsoleError = console.error;
console.error = function (...args) {
    const msg = args.map((a) => (typeof a === "object" ? (a instanceof Error ? a.stack : JSON.stringify(a)) : String(a))).join(" ");
    if (msg.trim()) {
        try {
            fs.appendFileSync(ERROR_LOG_PATH, `[${new Date().toISOString()}] [CONSOLE_ERROR] ${msg}\n`, "utf8");
        } catch (_) {}
    }
    originalConsoleError.apply(console, args);
};

process.on("uncaughtException", (err) => {
    logError(err, "UNCAUGHT_EXCEPTION");
});

process.on("unhandledRejection", (reason) => {
    logError(reason, "UNHANDLED_REJECTION");
});

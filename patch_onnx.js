import fs from "node:fs";
import path from "node:path";

/**
 * Installable post-install patches for node_modules.
 *
 * node_modules/ is gitignored, so any hand-edit made there is lost on the
 * next `bun install` / `npm install` (fresh checkout, Docker build, ...).
 * This script is the single source of truth for those patches and is wired
 * into every install path:
 *   - package.json "postinstall"  (plain `bun install` / `npm install`)
 *   - install.sh / install_ubuntu.sh (explicit run after dependency install)
 *   - starter.sh (re-applied on every launch, self-healing)
 *   - docker-entrypoint.sh + Dockerfile (container builds / restarts)
 *
 * All replacements are idempotent: re-running never duplicates or grows
 * patched files. Run with `--check` for a read-only verification
 * (exit 1 when patches are missing or a search string no longer matches,
 * e.g. after a dependency upgrade changed the upstream source).
 */

const CHECK_MODE = process.argv.includes("--check");

const results = { applied: [], clean: [], missing: [], failed: [] };

function patchFile(relPath, description, replacements) {
    const filePath = path.join(process.cwd(), relPath);
    if (!fs.existsSync(filePath)) {
        results.missing.push(`${relPath} (${description})`);
        return;
    }
    const content = fs.readFileSync(filePath, "utf8");
    let updated = content;
    for (const entry of replacements) {
        const { search, replace } = entry;
        if (entry.dedupe) {
            // Collapse 2+ consecutive identical lines into one (fixpoint).
            // Repairs stacks left by older non-idempotent runs of this script.
            let prev;
            do {
                prev = updated;
                updated = updated.replaceAll(search, replace);
            } while (updated !== prev);
            continue;
        }
        if (entry.skipIfPresent && updated.includes(entry.skipIfPresent)) {
            // Already patched (replacement text present) - skip without
            // touching the file, even if `search` still matches elsewhere.
            continue;
        }
        if (updated.includes(search)) {
            updated = updated.replaceAll(search, replace);
        } else if (updated.includes(replace)) {
            // Already applied.
        } else {
            results.failed.push(`${relPath} :: ${description} :: search not found: ${JSON.stringify(search.slice(0, 80))}`);
        }
    }
    if (updated !== content) {
        if (CHECK_MODE) {
            results.failed.push(`${relPath} :: ${description} :: would modify (run without --check to apply)`);
        } else {
            fs.writeFileSync(filePath, updated, "utf8");
            results.applied.push(`${relPath} (${description})`);
        }
    } else {
        results.clean.push(`${relPath} (${description})`);
    }
}

const GUARD_LINE = "if (options.logSeverityLevel === undefined) { options.logSeverityLevel = 3; }";

// 1. Patch @xenova/transformers dist/transformers.js
patchFile("node_modules/@xenova/transformers/dist/transformers.js", "onnx log-silencing", [
    {
        search: `if (typeof process !== 'undefined' && process?.release?.name === 'node') {`,
        replace: `if (typeof process !== 'undefined' && process?.release?.name === 'node' && onnxruntime_node__WEBPACK_IMPORTED_MODULE_0__?.InferenceSession) {`,
    },
    {
        search: `return await InferenceSession.create(buffer, {\n            executionProviders: _backends_onnx_js__WEBPACK_IMPORTED_MODULE_5__.executionProviders,\n        });`,
        replace: `return await InferenceSession.create(buffer, {\n            executionProviders: _backends_onnx_js__WEBPACK_IMPORTED_MODULE_5__.executionProviders,\n            logSeverityLevel: 3,\n        });`,
    },
    {
        search: `return await InferenceSession.create(buffer, {\n            executionProviders: ['wasm']\n        });`,
        replace: `return await InferenceSession.create(buffer, {\n            executionProviders: ['wasm'],\n            logSeverityLevel: 3,\n        });`,
    },
    {
        // NOTE: `replace` contains `search`, so a naive replaceAll would
        // prepend another guard on every run. skipIfPresent keeps it idempotent.
        search: `const handler = await backend.createSessionHandler(filePathOrUint8Array, options);`,
        replace: `${GUARD_LINE}\n        const handler = await backend.createSessionHandler(filePathOrUint8Array, options);`,
        skipIfPresent: GUARD_LINE,
    },
    {
        // Collapse guard-line stacks left by pre-idempotency runs of this script.
        search: `        ${GUARD_LINE}\n        ${GUARD_LINE}`,
        replace: `        ${GUARD_LINE}`,
        dedupe: true,
    },
    {
        search: `this.logLevelInternal = 'warning';`,
        replace: `this.logLevelInternal = 'error';`,
    },
]);

// 1b. Patch @xenova/transformers src/utils/image.js sharp import
patchFile("node_modules/@xenova/transformers/src/utils/image.js", "sharp optional import", [
    {
        search: `import sharp from 'sharp';`,
        replace: `let sharp; try { sharp = (await import('sharp')).default; } catch (e) {}`,
    },
]);

// 2. Patch @xenova/transformers src/backends/onnx.js
patchFile("node_modules/@xenova/transformers/src/backends/onnx.js", "onnxruntime-web backend", [
    {
        search: `import * as ONNX_NODE from 'onnxruntime-node';`,
        replace: `import * as ONNX_NODE from 'onnxruntime-web';`,
    },
]);

// 3. Patch onnxruntime-node dist/backend.js
patchFile("node_modules/onnxruntime-node/dist/backend.js", "onnx log-silencing", [
    {
        search: `constructor(pathOrBuffer, options) {\n        _OnnxruntimeSessionHandler_inferenceSession.set(this, void 0);`,
        replace: `constructor(pathOrBuffer, options) {\n        options = Object.assign({ logSeverityLevel: 3, log_severity_level: 3, logLevel: 'error' }, options);\n        _OnnxruntimeSessionHandler_inferenceSession.set(this, void 0);`,
    },
]);

// 4. Patch sharp to avoid crashing when native binary is missing (e.g. Android PRoot / ARM)
const sharpDir = path.join(process.cwd(), "node_modules/sharp");
if (!fs.existsSync(path.join(sharpDir, "package.json")) && !CHECK_MODE) {
    try {
        fs.mkdirSync(path.join(sharpDir, "lib"), { recursive: true });
        fs.writeFileSync(path.join(sharpDir, "package.json"), JSON.stringify({ name: "sharp", version: "0.32.6", main: "index.js" }), "utf8");
        fs.writeFileSync(path.join(sharpDir, "index.js"), `const dummyFn = () => ({ resize: () => dummyFn(), toBuffer: async () => Buffer.from([]), extract: () => dummyFn(), extend: () => dummyFn(), affine: () => dummyFn() }); dummyFn.format = () => ({ heif: { output: {} }, jpeg: { output: {} }, tiff: { output: {} }, jp2k: { output: {} } }); dummyFn.libvipsVersion = () => "8.18.3"; dummyFn.cache = () => {}; dummyFn.simd = () => {}; dummyFn.concurrency = () => {}; dummyFn.counters = () => ({}); dummyFn._isUsingJemalloc = () => false; module.exports = dummyFn; module.exports.default = dummyFn;`, "utf8");
        results.applied.push(`node_modules/sharp (fallback stub created)`);
    } catch (e) {}
}
patchFile("node_modules/sharp/lib/sharp.js", "sharp missing-binary fallback", [
    {
        search: `throw new Error(help.join('\\n'));`,
        replace: `module.exports = { format: () => ({ heif: { output: {} }, jpeg: { output: {} }, tiff: { output: {} }, jp2k: { output: {} } }), libvipsVersion: () => "8.18.3", cache: () => {}, simd: () => {}, concurrency: () => {}, counters: () => ({}), _isUsingJemalloc: () => false };`,
    },
]);

// 5. Patch pdf-parse to suppress/fix canvas polyfill warnings in Bun
patchFile("node_modules/pdf-parse/dist/pdf-parse/web/pdf-parse.es.js", "canvas warning suppression", [
    {
        search: `warn(\`Cannot load "@napi-rs/canvas" package: "\${ex}".\`);`,
        replace: `/* canvas warning suppressed */`,
    },
    {
        search: `warn("Cannot polyfill \`DOMMatrix\`, rendering may be broken.");`,
        replace: `/* DOMMatrix warning suppressed */`,
    },
    {
        search: `warn("Cannot polyfill \`ImageData\`, rendering may be broken.");`,
        replace: `/* ImageData warning suppressed */`,
    },
    {
        search: `warn("Cannot polyfill \`Path2D\`, rendering may be broken.");`,
        replace: `/* Path2D warning suppressed */`,
    },
]);

// 6. Patch @napi-rs/canvas/js-binding.js fallback so it doesn't throw when native binary fails under Bun
patchFile("node_modules/@napi-rs/canvas/js-binding.js", "canvas native-binding fallback", [
    {
        search: `if (!nativeBinding) {\n  if (loadErrors.length > 0) {\n    // TODO Link to documentation with potential fixes\n    //  - The package owner could build/publish bindings for this arch\n    //  - The user may need to bundle the correct files\n    //  - The user may need to re-install node_modules to get new packages\n    throw new Error('Failed to load native binding', { cause: loadErrors })\n  }\n  throw new Error(\`Failed to load native binding\`)\n}`,
        replace: `if (!nativeBinding) {\n  nativeBinding = {\n    GlobalFonts: { getFamilies: () => "[]", loadSystemFonts: () => {}, loadFontsFromDir: () => {} },\n    CanvasElement: class {},\n    CanvasGradient: class {},\n    CanvasPattern: class {},\n    CanvasRenderingContext2D: class { getTransform() { return {}; } drawImage() {} },\n    FontKey: class {},\n    Image: class {},\n    ImageData: class {},\n    Path: class {},\n    SVGCanvas: class {},\n    ChromaSubsampling: {},\n    clearAllCache: () => {},\n    convertSVGTextToPath: () => {},\n    FillType: {},\n    PathOp: {},\n    StrokeCap: {},\n    StrokeJoin: {},\n    SvgExportFlag: {},\n  };\n}`,
    },
]);

// Report
for (const f of results.applied) console.log(`✅ Patched: ${f}`);
if (!CHECK_MODE) {
    for (const f of results.clean) console.log(`↔ Already patched: ${f}`);
}
for (const f of results.missing) console.log(`⚠️ Skipped (not installed): ${f}`);
for (const f of results.failed) console.log(`❌ Patch problem: ${f}`);
if (CHECK_MODE) {
    if (results.failed.length > 0 || results.missing.length > 0) {
        console.log(`CHECK FAILED: ${results.failed.length} problem(s), ${results.missing.length} missing file(s).`);
        process.exit(1);
    }
    console.log(`CHECK OK: all ${results.clean.length} patched file(s) up to date.`);
} else {
    console.log("ONNX runtime logging patch completed.");
}

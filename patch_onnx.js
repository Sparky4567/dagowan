import fs from "node:fs";
import path from "node:path";

function patchFile(filePath, replacements) {
    if (!fs.existsSync(filePath)) return;
    let content = fs.readFileSync(filePath, "utf8");
    let updated = content;
    for (const { search, replace } of replacements) {
        if (updated.includes(search)) {
            updated = updated.replace(search, replace);
        }
    }
    if (updated !== content) {
        fs.writeFileSync(filePath, updated, "utf8");
        console.log(`✅ Patched: ${path.relative(process.cwd(), filePath)}`);
    }
}

// 1. Patch @xenova/transformers dist/transformers.js
const transformersPath = path.join(process.cwd(), "node_modules/@xenova/transformers/dist/transformers.js");
patchFile(transformersPath, [
    {
        search: `if (typeof process !== 'undefined' && process?.release?.name === 'node') {`,
        replace: `if (typeof process !== 'undefined' && process?.release?.name === 'node' && onnxruntime_node__WEBPACK_IMPORTED_MODULE_0__?.InferenceSession) {`
    },
    {
        search: `return await InferenceSession.create(buffer, {\n            executionProviders: _backends_onnx_js__WEBPACK_IMPORTED_MODULE_5__.executionProviders,\n        });`,
        replace: `return await InferenceSession.create(buffer, {\n            executionProviders: _backends_onnx_js__WEBPACK_IMPORTED_MODULE_5__.executionProviders,\n            logSeverityLevel: 3,\n        });`
    },
    {
        search: `return await InferenceSession.create(buffer, {\n            executionProviders: ['wasm']\n        });`,
        replace: `return await InferenceSession.create(buffer, {\n            executionProviders: ['wasm'],\n            logSeverityLevel: 3,\n        });`
    },
    {
        search: `const handler = await backend.createSessionHandler(filePathOrUint8Array, options);`,
        replace: `if (options.logSeverityLevel === undefined) { options.logSeverityLevel = 3; }\n        const handler = await backend.createSessionHandler(filePathOrUint8Array, options);`
    },
    {
        search: `this.logLevelInternal = 'warning';`,
        replace: `this.logLevelInternal = 'error';`
    }
]);

// 2. Patch @xenova/transformers src/backends/onnx.js
const ortSrcBackendPath = path.join(process.cwd(), "node_modules/@xenova/transformers/src/backends/onnx.js");
patchFile(ortSrcBackendPath, [
    {
        search: `import * as ONNX_NODE from 'onnxruntime-node';`,
        replace: `import * as ONNX_NODE from 'onnxruntime-web';`
    }
]);

// 3. Patch onnxruntime-node dist/backend.js
const ortNodeBackendPath = path.join(process.cwd(), "node_modules/onnxruntime-node/dist/backend.js");
patchFile(ortNodeBackendPath, [
    {
        search: `constructor(pathOrBuffer, options) {\n        _OnnxruntimeSessionHandler_inferenceSession.set(this, void 0);`,
        replace: `constructor(pathOrBuffer, options) {\n        options = Object.assign({ logSeverityLevel: 3, log_severity_level: 3, logLevel: 'error' }, options);\n        _OnnxruntimeSessionHandler_inferenceSession.set(this, void 0);`
    }
]);

// 4. Patch sharp/lib/sharp.js to avoid crashing when native binary is missing
const sharpPath = path.join(process.cwd(), "node_modules/sharp/lib/sharp.js");
patchFile(sharpPath, [
    {
        search: `throw new Error(help.join('\\n'));`,
        replace: `module.exports = { format: () => ({ heif: { output: {} }, jpeg: { output: {} }, tiff: { output: {} }, jp2k: { output: {} } }), libvipsVersion: () => "8.18.3", cache: () => {}, simd: () => {}, concurrency: () => {}, counters: () => ({}), _isUsingJemalloc: () => false };`
    }
]);

// 5. Patch pdf-parse to suppress/fix canvas polyfill warnings in Bun
const pdfParseWebPath = path.join(process.cwd(), "node_modules/pdf-parse/dist/pdf-parse/web/pdf-parse.es.js");
patchFile(pdfParseWebPath, [
    {
        search: `warn(\`Cannot load "@napi-rs/canvas" package: "\${ex}".\`);`,
        replace: `/* canvas warning suppressed */`
    },
    {
        search: `warn("Cannot polyfill \`DOMMatrix\`, rendering may be broken.");`,
        replace: `/* DOMMatrix warning suppressed */`
    },
    {
        search: `warn("Cannot polyfill \`ImageData\`, rendering may be broken.");`,
        replace: `/* ImageData warning suppressed */`
    },
    {
        search: `warn("Cannot polyfill \`Path2D\`, rendering may be broken.");`,
        replace: `/* Path2D warning suppressed */`
    }
]);

// 6. Patch @napi-rs/canvas/js-binding.js fallback so it doesn't throw when native binary fails under Bun
const napiCanvasPath = path.join(process.cwd(), "node_modules/@napi-rs/canvas/js-binding.js");
patchFile(napiCanvasPath, [
    {
        search: `if (!nativeBinding) {\n  if (loadErrors.length > 0) {\n    // TODO Link to documentation with potential fixes\n    //  - The package owner could build/publish bindings for this arch\n    //  - The user may need to bundle the correct files\n    //  - The user may need to re-install node_modules to get new packages\n    throw new Error('Failed to load native binding', { cause: loadErrors })\n  }\n  throw new Error(\`Failed to load native binding\`)\n}`,
        replace: `if (!nativeBinding) {\n  nativeBinding = {\n    GlobalFonts: { getFamilies: () => "[]", loadSystemFonts: () => {}, loadFontsFromDir: () => {} },\n    CanvasElement: class {},\n    CanvasGradient: class {},\n    CanvasPattern: class {},\n    CanvasRenderingContext2D: class { getTransform() { return {}; } drawImage() {} },\n    FontKey: class {},\n    Image: class {},\n    ImageData: class {},\n    Path: class {},\n    SVGCanvas: class {},\n    ChromaSubsampling: {},\n    clearAllCache: () => {},\n    convertSVGTextToPath: () => {},\n    FillType: {},\n    PathOp: {},\n    StrokeCap: {},\n    StrokeJoin: {},\n    SvgExportFlag: {},\n  };\n}`
    }
]);

console.log("ONNX runtime logging patch completed.");



import "./logger.js";
process.env.ORT_LOGGING_LEVEL = "3";

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { env, pipeline } from "@xenova/transformers";
import { WaveFile } from "wavefile";
import OpenAI from "openai";

// Automatically apply ONNX logging level patch if available
try {
    const patchPath = path.join(process.cwd(), "patch_onnx.js");
    if (fs.existsSync(patchPath)) {
        await import(`file://${patchPath}`);
    }
} catch (e) {}

// Suppress ONNX runtime graph optimization notices
env.logLevel = "error";
if (env.backends && env.backends.onnx) {
    env.backends.onnx.node = false;
    env.backends.onnx.logLevel = "error";
    env.backends.onnx.logLevelInternal = "error";
    if (env.backends.onnx.wasm) {
        env.backends.onnx.wasm.logLevel = "error";
        env.backends.onnx.wasm.numThreads = 1;
    }
}

let sttPipeline = null;
let ttsPipeline = null;

/**
 * Ensures the local Whisper STT model is loaded into memory.
 */
export async function getSTTPipeline() {
    if (!sttPipeline) {
        sttPipeline = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny");
    }
    return sttPipeline;
}

/**
 * Ensures the local MMS-TTS model is loaded into memory.
 */
export async function getTTSPipeline() {
    if (!ttsPipeline) {
        ttsPipeline = await pipeline("text-to-speech", "Xenova/mms-tts-eng");
    }
    return ttsPipeline;
}

/**
 * Converts any input audio file (OGG, MP3, M4A, etc.) to 16kHz Mono 16-bit PCM WAV using ffmpeg.
 */
export function convertAudioTo16kWav(inputPath, outputPath) {
    const res = spawnSync("ffmpeg", ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outputPath], {
        encoding: "utf8",
    });
    if (res.status !== 0) {
        throw new Error(`ffmpeg conversion failed: ${res.stderr || res.stdout}`);
    }
    return outputPath;
}

/**
 * Encodes Float32Array PCM samples into a 16-bit PCM WAV Buffer.
 */
export function encodeWavBuffer(float32Array, sampleRate = 16000) {
    const wav = new WaveFile();
    wav.fromScratch(1, sampleRate, "32f", float32Array);
    wav.toBitDepth("16");
    return Buffer.from(wav.toBuffer());
}

/**
 * Local Speech-To-Text (STT): Transcribes an audio file locally using HuggingFace Whisper ONNX model.
 */
export async function transcribeAudioLocal(inputAudioPath, options = {}) {
    if (!fs.existsSync(inputAudioPath)) {
        throw new Error(`Audio file not found: ${inputAudioPath}`);
    }

    const tmpDir = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
    }
    const tmpWavPath = path.join(tmpDir, `stt_16k_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);

    try {
        convertAudioTo16kWav(inputAudioPath, tmpWavPath);

        const wavData = fs.readFileSync(tmpWavPath);
        const wav = new WaveFile(wavData);
        wav.toSampleRate(16000);
        wav.toBitDepth("32f");

        let samples = wav.getSamples(false, Float32Array);
        if (Array.isArray(samples)) {
            samples = samples[0];
        }

        const transcriber = await getSTTPipeline();
        const language = options.language || "english";
        const result = await transcriber(samples, {
            language,
            task: "transcribe",
            ...options,
        });

        const rawText = (result.text || "").trim();
        let cleanedText = rawText
            .replace(/\[blank_audio\]/gi, "")
            .replace(/\[blank\]/gi, "")
            .replace(/\(blank audio\)/gi, "")
            .replace(/\[silence\]/gi, "")
            .replace(/\[noise\]/gi, "")
            .replace(/\[music\]/gi, "")
            .replace(/\[applause\]/gi, "")
            .replace(/\[laughter\]/gi, "")
            .trim();

        return { text: cleanedText };
    } finally {
        if (fs.existsSync(tmpWavPath)) {
            try {
                fs.unlinkSync(tmpWavPath);
            } catch {}
        }
    }
}

/**
 * Helper to split long text into natural sentence/paragraph chunks for TTS synthesis.
 */
export function splitTextIntoSentenceChunks(text, maxChunkLen = 350) {
    if (!text || text.length <= maxChunkLen) return [text];

    const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
    const chunks = [];
    let currentChunk = "";

    for (const sentence of sentences) {
        if ((currentChunk + sentence).length <= maxChunkLen) {
            currentChunk += sentence;
        } else {
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
            }
            if (sentence.length > maxChunkLen) {
                const words = sentence.split(" ");
                let subChunk = "";
                for (const word of words) {
                    if ((subChunk + " " + word).length <= maxChunkLen) {
                        subChunk += (subChunk ? " " : "") + word;
                    } else {
                        if (subChunk.trim()) chunks.push(subChunk.trim());
                        subChunk = word;
                    }
                }
                currentChunk = subChunk;
            } else {
                currentChunk = sentence;
            }
        }
    }
    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }
    return chunks.length > 0 ? chunks : [text];
}

/**
 * Helper to concatenate Float32Array audio sample arrays.
 */
export function concatenateAudioArrays(arrays) {
    let totalLength = 0;
    for (const arr of arrays) {
        totalLength += arr.length;
    }
    const result = new Float32Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

/**
 * Local Text-To-Speech (TTS): Synthesizes text into a local audio file using MMS-TTS ONNX model.
 */
export async function synthesizeSpeechLocal(text, outputAudioPath) {
    if (!text || !text.trim()) {
        throw new Error("Cannot synthesize speech from empty text.");
    }

    let cleanText = text
        .replace(/```[\s\S]*?```/g, " [code block omitted] ") // Strip fenced code blocks
        .replace(/https?:\/\/\S+/g, "") // Strip URLs
        .replace(/[*#_`~>|]/g, "") // Strip markdown symbols
        .replace(/\s+/g, " ")
        .trim();

    if (!cleanText) {
        cleanText = "Here is the response.";
    }

    const synthesiser = await getTTSPipeline();
    const chunks = splitTextIntoSentenceChunks(cleanText, 350);
    const audioBuffers = [];
    let samplingRate = 16000;

    for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        const out = await synthesiser(chunk);
        if (out && out.audio) {
            audioBuffers.push(out.audio);
            if (out.sampling_rate) samplingRate = out.sampling_rate;
        }
    }

    if (audioBuffers.length === 0) {
        throw new Error("TTS failed to generate audio samples.");
    }

    const fullAudioSamples = concatenateAudioArrays(audioBuffers);
    const wavBuffer = encodeWavBuffer(fullAudioSamples, samplingRate);
    const tmpDir = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
    }
    const tmpWavPath = path.join(tmpDir, `tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
    fs.writeFileSync(tmpWavPath, wavBuffer);

    const targetPath = path.resolve(outputAudioPath);
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    if (targetPath.endsWith(".ogg") || targetPath.endsWith(".opus")) {
        const res = spawnSync("ffmpeg", ["-y", "-i", tmpWavPath, "-c:a", "libopus", targetPath], { encoding: "utf8" });
        if (fs.existsSync(tmpWavPath)) fs.unlinkSync(tmpWavPath);
        if (res.status !== 0) {
            throw new Error(`ffmpeg OGG conversion failed: ${res.stderr || res.stdout}`);
        }
    } else {
        fs.renameSync(tmpWavPath, targetPath);
    }

    return { audioPath: targetPath };
}

/**
 * OpenAI Speech-To-Text (STT): Transcribes an audio file via OpenAI Whisper API (whisper-1).
 */
export async function transcribeAudioOpenAI(inputAudioPath, apiKey, options = {}) {
    if (!fs.existsSync(inputAudioPath)) {
        throw new Error(`Audio file not found: ${inputAudioPath}`);
    }
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) {
        throw new Error("OpenAI API Key is missing. Please set it in app_settings.json or settings panel.");
    }

    const client = new OpenAI({ apiKey: key });
    const fileStream = fs.createReadStream(inputAudioPath);

    const response = await client.audio.transcriptions.create({
        file: fileStream,
        model: options.model || "whisper-1",
        language: options.language || undefined,
    });

    return { text: (response.text || "").trim() };
}

/**
 * OpenAI Text-To-Speech (TTS): Synthesizes text into audio using OpenAI TTS API (tts-1 / tts-1-hd).
 */
export async function synthesizeSpeechOpenAI(text, outputAudioPath, apiKey, options = {}) {
    if (!text || !text.trim()) {
        throw new Error("Cannot synthesize speech from empty text.");
    }
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) {
        throw new Error("OpenAI API Key is missing. Please set it in app_settings.json or settings panel.");
    }

    let cleanText = text
        .replace(/```[\s\S]*?```/g, " [code block omitted] ")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/[*#_`~>|]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    if (!cleanText) {
        cleanText = "Here is the response.";
    }

    const client = new OpenAI({ apiKey: key });
    const voice = options.voice || "alloy";
    const model = options.model || "tts-1";

    const mp3Response = await client.audio.speech.create({
        model: model,
        voice: voice,
        input: cleanText,
        response_format: "mp3",
    });

    const mp3Buffer = Buffer.from(await mp3Response.arrayBuffer());

    const targetPath = path.resolve(outputAudioPath);
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const tmpDir = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
    }
    const tmpMp3Path = path.join(tmpDir, `openai_tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`);
    fs.writeFileSync(tmpMp3Path, mp3Buffer);

    if (targetPath.endsWith(".wav")) {
        const res = spawnSync("ffmpeg", ["-y", "-i", tmpMp3Path, "-ar", "24000", "-ac", "1", targetPath], { encoding: "utf8" });
        if (fs.existsSync(tmpMp3Path)) fs.unlinkSync(tmpMp3Path);
        if (res.status !== 0) {
            fs.writeFileSync(targetPath, mp3Buffer);
        }
    } else {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        fs.renameSync(tmpMp3Path, targetPath);
    }

    return { audioPath: targetPath };
}

/**
 * Unified Speech-To-Text (STT) Dispatcher: Automatically routes between OpenAI Whisper & Local Whisper.
 */
export async function transcribeAudio(inputAudioPath, options = {}, settings = {}) {
    const sttEngine = (settings.stt_engine || "local").toLowerCase();
    const apiKey = settings.openai_api_key || process.env.OPENAI_API_KEY;

    if (sttEngine === "openai") {
        if (!apiKey) {
            console.warn("⚠️ OpenAI API key missing for STT. Falling back to local Whisper...");
            return await transcribeAudioLocal(inputAudioPath, options);
        }
        return await transcribeAudioOpenAI(inputAudioPath, apiKey, {
            model: settings.openai_stt_model || "whisper-1",
            ...options,
        });
    }

    return await transcribeAudioLocal(inputAudioPath, options);
}

export function cleanMarkdownToText(text) {
    if (!text) return "";
    return text
        // 1. Remove code blocks ```lang\ncode\n``` -> code
        .replace(/```[a-z]*\n([\s\S]*?)\n```/gi, "$1")
        // 2. Remove inline code `code` -> code
        .replace(/`([^`]+)`/g, "$1")
        // 3. Convert headers (# Title, ## Subtitle) to clean lines
        .replace(/^#{1,6}\s+(.+)$/gm, "$1\n")
        // 4. Remove bold & italic (**text**, *text*, __text__, _text_)
        .replace(/(\*\*|__|[*_])(.*?)\1/g, "$2")
        // 5. Remove strikethrough (~~text~~)
        .replace(/~~(.*?)~~/g, "$1")
        // 6. Convert links [Anchor Text](http://...) -> Anchor Text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        // 7. Remove image markdown ![Alt](http://...) -> Alt
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
        // 8. Convert bullet lists (- item, * item, + item) to bullet dots (• item)
        .replace(/^[\s]*[-*+]\s+/gm, "• ")
        // 9. Convert numbered lists (1. item) to clean numbers (1. item)
        .replace(/^[\s]*(\d+)\.\s+/gm, "$1. ")
        // 10. Clean blockquotes (> text)
        .replace(/^>\s+/gm, "")
        // 11. Normalize multiple blank lines to double newlines (proper paragraph spacing)
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export const stripMarkdown = cleanMarkdownToText;

/**
 * Unified Text-To-Speech (TTS) Dispatcher: Automatically routes between OpenAI TTS & Local MMS-TTS.
 */
export async function synthesizeSpeech(text, outputAudioPath, settings = {}, options = {}) {
    const cleanText = stripMarkdown(text);
    const ttsEngine = (settings.tts_engine || "local").toLowerCase();
    const apiKey = settings.openai_api_key || process.env.OPENAI_API_KEY;

    if (ttsEngine === "openai") {
        if (!apiKey) {
            console.warn("⚠️ OpenAI API key missing for TTS. Falling back to local MMS-TTS...");
            return await synthesizeSpeechLocal(cleanText, outputAudioPath);
        }
        return await synthesizeSpeechOpenAI(cleanText, outputAudioPath, apiKey, {
            voice: settings.openai_tts_voice || "alloy",
            model: settings.openai_tts_model || "tts-1",
            ...options,
        });
    }

    return await synthesizeSpeechLocal(cleanText, outputAudioPath);
}


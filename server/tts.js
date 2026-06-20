import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import * as googleTTS from "google-tts-api";
import { unpackedBinaryPath } from "./binaries.js";
import { appRoot, piperVoicesDir } from "./paths.js";

const TIKTOK_TTS_URL = "https://api16-normal-c-useast1a.tiktokv.com/media/api/text/speech/invoke/";
const DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_PIPER_MODEL = "en_US-lessac-medium.onnx";
const SAFE_TTS_FILTER = "aresample=48000,volume=0.82,alimiter=limit=0.89";
const ffmpegBin = unpackedBinaryPath(ffmpegPath);
const ffprobeBin = unpackedBinaryPath(ffprobeStatic.path);

function splitForTts(text, maxLength = 240) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if ((current + " " + trimmed).trim().length <= maxLength) {
      current = (current + " " + trimmed).trim();
      continue;
    }

    if (current) chunks.push(current);

    if (trimmed.length <= maxLength) {
      current = trimmed;
    } else {
      const words = trimmed.split(/\s+/);
      current = "";
      for (const word of words) {
        if ((current + " " + word).trim().length > maxLength) {
          chunks.push(current);
          current = word;
        } else {
          current = (current + " " + word).trim();
        }
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function tiktokChunkToBuffer(text, voice) {
  const params = new URLSearchParams({
    text_speaker: voice,
    req_text: text,
    speaker_map_type: "0"
  });

  const response = await fetch(`${TIKTOK_TTS_URL}?${params}`, {
    headers: {
      "User-Agent": "com.zhiliaoapp.musically/2022607040"
    }
  });

  if (!response.ok) {
    throw new Error(`TikTok TTS returned ${response.status}.`);
  }

  const payload = await response.json();
  const base64 = payload?.data?.v_str;
  if (!base64) {
    const message = payload?.message || payload?.status_msg || "No audio was returned.";
    throw new Error(`TikTok TTS failed: ${message}`);
  }

  return Buffer.from(base64, "base64");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code}:\n${stderr}`));
    });
  });
}

async function getAudioDuration(filePath) {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffprobeBin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(Number.parseFloat(stdout) || 0);
    });
  });
}

async function trimSpeechSilence(inputPath, outputPath) {
  await run(ffmpegBin, [
    "-y",
    "-i",
    inputPath,
    "-af",
    "silenceremove=start_periods=1:start_duration=0.08:start_threshold=-50dB:stop_periods=1:stop_duration=0.12:stop_threshold=-50dB",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "160k",
    outputPath
  ]);
}

function splitForCaptionTts(text, maxLength = 115) {
  const sentences = String(text || "").match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if ((current + " " + trimmed).trim().length <= maxLength) {
      current = (current + " " + trimmed).trim();
      continue;
    }

    if (current) chunks.push(current);

    if (trimmed.length <= maxLength) {
      current = trimmed;
      continue;
    }

    const words = trimmed.split(/\s+/);
    current = "";
    for (const word of words) {
      if ((current + " " + word).trim().length > maxLength && current) {
        chunks.push(current);
        current = word;
      } else {
        current = (current + " " + word).trim();
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function googleChunkToBuffer(text) {
  const chunks = await googleTTS.getAllAudioBase64(text, {
    lang: "en",
    slow: false,
    host: "https://translate.google.com",
    timeout: 15000,
    splitPunct: ",.?!;:"
  });
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.base64, "base64")));
}

async function synthesizeWindowsFallback({ text, outputPath }) {
  const workDir = path.dirname(outputPath);
  const textPath = path.join(workDir, "tts-input.txt");
  const wavPath = path.join(workDir, "voice.wav");

  await fs.writeFile(textPath, text, "utf8");

  const script = [
    "Add-Type -AssemblyName System.Speech",
    `$text = Get-Content -Raw -LiteralPath '${textPath.replace(/'/g, "''")}'`,
    "$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$voice.Rate = 1",
    `$voice.SetOutputToWaveFile('${wavPath.replace(/'/g, "''")}')`,
    "$voice.Speak($text)",
    "$voice.Dispose()"
  ].join("; ");

  await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
  await run(ffmpegBin, ["-y", "-i", wavPath, "-af", SAFE_TTS_FILTER, "-codec:a", "libmp3lame", "-b:a", "160k", outputPath]);
  return { chunks: 1, provider: "windows-speech-fallback" };
}

async function synthesizeGoogleTts({ text, outputPath }) {
  const chunks = await googleTTS.getAllAudioBase64(text, {
    lang: "en",
    slow: false,
    host: "https://translate.google.com",
    timeout: 15000,
    splitPunct: ",.?!;:"
  });

  await fs.writeFile(outputPath, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.base64, "base64"))));
  return { chunks: chunks.length, provider: "google-tts" };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolvePiperModel() {
  return resolvePiperModelByName(DEFAULT_PIPER_MODEL);
}

async function resolvePiperModelByName(modelName = DEFAULT_PIPER_MODEL) {
  const safeModelName = path.basename(String(modelName || DEFAULT_PIPER_MODEL));
  const candidates = [
    process.env.PIPER_MODEL_PATH,
    path.join(piperVoicesDir, safeModelName),
    path.join(appRoot, "piper-voices", safeModelName)
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  throw new Error(
    `Piper voice model not found. Expected ${safeModelName} in ${piperVoicesDir}.`
  );
}

function piperModelFromVoice(voice) {
  if (!String(voice || "").startsWith("piper-local:")) return DEFAULT_PIPER_MODEL;
  return String(voice).slice("piper-local:".length);
}

async function synthesizePiper({ text, outputPath, workDir, voice }) {
  const modelPath = await resolvePiperModelByName(piperModelFromVoice(voice));
  const textPath = path.join(workDir || path.dirname(outputPath), `piper-input-${Date.now()}.txt`);
  const wavPath = outputPath.replace(/\.[^.]+$/, "") + "-piper.wav";
  await fs.writeFile(textPath, text, "utf8");

  try {
    await run(process.env.PIPER_PYTHON || "python", [
      "-m",
      "piper",
      "--model",
      modelPath,
      "--input_file",
      textPath,
      "--output_file",
      wavPath,
      "--sentence-silence",
      "0.15"
    ]);
    await run(ffmpegBin, ["-y", "-i", wavPath, "-af", SAFE_TTS_FILTER, "-codec:a", "libmp3lame", "-b:a", "160k", outputPath]);
    return { chunks: 1, provider: `piper-local:${path.basename(modelPath)}` };
  } finally {
    await fs.rm(textPath, { force: true }).catch(() => {});
    await fs.rm(wavPath, { force: true }).catch(() => {});
  }
}

async function synthesizeElevenLabs({ text, outputPath, apiKey, voiceId }) {
  if (!apiKey) throw new Error("Add an ElevenLabs API key before using ElevenLabs voice.");

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId || DEFAULT_ELEVENLABS_VOICE)}`,
    {
      method: "POST",
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": apiKey
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.42,
          similarity_boost: 0.82,
          style: 0.25,
          use_speaker_boost: true
        }
      })
    }
  );

  if (!response.ok) {
    let details = "";
    try {
      details = await response.text();
    } catch {
      details = "";
    }
    throw new Error(`ElevenLabs returned ${response.status}. ${details.slice(0, 220)}`);
  }

  await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return { chunks: 1, provider: "elevenlabs" };
}

async function synthesizeElevenLabsWithTimestamps({ text, outputPath, apiKey, voiceId }) {
  if (!apiKey) throw new Error("Add an ElevenLabs API key before using ElevenLabs voice.");

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId || DEFAULT_ELEVENLABS_VOICE
    )}/with-timestamps`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "xi-api-key": apiKey
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.42,
          similarity_boost: 0.82,
          style: 0.25,
          use_speaker_boost: true
        }
      })
    }
  );

  if (!response.ok) {
    let details = "";
    try {
      details = await response.text();
    } catch {
      details = "";
    }
    throw new Error(`ElevenLabs timestamp TTS returned ${response.status}. ${details.slice(0, 220)}`);
  }

  const payload = await response.json();
  if (!payload?.audio_base64) {
    throw new Error("ElevenLabs timestamp TTS did not return audio.");
  }

  await fs.writeFile(outputPath, Buffer.from(payload.audio_base64, "base64"));
  return payload.normalized_alignment || payload.alignment || null;
}

function captionRangesFromAlignedText(text, maxLength = 115) {
  const ranges = [];
  const words = [...String(text || "").matchAll(/\S+/g)];
  let start = null;
  let end = null;
  let previousWord = "";

  for (const match of words) {
    const word = match[0];
    const wordStart = match.index;
    const wordEnd = wordStart + word.length;

    if (start === null) {
      start = wordStart;
      end = wordEnd;
      previousWord = word;
      continue;
    }

    const currentText = text.slice(start, end).trim();
    const nextText = text.slice(start, wordEnd).trim();
    const shouldBreak =
      nextText.length > maxLength || (currentText.length >= 48 && /[.!?;:]$/.test(previousWord));

    if (shouldBreak) {
      ranges.push({ start, end });
      start = wordStart;
    }

    end = wordEnd;
    previousWord = word;
  }

  if (start !== null && end !== null) ranges.push({ start, end });
  return ranges;
}

function alignmentToCaptionTimings(alignment, offsetSeconds = 0) {
  const characters = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) return [];

  const alignedText = characters.join("");
  const ranges = captionRangesFromAlignedText(alignedText);
  const timings = [];

  for (const range of ranges) {
    let firstTimed = -1;
    let lastTimed = -1;

    for (let index = range.start; index < range.end; index += 1) {
      if (Number.isFinite(starts[index]) && String(characters[index] || "").trim()) {
        firstTimed = index;
        break;
      }
    }

    for (let index = range.end - 1; index >= range.start; index -= 1) {
      if (Number.isFinite(ends[index]) && String(characters[index] || "").trim()) {
        lastTimed = index;
        break;
      }
    }

    if (firstTimed < 0 || lastTimed < 0) continue;

    const start = offsetSeconds + starts[firstTimed];
    const end = Math.max(start + 0.2, offsetSeconds + ends[lastTimed]);
    timings.push({
      text: alignedText.slice(range.start, range.end).replace(/\s+/g, " ").trim(),
      start,
      end
    });
  }

  return timings;
}

async function concatAudioFiles({ files, outputPath, workDir }) {
  const concatPath = path.join(workDir, "concat.txt");
  const concatContent = files
    .map((chunkPath) => {
      const absolutePath = path.resolve(chunkPath);
      return `file '${absolutePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
    })
    .join("\n");
  await fs.writeFile(concatPath, concatContent, "utf8");
  await run(ffmpegBin, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-af",
    SAFE_TTS_FILTER,
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "160k",
    outputPath
  ]);
}

export async function synthesizeTikTokTts({ text, voice, outputPath, elevenLabsApiKey, elevenLabsVoiceId }) {
  if (voice === "elevenlabs") {
    return synthesizeElevenLabs({
      text,
      outputPath,
      apiKey: elevenLabsApiKey || process.env.ELEVENLABS_API_KEY,
      voiceId: elevenLabsVoiceId || process.env.ELEVENLABS_VOICE_ID
    });
  }

  if (!voice || voice.startsWith("google")) {
    try {
      return await synthesizeGoogleTts({ text, outputPath });
    } catch (error) {
      console.warn(`Google TTS failed, trying TikTok/Windows fallbacks: ${error.message}`);
    }
  }

  if (String(voice || "").startsWith("piper-local")) {
    return synthesizePiper({ text, outputPath, workDir: path.dirname(outputPath), voice });
  }

  const chunks = splitForTts(text);
  const buffers = [];

  try {
    for (const chunk of chunks) {
      buffers.push(await tiktokChunkToBuffer(chunk, voice));
    }

    await fs.writeFile(outputPath, Buffer.concat(buffers));
    return { chunks: chunks.length, provider: "tiktok-unofficial" };
  } catch (error) {
    console.warn(`TikTok TTS failed, using Windows Speech fallback: ${error.message}`);
    return synthesizeWindowsFallback({ text, outputPath });
  }
}

async function synthesizeChunk({ text, outputPath, voice, elevenLabsApiKey, elevenLabsVoiceId }) {
  if (voice === "elevenlabs") {
    return synthesizeElevenLabs({
      text,
      outputPath,
      apiKey: elevenLabsApiKey || process.env.ELEVENLABS_API_KEY,
      voiceId: elevenLabsVoiceId || process.env.ELEVENLABS_VOICE_ID
    });
  }

  if (!voice || voice.startsWith("google")) {
    await fs.writeFile(outputPath, await googleChunkToBuffer(text));
    return { provider: "google-tts" };
  }

  if (String(voice || "").startsWith("piper-local")) {
    return synthesizePiper({ text, outputPath, workDir: path.dirname(outputPath), voice });
  }

  await fs.writeFile(outputPath, await tiktokChunkToBuffer(text, voice));
  return { provider: "tiktok-unofficial" };
}

async function synthesizeElevenLabsTimed({ text, outputPath, workDir, elevenLabsApiKey, elevenLabsVoiceId }) {
  const apiKey = elevenLabsApiKey || process.env.ELEVENLABS_API_KEY;
  const voiceId = elevenLabsVoiceId || process.env.ELEVENLABS_VOICE_ID;
  const largeChunks = splitForTts(text, 1800);
  const chunkDir = path.join(workDir, "tts-elevenlabs-timed");
  await fs.mkdir(chunkDir, { recursive: true });

  const chunkFiles = [];
  const timings = [];
  let cursor = 0;

  for (const [index, chunk] of largeChunks.entries()) {
    const chunkPath = path.join(chunkDir, `chunk-${String(index).padStart(4, "0")}.mp3`);
    const alignment = await synthesizeElevenLabsWithTimestamps({
      text: chunk,
      outputPath: chunkPath,
      apiKey,
      voiceId
    });
    chunkFiles.push(chunkPath);
    timings.push(...alignmentToCaptionTimings(alignment, cursor));
    cursor += Math.max(0.1, await getAudioDuration(chunkPath));
  }

  await concatAudioFiles({ files: chunkFiles, outputPath, workDir: chunkDir });
  return {
    chunks: largeChunks.length,
    provider: "elevenlabs-with-timestamps",
    timings: timings.length ? timings : null,
    durationSeconds: cursor
  };
}

async function synthesizeMeasuredTimedTts({ text, voice, outputPath, workDir, elevenLabsApiKey, elevenLabsVoiceId }) {
  const chunks = splitForCaptionTts(text);
  const chunkDir = path.join(workDir, "tts-chunks");
  await fs.mkdir(chunkDir, { recursive: true });

  try {
    const chunkFiles = [];
    const timings = [];
    let cursor = 0;
    let provider = voice || "google-natural";

    for (const [index, chunk] of chunks.entries()) {
      const chunkPath = path.join(chunkDir, `chunk-${String(index).padStart(4, "0")}.mp3`);
      const rawChunkPath = path.join(chunkDir, `chunk-${String(index).padStart(4, "0")}-raw.mp3`);
      const result = await synthesizeChunk({
        text: chunk,
        outputPath: voice === "elevenlabs" ? rawChunkPath : chunkPath,
        voice,
        elevenLabsApiKey,
        elevenLabsVoiceId
      });
      provider = result.provider || provider;

      if (voice === "elevenlabs") {
        await trimSpeechSilence(rawChunkPath, chunkPath);
      }

      const duration = Math.max(0.1, await getAudioDuration(chunkPath));
      timings.push({
        text: chunk,
        start: cursor,
        end: cursor + duration
      });
      cursor += duration;
      chunkFiles.push(chunkPath);
    }

    await concatAudioFiles({ files: chunkFiles, outputPath, workDir: chunkDir });

    return {
      chunks: chunks.length,
      provider,
      timings,
      durationSeconds: cursor
    };
  } catch (error) {
    console.warn(`Timed TTS failed, falling back to single-pass TTS: ${error.message}`);
    const fallback = await synthesizeTikTokTts({ text, voice, outputPath, elevenLabsApiKey, elevenLabsVoiceId });
    return { ...fallback, timings: null };
  }
}

export async function synthesizeTimedTts({ text, voice, outputPath, workDir, elevenLabsApiKey, elevenLabsVoiceId }) {
  if (voice === "elevenlabs") {
    try {
      return await synthesizeElevenLabsTimed({
        text,
        outputPath,
        workDir,
        elevenLabsApiKey,
        elevenLabsVoiceId
      });
    } catch (error) {
      console.warn(`ElevenLabs timestamp TTS failed, falling back to measured chunks: ${error.message}`);
    }
  }

  return synthesizeMeasuredTimedTts({
    text,
    voice,
    outputPath,
    workDir,
    elevenLabsApiKey,
    elevenLabsVoiceId
  });
}

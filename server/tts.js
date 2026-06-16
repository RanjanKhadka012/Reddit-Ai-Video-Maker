import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import * as googleTTS from "google-tts-api";
import { unpackedBinaryPath } from "./binaries.js";

const TIKTOK_TTS_URL = "https://api16-normal-c-useast1a.tiktokv.com/media/api/text/speech/invoke/";
const DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM";
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
  await run(ffmpegBin, ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-b:a", "160k", outputPath]);
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

  await fs.writeFile(outputPath, await tiktokChunkToBuffer(text, voice));
  return { provider: "tiktok-unofficial" };
}

export async function synthesizeTimedTts({ text, voice, outputPath, workDir, elevenLabsApiKey, elevenLabsVoiceId }) {
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
      const result = await synthesizeChunk({
        text: chunk,
        outputPath: chunkPath,
        voice,
        elevenLabsApiKey,
        elevenLabsVoiceId
      });
      provider = result.provider || provider;

      const duration = Math.max(0.1, await getAudioDuration(chunkPath));
      timings.push({
        text: chunk,
        start: cursor,
        end: cursor + duration
      });
      cursor += duration;
      chunkFiles.push(chunkPath);
    }

    const concatPath = path.join(chunkDir, "concat.txt");
    const concatContent = chunkFiles
      .map((chunkPath) => `file '${chunkPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
      .join("\n");
    await fs.writeFile(concatPath, concatContent, "utf8");
    await run(ffmpegBin, ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", outputPath]);

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

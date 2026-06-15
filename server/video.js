import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { unpackedBinaryPath } from "./binaries.js";

const ffmpegBin = unpackedBinaryPath(ffmpegPath);
const ffprobePath = unpackedBinaryPath(ffprobeStatic.path);

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

function layoutSpec(layout = "tiktok") {
  if (layout === "youtube") {
    return {
      width: 1920,
      height: 1080,
      fontSize: 58,
      marginV: 120
    };
  }

  return {
    width: 1080,
    height: 1920,
    fontSize: 82,
    marginV: 430
  };
}

export async function listBackgrounds(backgroundDir) {
  const entries = await fs.readdir(backgroundDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(mp4|mov|mkv|webm)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => {
      if (a === "animated-runner.mp4") return -1;
      if (b === "animated-runner.mp4") return 1;
      if (a === "sample-runner-lanes.mp4") return -1;
      if (b === "sample-runner-lanes.mp4") return 1;
      return a.localeCompare(b);
    });
}

export async function getDuration(filePath) {
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
    const child = spawn(ffprobePath, args, { windowsHide: true });
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

function assEscape(text) {
  return text.replace(/[{}]/g, "").replace(/\n/g, " ");
}

function assTime(seconds) {
  const centis = Math.max(0, Math.round(seconds * 100));
  const cs = String(centis % 100).padStart(2, "0");
  const totalSeconds = Math.floor(centis / 100);
  const s = String(totalSeconds % 60).padStart(2, "0");
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = String(totalMinutes % 60).padStart(2, "0");
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${m}:${s}.${cs}`;
}

function captionLines(script, totalSeconds) {
  const words = script.split(/\s+/).filter(Boolean);
  const lines = [];
  const wordsPerLine = 8;
  const lineDuration = Math.max(1.8, totalSeconds / Math.ceil(words.length / wordsPerLine));

  for (let i = 0; i < words.length; i += wordsPerLine) {
    const start = (i / wordsPerLine) * lineDuration;
    const end = Math.min(totalSeconds, start + lineDuration);
    lines.push({
      start,
      end,
      text: words.slice(i, i + wordsPerLine).join(" ")
    });
  }

  return lines;
}

export async function writeAssCaptions({ script, outputPath, totalSeconds, layout }) {
  const spec = layoutSpec(layout);
  const events = captionLines(script, totalSeconds)
    .map(
      (line) =>
        `Dialogue: 0,${assTime(line.start)},${assTime(line.end)},Caption,,0,0,0,,${assEscape(line.text)}`
    )
    .join("\n");

  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: ${spec.width}
PlayResY: ${spec.height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,${spec.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H7A000000,-1,0,0,0,100,100,0,0,1,5,2,2,80,80,${spec.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;

  await fs.writeFile(outputPath, content, "utf8");
}

export async function renderVideo({ backgroundPath, audioPath, captionPath, outputPath, durationSeconds, layout, onProgress }) {
  const spec = layoutSpec(layout);
  const vf = [
    `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=increase`,
    `crop=${spec.width}:${spec.height}`,
    "setsar=1",
    captionPath ? `ass='${captionPath.replace(/\\/g, "/").replace(/:/g, "\\:")}'` : null
  ]
    .filter(Boolean)
    .join(",");

  const args = [
    "-y",
    "-stream_loop",
    "-1",
    "-i",
    backgroundPath,
    "-i",
    audioPath,
    "-t",
    String(durationSeconds),
    "-vf",
    vf,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-shortest",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-progress",
    "pipe:1",
    "-nostats",
    outputPath
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, args, { windowsHide: true });
    let stderr = "";
    let stdoutBuffer = "";

    child.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const [key, value] = line.split("=");
        if (key === "out_time_ms") {
          const seconds = Number(value) / 1000000;
          if (Number.isFinite(seconds) && durationSeconds > 0) {
            onProgress?.(Math.min(0.98, seconds / durationSeconds));
          }
        }
      }
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        onProgress?.(1);
        resolve();
      } else {
        reject(new Error(`${path.basename(ffmpegBin)} exited with code ${code}:\n${stderr}`));
      }
    });
  });
}

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

function wrapText(text, maxChars) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    if ((line + " " + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }

  if (line) lines.push(line);
  return lines;
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

export async function listComicPanels(panelDir) {
  const entries = await fs.readdir(panelDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
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

function lineWeight(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const pauses = (text.match(/[,.!?;:]/g) || []).length * 0.42;
  return Math.max(1, words + pauses);
}

function captionLines(script, totalSeconds) {
  const words = script.split(/\s+/).filter(Boolean);
  const lines = [];
  const wordsPerLine = 7;

  for (let i = 0; i < words.length; i += wordsPerLine) {
    lines.push({
      text: words.slice(i, i + wordsPerLine).join(" ")
    });
  }

  const totalWeight = lines.reduce((sum, line) => sum + lineWeight(line.text), 0);
  let cursor = 0;

  for (const line of lines) {
    const duration = Math.max(1.05, (lineWeight(line.text) / totalWeight) * totalSeconds);
    line.start = cursor;
    line.end = Math.min(totalSeconds, cursor + duration);
    cursor = line.end;
  }

  return lines;
}

const keywordStopWords = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "am",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "him",
  "his",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "not",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "they",
  "this",
  "to",
  "up",
  "was",
  "we",
  "were",
  "what",
  "when",
  "with",
  "you",
  "your"
]);

function keywordCaptionLines(script, totalSeconds) {
  const words = String(script || "")
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ""))
    .filter(Boolean);
  const usable = words.filter((word) => word.length > 2 && !keywordStopWords.has(word.toLowerCase()));
  const source = usable.length >= 8 ? usable : words;
  const targetCount = Math.max(6, Math.min(120, Math.floor(totalSeconds / 1.15)));
  const stride = Math.max(1, Math.floor(source.length / targetCount));
  const lines = [];

  for (let i = 0; i < source.length && lines.length < targetCount; i += stride) {
    const chunkSize = source[i]?.length <= 4 && source[i + 1] ? 2 : 1;
    const text = source
      .slice(i, i + chunkSize)
      .join(" ")
      .toUpperCase();
    if (text) lines.push({ text });
  }

  const slot = totalSeconds / Math.max(1, lines.length);
  return lines.map((line, index) => ({
    text: line.text,
    start: index * slot,
    end: Math.min(totalSeconds, index * slot + Math.max(0.75, slot * 0.82))
  }));
}

function keywordFromText(text) {
  const words = String(text || "")
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ""))
    .filter(Boolean);
  const usable = words.filter((word) => word.length > 2 && !keywordStopWords.has(word.toLowerCase()));
  const source = usable.length ? usable : words;
  const picked = source
    .sort((a, b) => b.length - a.length)
    .slice(0, source[0]?.length <= 4 ? 2 : 1)
    .join(" ");
  return (picked || words.slice(0, 2).join(" ") || "STORY").toUpperCase();
}

function timedCaptionLines(timings, totalSeconds, captionMode) {
  if (!Array.isArray(timings) || timings.length === 0) return null;
  return timings
    .map((line) => ({
      text: captionMode === "keyword" ? keywordFromText(line.text) : line.text,
      start: Math.max(0, Math.min(totalSeconds, Number(line.start) || 0)),
      end: Math.max(0, Math.min(totalSeconds, Number(line.end) || 0))
    }))
    .filter((line) => line.end > line.start);
}

function redditCardEvents({ card, totalSeconds, layout }) {
  if (!card) return "";
  const isYoutube = layout === "youtube";
  const maxTitle = isYoutube ? 58 : 32;
  const maxBody = isYoutube ? 72 : 38;
  const titleLines = wrapText(card.title || "Reddit Story", maxTitle).slice(0, 3);
  const bodyLines = wrapText(card.body || card.selftext || "", maxBody).slice(0, isYoutube ? 7 : 9);
  const meta = `r/${card.subreddit || "reddit"}  •  ${card.source || "story"}`;
  const cardText = [meta, "", ...titleLines, "", ...bodyLines].filter((line, index, all) => {
    if (line !== "") return true;
    return all[index - 1] !== "" && all[index + 1] !== "";
  });

  return `Dialogue: 0,0:00:00.00,${assTime(totalSeconds)},RedditCard,,0,0,0,,${assEscape(cardText.join("\\N"))}`;
}

export async function writeAssCaptions({ script, outputPath, totalSeconds, layout, card, captionMode, timedLines }) {
  const spec = layoutSpec(layout);
  const cardEvent = redditCardEvents({ card, totalSeconds, layout });
  const lineSource =
    timedCaptionLines(timedLines, totalSeconds, captionMode) ||
    (captionMode === "keyword" ? keywordCaptionLines(script, totalSeconds) : captionLines(script, totalSeconds));
  const captionStyle = captionMode === "keyword" ? "Keyword" : "Caption";
  const captionEvents = lineSource
    .map(
      (line) =>
        `Dialogue: 1,${assTime(line.start)},${assTime(line.end)},${captionStyle},,0,0,0,,${assEscape(line.text)}`
    )
    .join("\n");
  const events = [cardEvent, captionEvents].filter(Boolean).join("\n");
  const cardFontSize = layout === "youtube" ? 38 : 44;
  const cardMarginV = layout === "youtube" ? 70 : 150;
  const keywordFontSize = layout === "youtube" ? 82 : 112;
  const keywordMarginV = layout === "youtube" ? 210 : 540;

  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: ${spec.width}
PlayResY: ${spec.height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,${spec.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H7A000000,-1,0,0,0,100,100,0,0,1,5,2,2,80,80,${spec.marginV},1
Style: Keyword,Arial Black,${keywordFontSize},&H00004DFF,&H000000FF,&H00000000,&H7A000000,-1,0,0,0,100,100,0,0,1,8,3,2,80,80,${keywordMarginV},1
Style: RedditCard,Arial,${cardFontSize},&H001A1A1B,&H000000FF,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,14,0,8,${layout === "youtube" ? 360 : 90},${layout === "youtube" ? 360 : 90},${cardMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;

  await fs.writeFile(outputPath, content, "utf8");
}

export async function createComicPanelVideo({ panelPaths, outputPath, durationSeconds, layout, workDir, onProgress }) {
  if (!panelPaths.length) throw new Error("Add PNG/JPG/WebP comic panels to the comic-panels folder first.");

  const spec = layoutSpec(layout);
  const clipDir = path.join(workDir, "comic-clips");
  await fs.mkdir(clipDir, { recursive: true });
  const segmentSeconds = durationSeconds / panelPaths.length;
  const clipPaths = [];

  for (const [index, panelPath] of panelPaths.entries()) {
    const clipPath = path.join(clipDir, `panel-${String(index).padStart(3, "0")}.mp4`);
    const zoom = index % 2 === 0 ? 1.08 : 1.12;
    const panX = index % 3 === 0 ? "sin(t*0.55)*18" : "cos(t*0.45)*18";
    const panY = index % 2 === 0 ? "cos(t*0.38)*18" : "sin(t*0.5)*18";
    const vf = [
      `scale=${Math.round(spec.width * zoom)}:${Math.round(spec.height * zoom)}:force_original_aspect_ratio=increase`,
      `crop=${spec.width}:${spec.height}:x='(in_w-out_w)/2+${panX}':y='(in_h-out_h)/2+${panY}'`,
      "setsar=1",
      "format=yuv420p"
    ].join(",");

    await run(ffmpegBin, [
      "-y",
      "-loop",
      "1",
      "-t",
      String(segmentSeconds),
      "-i",
      panelPath,
      "-vf",
      vf,
      "-r",
      "30",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      clipPath
    ]);
    clipPaths.push(clipPath);
    onProgress?.((index + 1) / Math.max(1, panelPaths.length + 1));
  }

  const concatPath = path.join(workDir, "comic-concat.txt");
  const concatContent = clipPaths.map((clipPath) => `file '${clipPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
  await fs.writeFile(concatPath, concatContent, "utf8");
  await run(ffmpegBin, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-t",
    String(durationSeconds),
    "-c",
    "copy",
    outputPath
  ]);
  onProgress?.(1);
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

  const inputArgs = backgroundPath
    ? ["-stream_loop", "-1", "-i", backgroundPath]
    : ["-f", "lavfi", "-i", `color=c=0xf2f4f7:s=${spec.width}x${spec.height}:r=30`];

  const args = [
    "-y",
    ...inputArgs,
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

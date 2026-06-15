import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import { nanoid } from "nanoid";
import { fetchStories } from "./reddit.js";
import { synthesizeTikTokTts } from "./tts.js";
import { getDuration, listBackgrounds, renderVideo, writeAssCaptions } from "./video.js";
import { backgroundsDir, distDir, ensureDataDirs, rendersDir } from "./paths.js";

const app = express();
const port = Number(process.env.PORT || 4141);
const jobs = new Map();

ensureDataDirs();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/renders", express.static(rendersDir));
app.use(express.static(distDir));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/backgrounds", async (_request, response, next) => {
  try {
    response.json({ backgrounds: await listBackgrounds(backgroundsDir) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/reddit", async (request, response, next) => {
  try {
    const stories = await fetchStories({
      subreddit: String(request.query.subreddit || "AskReddit"),
      sort: String(request.query.sort || "top"),
      time: String(request.query.time || "day"),
      limit: Number(request.query.limit || 15),
      userAgent:
        process.env.REDDIT_USER_AGENT ||
        "windows:reddit-video-maker:v1.0.0 by local_user",
      clientId: process.env.REDDIT_CLIENT_ID,
      clientSecret: process.env.REDDIT_CLIENT_SECRET
    });
    response.json({ stories });
  } catch (error) {
    next(error);
  }
});

app.post("/api/render", async (request, response, next) => {
  try {
    const { story, background, voice, targetMinutes, layout, elevenLabsApiKey, elevenLabsVoiceId } = request.body;
    if (!story?.script) throw new Error("Choose a story before rendering.");
    if (!background) throw new Error("Add a background clip in the backgrounds folder first.");

    const safeBackground = path.basename(background);
    const backgroundPath = path.join(backgroundsDir, safeBackground);
    await fs.access(backgroundPath);

    const jobId = nanoid(8);
    const jobDir = path.join(rendersDir, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    const job = {
      id: jobId,
      ok: false,
      done: false,
      error: null,
      progress: 0.02,
      stage: "Starting render...",
      videoUrl: null,
      durationSeconds: null
    };
    jobs.set(jobId, job);
    response.json({ ok: true, jobId });

    const audioPath = path.join(jobDir, "voice.mp3");
    const captionsPath = path.join(jobDir, "captions.ass");
    const outputPath = path.join(jobDir, "reddit-video.mp4");
    const script = story.script;

    runRenderJob({
      job,
      script,
      audioPath,
      captionsPath,
      outputPath,
      backgroundPath,
      voice,
      targetMinutes,
      layout,
      elevenLabsApiKey,
      elevenLabsVoiceId
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs/:jobId", (request, response) => {
  const job = jobs.get(request.params.jobId);
  if (!job) {
    response.status(404).json({ error: "Render job not found." });
    return;
  }
  response.json(job);
});

async function runRenderJob({
  job,
  script,
  audioPath,
  captionsPath,
  outputPath,
  backgroundPath,
  voice,
  targetMinutes,
  layout,
  elevenLabsApiKey,
  elevenLabsVoiceId
}) {
  try {
    job.stage = "Generating narration...";
    job.progress = 0.08;
    await synthesizeTikTokTts({
      text: script,
      voice: voice || process.env.TIKTOK_TTS_VOICE || "google-natural",
      outputPath: audioPath,
      elevenLabsApiKey,
      elevenLabsVoiceId
    });

    job.stage = "Measuring narration...";
    job.progress = 0.28;
    const audioSeconds = await getDuration(audioPath);
    const requestedSeconds = Math.round(Math.min(180, Math.max(120, Number(targetMinutes || 2.4) * 60)));
    const durationSeconds = Math.min(180, Math.max(30, Math.min(audioSeconds || requestedSeconds, requestedSeconds)));

    job.stage = "Writing captions...";
    job.progress = 0.34;
    await writeAssCaptions({
      script,
      outputPath: captionsPath,
      totalSeconds: durationSeconds,
      layout: layout || "tiktok"
    });

    job.stage = "Rendering video...";
    job.progress = 0.4;
    await renderVideo({
      backgroundPath,
      audioPath,
      captionPath: captionsPath,
      outputPath,
      durationSeconds,
      layout: layout || "tiktok",
      onProgress: (value) => {
        job.progress = Math.max(job.progress, 0.4 + value * 0.58);
      }
    });

    job.ok = true;
    job.done = true;
    job.stage = "Done";
    job.progress = 1;
    job.videoUrl = `/renders/${job.id}/reddit-video.mp4`;
    job.durationSeconds = durationSeconds;
  } catch (error) {
    job.done = true;
    job.ok = false;
    job.error = error.message || "Render failed.";
    job.stage = "Failed";
  }
}

app.use((error, _request, response, _next) => {
  response.status(500).json({
    error: error.message || "Something went wrong."
  });
});

app.get("*", (_request, response) => {
  response.sendFile(path.join(distDir, "index.html"));
});

const server = app.listen(port, () => {
  console.log(`Reddit video maker backend running at http://127.0.0.1:${port}`);
});

export default server;

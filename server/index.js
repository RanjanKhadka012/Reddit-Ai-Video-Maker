import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import { nanoid } from "nanoid";
import { fetchStories } from "./reddit.js";
import { synthesizeTimedTts } from "./tts.js";
import {
  createScenePrompts,
  generateComfyPanels,
  generatePollinationsPanels,
  getComfyCheckpoints,
  getComfyStatus
} from "./image-panels.js";
import {
  createComicPanelVideo,
  getDuration,
  listBackgrounds,
  listComicPanels,
  renderVideo,
  writeAssCaptions
} from "./video.js";
import { backgroundsDir, comicPanelsDir, distDir, ensureDataDirs, rendersDir } from "./paths.js";

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

app.get("/api/comic-panels", async (_request, response, next) => {
  try {
    response.json({ panels: await listComicPanels(comicPanelsDir) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/comfyui/status", async (request, response, next) => {
  try {
    const url = String(request.query.url || "http://127.0.0.1:8188");
    const [status, checkpoints] = await Promise.all([getComfyStatus(url), getComfyCheckpoints(url)]);
    response.json({ ok: true, status, checkpoints });
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
    const {
      story,
      background,
      voice,
      targetMinutes,
      layout,
      visualMode,
      panelSource,
      imageStyle,
      panelCount,
      comfyUrl,
      comfyCheckpoint,
      comfySteps,
      elevenLabsApiKey,
      elevenLabsVoiceId
    } = request.body;
    if (!story?.script) throw new Error("Choose a story before rendering.");
    const useRedditCardOnly = visualMode === "reddit-card";
    const useComicPanels = visualMode === "comic";
    const useGeneratedPanels = useComicPanels && panelSource && panelSource !== "folder";
    if (!useRedditCardOnly && !useComicPanels && !background) {
      throw new Error("Add a background clip in the backgrounds folder first.");
    }

    let backgroundPath = null;
    if (!useRedditCardOnly && !useComicPanels) {
      const safeBackground = path.basename(background);
      backgroundPath = path.join(backgroundsDir, safeBackground);
      await fs.access(backgroundPath);
    } else if (useComicPanels && !useGeneratedPanels) {
      const panels = await listComicPanels(comicPanelsDir);
      if (!panels.length) throw new Error("Add PNG/JPG/WebP comic panels to the comic-panels folder first.");
    }

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
    const comicBackgroundPath = path.join(jobDir, "comic-background.mp4");
    const script = story.script;

    runRenderJob({
      job,
      story,
      script,
      audioPath,
      captionsPath,
      outputPath,
      comicBackgroundPath,
      jobDir,
      backgroundPath,
      voice,
      targetMinutes,
      layout,
      visualMode,
      panelSource,
      imageStyle,
      panelCount,
      comfyUrl,
      comfyCheckpoint,
      comfySteps,
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
  story,
  script,
  audioPath,
  captionsPath,
  outputPath,
  comicBackgroundPath,
  jobDir,
  backgroundPath,
  voice,
  targetMinutes,
  layout,
  visualMode,
  panelSource,
  imageStyle,
  panelCount,
  comfyUrl,
  comfyCheckpoint,
  comfySteps,
  elevenLabsApiKey,
  elevenLabsVoiceId
}) {
  try {
    job.stage = "Generating narration...";
    job.progress = 0.08;
    const ttsResult = await synthesizeTimedTts({
      text: script,
      voice: voice || process.env.TIKTOK_TTS_VOICE || "google-natural",
      outputPath: audioPath,
      workDir: jobDir,
      elevenLabsApiKey,
      elevenLabsVoiceId
    });

    job.stage = "Measuring narration...";
    job.progress = 0.28;
    const audioSeconds = await getDuration(audioPath);
    const requestedSeconds = Math.round(Math.min(600, Math.max(30, Number(targetMinutes || 2.4) * 60)));
    const durationSeconds = Math.min(600, Math.max(30, Math.min(audioSeconds || requestedSeconds, requestedSeconds)));

    job.stage = "Writing captions...";
    job.progress = 0.34;
    await writeAssCaptions({
      script,
      outputPath: captionsPath,
      totalSeconds: durationSeconds,
      layout: layout || "tiktok",
      captionMode: visualMode === "comic" ? "keyword" : "full",
      timedLines: ttsResult.timings,
      card:
        visualMode === "reddit-card"
          ? {
              title: story.title || "Reddit Story",
              body: story.selftext || script,
              subreddit: story.subreddit || "reddit",
              source: story.source || "screenshot-style"
            }
          : null
    });

    let renderBackgroundPath = backgroundPath;
    if (visualMode === "comic") {
      job.stage = panelSource && panelSource !== "folder" ? "Generating comic panels..." : "Preparing comic panels...";
      job.progress = 0.38;
      let panelPaths = [];
      if (panelSource === "pollinations" || panelSource === "comfyui") {
        const prompts = createScenePrompts({
          script,
          panelCount: Math.max(2, Math.min(24, Number(panelCount) || 8)),
          style: imageStyle || "comic"
        });
        const generatedDir = path.join(jobDir, "generated-panels");
        const generatorProgress = (value) => {
          job.progress = Math.max(job.progress, 0.38 + value * 0.28);
        };
        panelPaths =
          panelSource === "comfyui"
            ? await generateComfyPanels({
                prompts,
                outputDir: generatedDir,
                layout: layout || "tiktok",
                comfyUrl,
                checkpoint: comfyCheckpoint,
                steps: comfySteps,
                onProgress: generatorProgress
              })
            : await generatePollinationsPanels({
                prompts,
                outputDir: generatedDir,
                layout: layout || "tiktok",
                onProgress: generatorProgress
              });
      } else {
        const panelFiles = await listComicPanels(comicPanelsDir);
        panelPaths = panelFiles.map((file) => path.join(comicPanelsDir, file));
      }

      job.stage = "Preparing comic panels...";
      await createComicPanelVideo({
        panelPaths,
        outputPath: comicBackgroundPath,
        durationSeconds,
        layout: layout || "tiktok",
        workDir: jobDir,
        onProgress: (value) => {
          const start = panelSource && panelSource !== "folder" ? 0.66 : 0.38;
          const span = panelSource && panelSource !== "folder" ? 0.1 : 0.18;
          job.progress = Math.max(job.progress, start + value * span);
        }
      });
      renderBackgroundPath = comicBackgroundPath;
    }

    job.stage = "Rendering video...";
    job.progress = visualMode === "comic" ? (panelSource && panelSource !== "folder" ? 0.76 : 0.58) : 0.4;
    await renderVideo({
      backgroundPath: renderBackgroundPath,
      audioPath,
      captionPath: captionsPath,
      outputPath,
      durationSeconds,
      layout: layout || "tiktok",
      onProgress: (value) => {
        const start = visualMode === "comic" ? (panelSource && panelSource !== "folder" ? 0.76 : 0.58) : 0.4;
        const span = visualMode === "comic" ? (panelSource && panelSource !== "folder" ? 0.22 : 0.4) : 0.58;
        job.progress = Math.max(job.progress, start + value * span);
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

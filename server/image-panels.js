import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";

const defaultComfyUrl = "http://127.0.0.1:8188";

const stylePrompts = {
  comic:
    "vertical comic book panel, dramatic Reddit story illustration, bold ink outlines, expressive characters, cinematic lighting, high contrast, no text, no watermark",
  stickman:
    "vertical MS Paint style stickman drawing, simple white background, rough mouse-drawn lines, funny expressive stick figures, no text, no watermark",
  horror:
    "vertical horror comic panel, tense atmosphere, dramatic shadows, cinematic lighting, expressive character, bold ink outlines, no text, no watermark",
  webtoon:
    "vertical modern webtoon panel, clean anime-inspired illustration, expressive character acting, cinematic composition, no text, no watermark",
  cartoon:
    "vertical simple cartoon panel, clean colorful shapes, expressive character, storybook composition, no text, no watermark"
};

const negativePrompt =
  "text, captions, speech bubbles, watermark, logo, blurry, distorted hands, extra fingers, low quality, cropped face";

function safeComfyUrl(url) {
  const value = String(url || defaultComfyUrl).trim();
  if (!/^https?:\/\//i.test(value)) return defaultComfyUrl;
  return value.replace(/\/+$/, "");
}

function sceneSentences(script) {
  return String(script || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);
}

export function createScenePrompts({ script, panelCount, style }) {
  const sentences = sceneSentences(script);
  const count = Math.max(2, Math.min(24, Number(panelCount) || 8));
  const baseStyle = stylePrompts[style] || stylePrompts.comic;

  if (!sentences.length) {
    return Array.from({ length: count }, (_item, index) => ({
      scene: `A dramatic moment from the story, scene ${index + 1}.`,
      prompt: `${baseStyle}. Scene: A dramatic moment from the story, scene ${index + 1}.`
    }));
  }

  const chunkSize = Math.max(1, Math.ceil(sentences.length / count));
  const chunks = [];
  for (let i = 0; i < sentences.length && chunks.length < count; i += chunkSize) {
    chunks.push(sentences.slice(i, i + chunkSize).join(" "));
  }

  while (chunks.length < count) {
    chunks.push(sentences[chunks.length % sentences.length]);
  }

  return chunks.slice(0, count).map((scene) => {
    const trimmedScene = scene.length > 420 ? `${scene.slice(0, 420)}...` : scene;
    return {
      scene: trimmedScene,
      prompt: `${baseStyle}. Scene: ${trimmedScene}`
    };
  });
}

async function downloadImage(url, outputPath) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "reddit-video-maker/1.0"
    }
  });
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    let message = details;
    try {
      const parsed = JSON.parse(details);
      message = parsed.error || parsed.message || details;
    } catch {
      message = details;
    }
    throw new Error(`Image generation returned ${response.status}${message ? `: ${message}` : "."}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("image")) {
    throw new Error("Image generation did not return an image.");
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, bytes);
}

export async function generatePollinationsPanels({ prompts, outputDir, layout, onProgress }) {
  await fs.mkdir(outputDir, { recursive: true });
  const isYoutube = layout === "youtube";
  const width = isYoutube ? 1280 : 1080;
  const height = isYoutube ? 720 : 1920;
  const panelPaths = [];

  for (const [index, item] of prompts.entries()) {
    const seed = Math.floor(Math.random() * 1_000_000_000);
    const outputPath = path.join(outputDir, `generated-${String(index + 1).padStart(2, "0")}.jpg`);
    const encodedPrompt = encodeURIComponent(item.prompt);
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&seed=${seed}&nologo=true`;
    await downloadImage(url, outputPath);
    panelPaths.push(outputPath);
    onProgress?.((index + 1) / prompts.length);
  }

  return panelPaths;
}

export async function getComfyStatus(comfyUrl) {
  const baseUrl = safeComfyUrl(comfyUrl);
  const response = await fetch(`${baseUrl}/system_stats`).catch(() => {
    throw new Error(`ComfyUI is not reachable at ${baseUrl}. Start ComfyUI first.`);
  });
  if (!response.ok) throw new Error(`ComfyUI returned ${response.status}.`);
  return response.json();
}

export async function getComfyCheckpoints(comfyUrl) {
  const baseUrl = safeComfyUrl(comfyUrl);
  const response = await fetch(`${baseUrl}/object_info/CheckpointLoaderSimple`).catch(() => {
    throw new Error(`ComfyUI is not reachable at ${baseUrl}. Start ComfyUI first.`);
  });
  if (!response.ok) throw new Error(`ComfyUI returned ${response.status}.`);
  const info = await response.json();
  return info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
}

function comfyWorkflow({ prompt, checkpoint, seed, width, height, steps }) {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0]
      }
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: {
        ckpt_name: checkpoint
      }
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: {
        width,
        height,
        batch_size: 1
      }
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: prompt,
        clip: ["4", 1]
      }
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: negativePrompt,
        clip: ["4", 1]
      }
    },
    "8": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["3", 0],
        vae: ["4", 2]
      }
    },
    "9": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: "reddit_video_panel",
        images: ["8", 0]
      }
    }
  };
}

async function queueComfyPrompt({ baseUrl, workflow, clientId }) {
  const response = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.error || `ComfyUI returned ${response.status}.`);
  }
  if (!payload.prompt_id) throw new Error("ComfyUI did not return a prompt id.");
  return payload.prompt_id;
}

async function waitForComfyImage({ baseUrl, promptId, timeoutMs = 180000 }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const response = await fetch(`${baseUrl}/history/${promptId}`);
    if (!response.ok) continue;
    const history = await response.json();
    const item = history[promptId];
    const outputs = item?.outputs || {};
    for (const output of Object.values(outputs)) {
      const image = output.images?.[0];
      if (image) return image;
    }
  }
  throw new Error("Timed out waiting for ComfyUI image.");
}

async function saveComfyImage({ baseUrl, image, outputPath }) {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || "",
    type: image.type || "output"
  });
  await downloadImage(`${baseUrl}/view?${params}`, outputPath);
}

export async function generateComfyPanels({
  prompts,
  outputDir,
  layout,
  comfyUrl,
  checkpoint,
  steps,
  onProgress
}) {
  await fs.mkdir(outputDir, { recursive: true });
  const baseUrl = safeComfyUrl(comfyUrl);
  const checkpoints = await getComfyCheckpoints(baseUrl);
  const selectedCheckpoint = checkpoint || checkpoints[0];
  if (!selectedCheckpoint) throw new Error("No ComfyUI checkpoint found. Add a model in ComfyUI first.");

  const isYoutube = layout === "youtube";
  const width = isYoutube ? 1280 : 768;
  const height = isYoutube ? 720 : 1344;
  const clientId = nanoid();
  const panelPaths = [];

  for (const [index, item] of prompts.entries()) {
    const workflow = comfyWorkflow({
      prompt: item.prompt,
      checkpoint: selectedCheckpoint,
      seed: Math.floor(Math.random() * 1_000_000_000),
      width,
      height,
      steps: Math.max(8, Math.min(40, Number(steps) || 18))
    });
    const promptId = await queueComfyPrompt({ baseUrl, workflow, clientId });
    const image = await waitForComfyImage({ baseUrl, promptId });
    const outputPath = path.join(outputDir, `generated-${String(index + 1).padStart(2, "0")}.png`);
    await saveComfyImage({ baseUrl, image, outputPath });
    panelPaths.push(outputPath);
    onProgress?.((index + 1) / prompts.length);
  }

  return panelPaths;
}

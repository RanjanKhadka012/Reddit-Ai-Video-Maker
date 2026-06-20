import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";

const defaultComfyUrl = "http://127.0.0.1:8188";

const stylePrompts = {
  comic:
    "single full-frame vertical inked story illustration, one uninterrupted camera shot, one image only, grounded everyday Reddit story scene, bold clean outlines, expressive normal people, cinematic lighting, high contrast, clean readable composition, no text, no watermark",
  stickman:
    "single full-frame vertical MS Paint style stickman drawing, one uninterrupted camera shot, consistent simple white background, rough mouse-drawn lines, funny expressive stick figures acting out the story, no text, no watermark",
  horror:
    "single full-frame vertical horror story illustration, one uninterrupted camera shot, one image only, grounded realistic setting, tense atmosphere, dramatic shadows, cinematic lighting, expressive character, bold ink outlines, no text, no watermark",
  webtoon:
    "single full-frame vertical modern character illustration, one uninterrupted camera shot, one image only, clean anime-inspired style, expressive character acting, grounded everyday setting, cinematic composition, no text, no watermark",
  cartoon:
    "single full-frame vertical simple cartoon illustration, one uninterrupted camera shot, clean colorful shapes, expressive character, grounded storybook composition, no text, no watermark"
};

const negativePrompt =
  "(comic page:1.8), (manga page:1.8), (page layout:1.8), (storyboard grid:1.8), (multiple panels:1.8), (panel borders:1.7), (speech bubbles:1.7), (text:1.6), captions, dialogue balloons, watermark, logo, blurry, distorted hands, extra fingers, low quality, cropped face, collage, split screen, side by side scenes, before and after, many tiny panels, multiple frames, sequence of events, map, diagram, infographic, document wall, corkboard, evidence board, abstract background, sci-fi armor, robots, soldiers, war battle, fantasy creatures, unrelated action scene";

function safeComfyUrl(url) {
  const value = String(url || defaultComfyUrl).trim();
  if (!/^https?:\/\//i.test(value)) return defaultComfyUrl;
  return value.replace(/\/+$/, "");
}

function sceneSentences(script) {
  return String(script || "")
    .replace(/\s+/g, " ")
    .replace(/comment\s+\d+(\s+by\s+u\/?[a-z0-9_-]+)?[.:]\s*/gi, "")
    .replace(/u\/[a-z0-9_-]+[.:]\s*/gi, "")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);
}

function compactText(value, maxLength = 260) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
}

function promptNote(value, maxLength = 700) {
  return compactText(value, maxLength).replace(/[<>]/g, "");
}

function singleSceneFocus(scene) {
  const sentences = sceneSentences(scene);
  const focus = sentences[0] || String(scene || "");
  return compactText(focus, 210).replace(/[.!?]+$/, "");
}

function inferNarratorDescription(text) {
  const source = String(text || "");
  const ageGender = source.match(/\b(?:i\s*(?:am|'m)?\s*)?\(?([1-9][0-9])\s*([fFmM])\)?\b/);
  if (ageGender) {
    const age = ageGender[1];
    const gender = ageGender[2].toLowerCase() === "f" ? "woman" : "man";
    return `the same ${age}-year-old ${gender} narrator/protagonist`;
  }

  if (/\b(my husband|my boyfriend|pregnant|wife|girlfriend)\b/i.test(source)) {
    return "the same adult woman narrator/protagonist";
  }

  if (/\b(my wife|my girlfriend|husband|boyfriend)\b/i.test(source)) {
    return "the same adult man narrator/protagonist";
  }

  if (/\bteacher|student|school|classroom\b/i.test(source)) {
    return "the same ordinary teacher or student narrator/protagonist";
  }

  return "the same ordinary adult narrator/protagonist";
}

function defaultCharacterProfile(text) {
  const protagonist = inferNarratorDescription(text);
  if (/\bteacher|student|school|classroom\b/i.test(text)) {
    return `${protagonist}: realistic everyday clothing, consistent face, consistent hair, same age, same outfit colors, calm expressive body language.`;
  }
  if (/\bretail|cashier|customer|store|pharmacy|bookstore|grocery\b/i.test(text)) {
    return `${protagonist}: realistic everyday clothing, consistent face, consistent hair, same age, visible work or casual outfit repeated in every image.`;
  }
  if (/\bhotel|nurse|warehouse|security|janitor|night shift|overnight\b/i.test(text)) {
    return `${protagonist}: tired night-shift worker, consistent face, consistent hair, same uniform or practical dark clothing, same age in every image.`;
  }
  return `${protagonist}: realistic everyday person, consistent face, consistent hair, same age, same outfit and color palette across all images.`;
}

function inferMainSetting(text) {
  const source = String(text || "").toLowerCase();
  if (source.includes("therapist") || source.includes("therapy")) return "a therapist office and quiet personal memory scenes";
  if (source.includes("school") || source.includes("teacher") || source.includes("classroom")) return "a realistic school or classroom";
  if (source.includes("work") || source.includes("boss") || source.includes("coworker") || source.includes("office")) {
    return "a realistic workplace or office";
  }
  if (source.includes("wedding")) return "a wedding venue or family gathering";
  if (source.includes("family") || source.includes("mom") || source.includes("dad") || source.includes("sister") || source.includes("brother")) {
    return "a realistic family home";
  }
  if (source.includes("restaurant") || source.includes("dinner")) return "a restaurant or dinner table";
  return "a believable real-world setting from the story";
}

function storyVisualBible({ script, title, style, characterBible, settingBible }) {
  const combined = `${title || ""}. ${script || ""}`;
  const character = promptNote(characterBible) || defaultCharacterProfile(combined);
  const setting = promptNote(settingBible) || inferMainSetting(combined);
  const palette =
    style === "horror"
      ? "muted dark colors with tense shadows"
      : style === "stickman"
        ? "simple black lines on white"
        : "consistent warm natural colors";

  return [
    `Character Bible: ${character}`,
    "Character continuity: reuse the same protagonist design in every generated image. Same face, hair, age, outfit, body type, and color palette. If another person appears, keep them secondary unless the story specifically focuses on them.",
    `Setting Bible: ${setting}`,
    "Scenario continuity: keep the same room, props, time of day, lighting, and camera language whenever the story stays in the same place. Only change location when the selected sentence clearly moves somewhere else.",
    `Visual continuity: ${palette}, same camera language, same illustration style for the whole video.`,
    "Single-image rule: each generated image is one continuous camera shot in one location at one moment. It must look like one poster or film still, never a comic page, never multiple panels, never speech bubbles."
  ].join(" ");
}

export function createScenePrompts({ script, title, panelCount, style, characterBible, settingBible }) {
  const sentences = sceneSentences(script);
  const count = Math.max(2, Math.min(24, Number(panelCount) || 8));
  const baseStyle = stylePrompts[style] || stylePrompts.comic;
  const styleLabel = style === "comic" ? "inked story illustration" : style || "inked story illustration";
  const storyTitle = String(title || "Reddit story").replace(/\s+/g, " ").trim();
  const visualBible = storyVisualBible({ script, title, style, characterBible, settingBible });
  const styleLock = `Continuity lock for the whole video. Use this exact same visual style for every generated image: ${styleLabel}. ${visualBible}`;

  if (!sentences.length) {
    return Array.from({ length: count }, (_item, index) => ({
      scene: `A dramatic moment from the story, scene ${index + 1}.`,
      prompt: `${baseStyle}. ${styleLock} Reddit thread title: ${storyTitle}. Panel ${index + 1}: show the same protagonist reacting to one dramatic moment from the story. Make exactly one full-screen illustration, one location, one main action, one clear foreground subject, no borders, no page layout, no speech bubbles.`
    }));
  }

  const selectedScenes = Array.from({ length: count }, (_item, index) => {
    const sceneIndex = Math.min(sentences.length - 1, Math.floor((index * sentences.length) / count));
    return sentences[sceneIndex];
  });

  return selectedScenes.map((scene) => {
    const trimmedScene = singleSceneFocus(scene);
    return {
      scene: trimmedScene,
      prompt: `${baseStyle}. ${styleLock} Reddit thread title: ${storyTitle}. Current panel moment: ${trimmedScene}. Illustrate only this one moment with the same protagonist design and setting rules from the continuity lock. Make exactly one full-screen illustration like a single movie still: one room or location, one main action, one clear foreground subject, single camera angle. No borders. No gutters. No page layout. No speech bubbles. Do not summarize the whole story. Do not show multiple moments, multiple rooms, multiple panels, frames, documents, or a collage.`
    };
  });
}

async function imageLooksUsable(filePath) {
  const stats = await fs.stat(filePath).catch(() => null);
  return Boolean(stats && stats.size > 20_000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadImageOnce(url, outputPath) {
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

async function downloadImage(url, outputPath, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await downloadImageOnce(url, outputPath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
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
    if (!(await imageLooksUsable(outputPath))) {
      const retryPrompt = encodeURIComponent(
        `${item.prompt}. Regenerate as exactly one full-screen illustration: one scene, one location, one main character/action, no comic page, no panel grid, no borders, no speech bubbles, no collage, no split-screen, no storyboard, no map, no document wall.`
      );
      const retryUrl = `https://image.pollinations.ai/prompt/${retryPrompt}?width=${width}&height=${height}&seed=${seed + 101}&nologo=true`;
      await downloadImage(retryUrl, outputPath);
    }
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
    if (!(await imageLooksUsable(outputPath))) {
      const retryWorkflow = comfyWorkflow({
        prompt: `${item.prompt}. Regenerate as exactly one full-screen illustration: one scene, one location, one main character/action, no comic page, no panel grid, no borders, no speech bubbles, no collage, no split-screen, no storyboard, no map, no document wall.`,
        checkpoint: selectedCheckpoint,
        seed: Math.floor(Math.random() * 1_000_000_000),
        width,
        height,
        steps: Math.max(8, Math.min(40, Number(steps) || 18))
      });
      const retryPromptId = await queueComfyPrompt({ baseUrl, workflow: retryWorkflow, clientId });
      const retryImage = await waitForComfyImage({ baseUrl, promptId: retryPromptId });
      await saveComfyImage({ baseUrl, image: retryImage, outputPath });
    }
    panelPaths.push(outputPath);
    onProgress?.((index + 1) / prompts.length);
  }

  return panelPaths;
}

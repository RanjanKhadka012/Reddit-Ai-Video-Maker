# Reddit Video Maker

A local Windows desktop app that turns Reddit stories into captioned videos with TTS narration, animated backgrounds, and TikTok/YouTube layout options.

## Features

- Fetches Reddit stories and long top comments.
- Falls back to old.reddit.com when Reddit JSON requests are blocked.
- Supports manual story/script input.
- TTS options:
  - Google TTS fallback
  - ElevenLabs API integration
  - TikTok-style unofficial TTS fallback
  - Windows speech fallback
- Burns captions into the final video.
- Supports TikTok/Shorts `9:16` output.
- Supports YouTube `16:9` output.
- Shows render progress while generating.
- Includes an original animated runner background.
- Includes comic story mode with animated image panels and big keyword captions.
- Lets you use your own `.mp4`, `.mov`, `.mkv`, or `.webm` background clips.

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open:

```text
http://127.0.0.1:4141
```

## Desktop App

Run the Electron desktop app locally:

```powershell
npm run desktop
```

Build a portable Windows `.exe`:

```powershell
npm run dist:win
```

The built app is written to:

```text
release/
```

When the portable app runs, it creates editable folders beside the `.exe`:

```text
reddit-video-maker-data/backgrounds/
reddit-video-maker-data/renders/
reddit-video-maker-data/comic-panels/
```

## Background Clips

The app includes `animated-runner.mp4` as a starter animated background.

For better results, add your own gameplay or parkour clips to:

```text
backgrounds/
```

In the portable `.exe`, use:

```text
reddit-video-maker-data/backgrounds/
```

Use clips you have rights to use. The app does not include Subway Surfers, Temple Run, or Minecraft footage.

## Comic Story Mode

Choose `Comic panels + keyword captions` in Visual mode to make videos like AI comic-story clips. Add numbered panels to:

```text
comic-panels/
```

In the portable `.exe`, use:

```text
reddit-video-maker-data/comic-panels/
```

Supported panel formats are `.png`, `.jpg`, `.jpeg`, and `.webp`. The app uses the files in filename order, animates them with a subtle pan/zoom, then burns large keyword captions over the video.

## ElevenLabs

Choose `ElevenLabs` in the Voice dropdown, then enter:

- your ElevenLabs API key
- a Voice ID

The API key is stored locally in app/browser storage. Do not commit API keys to GitHub.

## Reddit Access

Reddit may block anonymous JSON/API requests. The app tries:

1. Reddit JSON/API
2. old.reddit.com HTML fallback
3. manual script input

For better reliability, create a Reddit app and add credentials to `.env`:

```text
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=RedditVideoMaker/1.0 by your_reddit_username
```

## Output

Finished videos are saved under:

```text
renders/
```

In the portable app, finished videos are saved under:

```text
reddit-video-maker-data/renders/
```

## Notes

This project is intended for local content generation and experimentation. Respect platform terms, creator rights, Reddit content rights, and TTS provider terms when publishing generated videos.

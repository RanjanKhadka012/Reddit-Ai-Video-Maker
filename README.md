# Reddit Video Maker

Local app for making TikTok-style Reddit story videos:

- Fetches Reddit text posts and long top comments.
- Generates narration with TikTok's commonly used unofficial TTS endpoint.
- Burns readable captions onto a vertical 1080x1920 video.
- Loops/crops your own parkour, Temple Run, Subway Surfers, or other gameplay clip as the background.

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

## Background Clips

Put your own `.mp4`, `.mov`, `.mkv`, or `.webm` files here:

```text
backgrounds/
```

Then press **Refresh Backgrounds** in the app.

Use clips you have rights to use. The app does not include parkour, Temple Run, or Subway Surfers footage because those clips can have copyright/platform issues.

## Windows EXE

Build a portable Windows app:

```powershell
npm run dist:win
```

The `.exe` is written to:

```text
release/
```

When the portable app runs, it creates editable folders beside the `.exe`:

```text
reddit-video-maker-data/backgrounds/
reddit-video-maker-data/renders/
```

## Rendered Videos

Finished videos are saved under:

```text
renders/
```

The app also shows a preview and download button after rendering.

## Notes

Reddit asks API clients to use a unique, descriptive User-Agent. Edit `.env` and set `REDDIT_USER_AGENT` to include your Reddit username or project name.

TikTok does not provide a stable public TTS API for this workflow. If the unofficial endpoint stops working, the rest of the app can stay the same, but `server/tts.js` will need a different voice provider.

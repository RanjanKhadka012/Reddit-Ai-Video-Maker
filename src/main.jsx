import React from "react";
import { createRoot } from "react-dom/client";
import { Download, Film, Loader2, Play, RefreshCw, Search, Sparkles } from "lucide-react";
import "./styles.css";

const API = "http://127.0.0.1:4141";

const voices = [
  { id: "elevenlabs", label: "ElevenLabs" },
  { id: "google-natural", label: "Natural Narrator" },
  { id: "en_us_001", label: "TikTok Jessie" },
  { id: "en_us_006", label: "TikTok Joey" },
  { id: "en_us_009", label: "TikTok Story" }
];

function App() {
  const [subreddit, setSubreddit] = React.useState("AskReddit");
  const [sort, setSort] = React.useState("top");
  const [time, setTime] = React.useState("day");
  const [stories, setStories] = React.useState([]);
  const [selectedStory, setSelectedStory] = React.useState(null);
  const [backgrounds, setBackgrounds] = React.useState([]);
  const [background, setBackground] = React.useState("");
  const [comicPanels, setComicPanels] = React.useState([]);
  const [panelSource, setPanelSource] = React.useState("folder");
  const [imageStyle, setImageStyle] = React.useState("comic");
  const [panelCount, setPanelCount] = React.useState(8);
  const [comfyUrl, setComfyUrl] = React.useState(() => localStorage.getItem("comfyUrl") || "http://127.0.0.1:8188");
  const [comfyCheckpoint, setComfyCheckpoint] = React.useState(() => localStorage.getItem("comfyCheckpoint") || "");
  const [comfySteps, setComfySteps] = React.useState(18);
  const [comfyCheckpoints, setComfyCheckpoints] = React.useState([]);
  const [comfyStatus, setComfyStatus] = React.useState("");
  const [voice, setVoice] = React.useState("google-natural");
  const [layout, setLayout] = React.useState("tiktok");
  const [visualMode, setVisualMode] = React.useState("gameplay");
  const [elevenLabsApiKey, setElevenLabsApiKey] = React.useState(() => localStorage.getItem("elevenLabsApiKey") || "");
  const [elevenLabsVoiceId, setElevenLabsVoiceId] = React.useState(
    () => localStorage.getItem("elevenLabsVoiceId") || "21m00Tcm4TlvDq8ikWAM"
  );
  const [targetMinutes, setTargetMinutes] = React.useState(2.4);
  const [manualTitle, setManualTitle] = React.useState("Manual Reddit Story");
  const [manualScript, setManualScript] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [renderProgress, setRenderProgress] = React.useState(0);
  const [renderStage, setRenderStage] = React.useState("");
  const [renderResult, setRenderResult] = React.useState(null);

  async function api(path, options) {
    const response = await fetch(`${API}${path}`, options);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Request failed.");
    return payload;
  }

  async function loadBackgrounds() {
    const payload = await api("/api/backgrounds");
    setBackgrounds(payload.backgrounds);
    if (!background && payload.backgrounds.length) setBackground(payload.backgrounds[0]);
  }

  async function loadComicPanels() {
    const payload = await api("/api/comic-panels");
    setComicPanels(payload.panels);
  }

  async function checkComfyUi() {
    setBusy(true);
    setComfyStatus("Checking ComfyUI...");
    setStatus("Checking ComfyUI...");
    try {
      const params = new URLSearchParams({ url: comfyUrl });
      const payload = await api(`/api/comfyui/status?${params}`);
      setComfyCheckpoints(payload.checkpoints || []);
      if (!comfyCheckpoint && payload.checkpoints?.length) setComfyCheckpoint(payload.checkpoints[0]);
      setComfyStatus(`Connected. ${payload.checkpoints?.length || 0} checkpoint(s) found.`);
      setStatus("ComfyUI connected.");
    } catch (error) {
      setComfyStatus(error.message);
      setStatus(`ComfyUI not ready: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function fetchStories() {
    setBusy(true);
    setStatus("Fetching Reddit stories...");
    setRenderResult(null);
    try {
      const params = new URLSearchParams({ subreddit, sort, time, limit: "20" });
      const payload = await api(`/api/reddit?${params}`);
      setStories(payload.stories);
      setSelectedStory(payload.stories[0] || null);
      setStatus(payload.stories.length ? "Pick a story and render." : "No long self-posts found. Try another subreddit.");
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function renderVideo() {
    if (!selectedStory) {
      if (manualScript.trim().split(/\s+/).filter(Boolean).length >= 80) {
        const script = manualScript.trim();
        await renderStory({
          id: "manual",
          title: manualTitle.trim() || "Manual Reddit Story",
          author: "manual",
          score: 0,
          comments: 0,
          subreddit: "manual",
          permalink: "",
          selftext: script,
          script,
          estimatedSeconds: Math.max(30, Math.round((script.split(/\s+/).length / 145) * 60)),
          source: "manual"
        });
        return;
      }

      setStatus("Pick a Reddit story or paste at least 80 words into Manual Script.");
      return;
    }

    await renderStory(selectedStory);
  }

  async function renderStory(storyToRender) {
    if (visualMode === "comic" && panelSource === "folder" && comicPanels.length === 0) {
      setStatus("Add PNG/JPG/WebP comic panels to the comic-panels folder, then refresh.");
      return;
    }

    if (visualMode === "comic" && panelSource === "comfyui" && !comfyCheckpoint.trim()) {
      setStatus("Check ComfyUI and choose a checkpoint before rendering with local ComfyUI.");
      return;
    }

    if (visualMode !== "reddit-card" && visualMode !== "comic" && !background) {
      setStatus("Put an MP4/MOV/WebM background in the backgrounds folder, then refresh.");
      return;
    }

    if (voice === "elevenlabs" && !elevenLabsApiKey.trim()) {
      setStatus("Paste your ElevenLabs API key before rendering with ElevenLabs.");
      return;
    }

    setBusy(true);
    setRenderProgress(0.02);
    setRenderStage("Starting render...");
    setStatus("Starting render...");
    setRenderResult(null);
    try {
      const payload = await api("/api/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          story: storyToRender,
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
          elevenLabsApiKey: voice === "elevenlabs" ? elevenLabsApiKey.trim() : "",
          elevenLabsVoiceId: voice === "elevenlabs" ? elevenLabsVoiceId.trim() : ""
        })
      });
      const result = await waitForRenderJob(payload.jobId);
      setRenderResult(result);
      setStatus(`Rendered ${Math.round(result.durationSeconds)} seconds.`);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
      setRenderStage("");
    }
  }

  async function waitForRenderJob(jobId) {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      const job = await api(`/api/jobs/${jobId}`);
      setRenderProgress(job.progress || 0);
      setRenderStage(job.stage || "");
      setStatus(job.stage || "Rendering...");

      if (job.done) {
        if (!job.ok) throw new Error(job.error || "Render failed.");
        return job;
      }
    }
  }

  function useManualScript() {
    const script = manualScript.trim();
    if (script.split(/\s+/).filter(Boolean).length < 80) {
      setStatus("Manual script needs at least 80 words.");
      return;
    }

    setSelectedStory({
      id: "manual",
      title: manualTitle.trim() || "Manual Reddit Story",
      author: "manual",
      score: 0,
      comments: 0,
      subreddit: "manual",
      permalink: "",
      selftext: script,
      script,
      estimatedSeconds: Math.max(30, Math.round((script.split(/\s+/).length / 145) * 60)),
      source: "manual"
    });
    setStatus("Manual script selected. Choose a background and render.");
  }

  React.useEffect(() => {
    loadBackgrounds().catch((error) => setStatus(error.message));
    loadComicPanels().catch((error) => setStatus(error.message));
  }, []);

  React.useEffect(() => {
    localStorage.setItem("elevenLabsApiKey", elevenLabsApiKey);
  }, [elevenLabsApiKey]);

  React.useEffect(() => {
    localStorage.setItem("elevenLabsVoiceId", elevenLabsVoiceId);
  }, [elevenLabsVoiceId]);

  React.useEffect(() => {
    localStorage.setItem("comfyUrl", comfyUrl);
  }, [comfyUrl]);

  React.useEffect(() => {
    localStorage.setItem("comfyCheckpoint", comfyCheckpoint);
  }, [comfyCheckpoint]);

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>Reddit Video Maker</h1>
            <p>Fetch a story, choose a gameplay loop, and render a captioned vertical video.</p>
          </div>
          <button className="primary" onClick={renderVideo} disabled={busy}>
            {busy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            {selectedStory || manualScript.trim().split(/\s+/).filter(Boolean).length >= 80 ? "Render" : "Select Story"}
          </button>
        </header>

        <div className="control-strip">
          <label>
            Subreddit
            <div className="input-row">
              <span>r/</span>
              <input value={subreddit} onChange={(event) => setSubreddit(event.target.value)} />
            </div>
          </label>
          <label>
            Sort
            <select value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="top">Top</option>
              <option value="hot">Hot</option>
              <option value="new">New</option>
              <option value="rising">Rising</option>
            </select>
          </label>
          <label>
            Time
            <select value={time} onChange={(event) => setTime(event.target.value)} disabled={sort !== "top"}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
              <option value="all">All</option>
            </select>
          </label>
          <button className="secondary" onClick={fetchStories} disabled={busy}>
            <Search size={18} />
            Get Stories
          </button>
        </div>

        <div className={`status-banner ${status ? "active" : ""}`}>
          {status || "Choose a Reddit story, or paste a manual story and press Render."}
        </div>

        <div className="main-grid">
          <section className="story-list" aria-label="Stories">
            {stories.length === 0 ? (
              <div className="empty-state">
                <Sparkles size={28} />
                <h2>Start with a subreddit</h2>
                <p>Try AskReddit, TrueOffMyChest, or NoSleep. Long text posts work best.</p>
              </div>
            ) : (
              stories.map((story) => (
                <button
                  className={`story-card ${selectedStory?.id === story.id ? "active" : ""}`}
                  key={story.id}
                  onClick={() => setSelectedStory(story)}
                >
                  <span className="story-title">{story.title}</span>
                  <span className="story-meta">
                    {story.score} points · {story.comments} comments · ~{story.estimatedSeconds}s
                  </span>
                </button>
              ))
            )}
          </section>

          <aside className="render-panel">
            <div className="panel-section">
              <h2>Video Setup</h2>
              <div className="selected-story">
                <span>Selected</span>
                <strong>{selectedStory ? selectedStory.title : "No story selected"}</strong>
              </div>
              <label>
                Visual mode
                <select value={visualMode} onChange={(event) => setVisualMode(event.target.value)}>
                  <option value="gameplay">Gameplay / animated background</option>
                  <option value="reddit-card">Reddit card + captions only</option>
                  <option value="comic">Comic panels + keyword captions</option>
                </select>
              </label>
              <label>
                Background
                <select
                  value={background}
                  onChange={(event) => setBackground(event.target.value)}
                  disabled={visualMode === "reddit-card" || visualMode === "comic"}
                >
                  {backgrounds.length === 0 ? (
                    <option value="">No backgrounds found</option>
                  ) : (
                    backgrounds.map((file) => (
                      <option key={file} value={file}>
                        {file}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <button className="secondary full" onClick={loadBackgrounds} disabled={busy}>
                <RefreshCw size={18} />
                Refresh Backgrounds
              </button>
              {visualMode === "comic" ? (
                <div className="asset-note">
                  <label>
                    Panel source
                    <select value={panelSource} onChange={(event) => setPanelSource(event.target.value)}>
                      <option value="folder">Use comic-panels folder</option>
                      <option value="pollinations">Generate with Pollinations</option>
                      <option value="comfyui">Generate with local ComfyUI</option>
                    </select>
                  </label>
                  {panelSource === "folder" ? (
                    <>
                      <strong>{comicPanels.length} comic panel{comicPanels.length === 1 ? "" : "s"} found</strong>
                      <span>Use numbered PNG, JPG, or WebP panels in the comic-panels folder.</span>
                      <button className="secondary full" onClick={loadComicPanels} disabled={busy}>
                        <RefreshCw size={18} />
                        Refresh Comic Panels
                      </button>
                    </>
                  ) : (
                    <>
                      <label>
                        Image style
                        <select value={imageStyle} onChange={(event) => setImageStyle(event.target.value)}>
                          <option value="comic">Comic book</option>
                          <option value="stickman">MS Paint stickman</option>
                          <option value="horror">Horror comic</option>
                          <option value="webtoon">Anime / webtoon</option>
                          <option value="cartoon">Simple cartoon</option>
                        </select>
                      </label>
                      <label>
                        Panels
                        <input
                          type="range"
                          min="2"
                          max="24"
                          step="1"
                          value={panelCount}
                          onChange={(event) => setPanelCount(event.target.value)}
                        />
                        <span className="range-readout">{panelCount} panels</span>
                      </label>
                    </>
                  )}
                  {panelSource === "comfyui" ? (
                    <div className="comfy-settings">
                      <label>
                        ComfyUI URL
                        <input value={comfyUrl} onChange={(event) => setComfyUrl(event.target.value)} />
                      </label>
                      <button className="secondary full" onClick={checkComfyUi} disabled={busy}>
                        <RefreshCw size={18} />
                        Check ComfyUI
                      </button>
                      <label>
                        Checkpoint
                        <select value={comfyCheckpoint} onChange={(event) => setComfyCheckpoint(event.target.value)}>
                          {comfyCheckpoints.length === 0 ? (
                            <option value={comfyCheckpoint}>{comfyCheckpoint || "Check ComfyUI first"}</option>
                          ) : (
                            comfyCheckpoints.map((file) => (
                              <option key={file} value={file}>
                                {file}
                              </option>
                            ))
                          )}
                        </select>
                      </label>
                      <label>
                        Steps
                        <input
                          type="range"
                          min="8"
                          max="40"
                          step="1"
                          value={comfySteps}
                          onChange={(event) => setComfySteps(event.target.value)}
                        />
                        <span className="range-readout">{comfySteps} steps</span>
                      </label>
                      <span>{comfyStatus || "Start ComfyUI locally, then check connection."}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <p className="hint">
                {visualMode === "comic"
                  ? "Comic mode animates still panels and uses bold keyword captions like story-summary videos."
                  : visualMode === "reddit-card"
                  ? "This mode skips gameplay and renders a Reddit-style card with captions."
                  : "Use your own parkour or gameplay MP4 for the best look. The sample is only a clean starter loop."}
              </p>
            </div>

            <div className="panel-section manual">
              <h2>Manual Script</h2>
              <label>
                Title
                <input value={manualTitle} onChange={(event) => setManualTitle(event.target.value)} />
              </label>
              <label>
                Story text
                <textarea
                  value={manualScript}
                  onChange={(event) => setManualScript(event.target.value)}
                  placeholder="Paste a story here if Reddit blocks the fetch."
                />
              </label>
              <button className="secondary full" onClick={useManualScript} disabled={busy}>
                Use Manual Script
              </button>
            </div>

            <div className="panel-section">
              <label>
                Voice
                <select value={voice} onChange={(event) => setVoice(event.target.value)}>
                  {voices.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} ({item.id})
                    </option>
                  ))}
                </select>
              </label>
              {voice === "elevenlabs" ? (
                <div className="elevenlabs-settings">
                  <label>
                    ElevenLabs API key
                    <input
                      type="password"
                      value={elevenLabsApiKey}
                      onChange={(event) => setElevenLabsApiKey(event.target.value)}
                      placeholder="sk_..."
                    />
                  </label>
                  <label>
                    Voice ID
                    <input value={elevenLabsVoiceId} onChange={(event) => setElevenLabsVoiceId(event.target.value)} />
                  </label>
                </div>
              ) : null}
              <label>
                Layout
                <select value={layout} onChange={(event) => setLayout(event.target.value)}>
                  <option value="tiktok">TikTok / Shorts (9:16)</option>
                  <option value="youtube">YouTube (16:9)</option>
                </select>
              </label>
              <label>
                Target length
                <input
                  type="range"
                  min="0.5"
                  max="10"
                  step="0.1"
                  value={targetMinutes}
                  onChange={(event) => setTargetMinutes(event.target.value)}
                />
                <span className="range-readout">{Number(targetMinutes).toFixed(1)} minutes</span>
              </label>
            </div>

            {busy ? (
              <div className="progress-block">
                <div className="progress-label">
                  <span>{renderStage || "Rendering..."}</span>
                  <strong>{Math.round((renderProgress || 0) * 100)}%</strong>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${Math.round((renderProgress || 0) * 100)}%` }} />
                </div>
              </div>
            ) : null}

            <div className="panel-section preview">
              {renderResult ? (
                <>
                  <video controls src={`${API}${renderResult.videoUrl}`} />
                  <a className="download" href={`${API}${renderResult.videoUrl}`} download>
                    <Download size={18} />
                    Download MP4
                  </a>
                </>
              ) : (
                <div className="preview-empty">
                  <Film size={30} />
                  <span>Rendered video appears here</span>
                </div>
              )}
            </div>

            <p className="status">{status || "Add your own parkour, Temple Run, or Subway Surfers clip to backgrounds."}</p>
          </aside>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);

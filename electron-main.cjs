const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { app, BrowserWindow, Menu, shell } = require("electron");

let mainWindow = null;
const browserFetchUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 RedditVideoMaker/1.0";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

const isPackaged = app.isPackaged;
const dataRoot = isPackaged
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath), "reddit-video-maker-data")
  : __dirname;

process.env.RVM_DATA_DIR = dataRoot;

function ensurePortableFolders() {
  const backgrounds = path.join(dataRoot, "backgrounds");
  const comicPanels = path.join(dataRoot, "comic-panels");
  const piperVoices = path.join(dataRoot, "piper-voices");
  const renders = path.join(dataRoot, "renders");
  fs.mkdirSync(backgrounds, { recursive: true });
  fs.mkdirSync(comicPanels, { recursive: true });
  fs.mkdirSync(piperVoices, { recursive: true });
  fs.mkdirSync(renders, { recursive: true });

  if (isPackaged) {
    const bundledFolders = [
      { source: path.join(process.resourcesPath, "backgrounds"), target: backgrounds },
      { source: path.join(process.resourcesPath, "comic-panels"), target: comicPanels },
      { source: path.join(process.resourcesPath, "piper-voices"), target: piperVoices }
    ];

    for (const folder of bundledFolders) {
      if (!fs.existsSync(folder.source)) continue;
      for (const entry of fs.readdirSync(folder.source)) {
        const source = path.join(folder.source, entry);
        const target = path.join(folder.target, entry);
        if (!fs.existsSync(target) && fs.statSync(source).isFile()) {
          fs.copyFileSync(source, target);
        }
      }
    }
  }
}

async function startServer() {
  globalThis.__RVM_BROWSER_FETCH__ = fetchPageWithHiddenBrowser;
  process.env.PORT = process.env.PORT || String(await findOpenPort(4141));
  await import("./server/index.js");
}

function fetchPageWithHiddenBrowser(url) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 1200,
      height: 900,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    const cleanup = () => {
      if (!win.isDestroyed()) win.destroy();
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while loading Reddit in the background browser."));
    }, 30000);

    win.webContents.once("did-fail-load", (_event, _code, description) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(description || "Background browser could not load Reddit."));
    });

    win.webContents.once("did-finish-load", async () => {
      try {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1800));
        const html = await win.webContents.executeJavaScript(
          "document.documentElement ? document.documentElement.outerHTML : document.body.innerHTML",
          true
        );
        clearTimeout(timer);
        cleanup();
        resolve(html);
      } catch (error) {
        clearTimeout(timer);
        cleanup();
        reject(error);
      }
    });

    win.loadURL(url, {
      userAgent: browserFetchUserAgent,
      extraHeaders: "Accept-Language: en-US,en;q=0.9"
    }).catch((error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });
  });
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, "127.0.0.1");
  });
}

async function findOpenPort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortOpen(port)) return port;
  }
  throw new Error(`No available local port found between ${startPort} and ${startPort + 49}.`);
}

function zoomWindow(win, direction) {
  const currentFactor = win.webContents.getZoomFactor();
  const nextFactor =
    direction === "reset" ? 1 : Math.min(3, Math.max(0.5, currentFactor + (direction === "in" ? 0.1 : -0.1)));
  win.webContents.setZoomFactor(Number(nextFactor.toFixed(2)));
}

function installShortcuts(win) {
  win.webContents.on("before-input-event", (event, input) => {
    const isControlZoom = input.control || input.meta;
    if (!isControlZoom || input.type !== "keyDown") return;

    if (input.key === "+" || input.key === "=" || input.code === "NumpadAdd") {
      event.preventDefault();
      zoomWindow(win, "in");
      return;
    }

    if (input.key === "-" || input.code === "NumpadSubtract") {
      event.preventDefault();
      zoomWindow(win, "out");
      return;
    }

    if (input.key === "0" || input.code === "Numpad0") {
      event.preventDefault();
      zoomWindow(win, "reset");
    }
  });
}

function installContextMenu(win) {
  win.webContents.on("context-menu", (_event, params) => {
    const template = [];

    if (params.isEditable) {
      template.push(
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { type: "separator" },
        { role: "selectAll" }
      );
    } else {
      template.push(
        { role: "copy", enabled: Boolean(params.selectionText) },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Zoom In", accelerator: "Ctrl+Plus", click: () => zoomWindow(win, "in") },
        { label: "Zoom Out", accelerator: "Ctrl+-", click: () => zoomWindow(win, "out") },
        { label: "Reset Zoom", accelerator: "Ctrl+0", click: () => zoomWindow(win, "reset") }
      );
    }

    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1260,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "Reddit Video Maker",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  installShortcuts(win);
  installContextMenu(win);

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  mainWindow = win;
  win.loadURL(`http://127.0.0.1:${process.env.PORT || "4141"}`);
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  ensurePortableFolders();
  await startServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

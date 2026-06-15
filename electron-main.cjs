const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, shell } = require("electron");

const isPackaged = app.isPackaged;
const dataRoot = isPackaged
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath), "reddit-video-maker-data")
  : __dirname;

process.env.RVM_DATA_DIR = dataRoot;
process.env.PORT = process.env.PORT || "4141";

function ensurePortableFolders() {
  const backgrounds = path.join(dataRoot, "backgrounds");
  const renders = path.join(dataRoot, "renders");
  fs.mkdirSync(backgrounds, { recursive: true });
  fs.mkdirSync(renders, { recursive: true });

  if (isPackaged) {
    const bundledBackgrounds = path.join(process.resourcesPath, "backgrounds");
    if (fs.existsSync(bundledBackgrounds)) {
      for (const entry of fs.readdirSync(bundledBackgrounds)) {
        const source = path.join(bundledBackgrounds, entry);
        const target = path.join(backgrounds, entry);
        if (!fs.existsSync(target) && fs.statSync(source).isFile()) {
          fs.copyFileSync(source, target);
        }
      }
    }
  }
}

async function startServer() {
  await import("./server/index.js");
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

  win.loadURL("http://127.0.0.1:4141");
}

app.whenReady().then(async () => {
  ensurePortableFolders();
  await startServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

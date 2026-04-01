import { app, BrowserWindow, shell } from "electron";

const DEFAULT_URL = "http://localhost:5173";
const APP_ID = "com.bridge.desktop";

let mainWindow: BrowserWindow | null = null;

function resolveTargetUrl(): string {
  const candidates = [process.env.BRIDGE_DESKTOP_URL, process.env.BRIDGE_WEB_URL, DEFAULT_URL];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      return new URL(candidate).toString();
    } catch {
      // try next candidate
    }
  }
  return DEFAULT_URL;
}

function createWindow(): BrowserWindow {
  const targetUrl = resolveTargetUrl();
  const targetOrigin = new URL(targetUrl).origin;

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#1a1d21",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin !== targetOrigin) {
        event.preventDefault();
        void shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });

  void window.loadURL(targetUrl);
  mainWindow = window;
  return window;
}

function focusWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

app.setName("Bridge Desktop");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  focusWindow();
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  mainWindow = null;
  if (process.platform !== "darwin") {
    app.quit();
  }
});

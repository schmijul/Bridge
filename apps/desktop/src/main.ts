import { app, BrowserWindow, Menu, Tray, nativeImage, shell, type Event } from "electron";
import {
  createAppIconDataUrl,
  createTrayIconDataUrl,
  isAllowedExternalUrl,
  resolveDesktopConfig,
  type DesktopConfig
} from "./native.js";

const APP_ID = "com.bridge.desktop";

class DesktopShellController {
  private mainWindow: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private quitting = false;

  constructor(private readonly config: DesktopConfig) {}

  start(): void {
    this.bindAppLifecycle();
    this.createTray();
    void this.showWindow({ focus: false });
  }

  private bindAppLifecycle(): void {
    app.on("second-instance", () => {
      void this.showWindow({ focus: true });
    });

    app.on("activate", () => {
      void this.showWindow({ focus: true });
    });

    app.on("before-quit", () => {
      this.quitting = true;
    });
  }

  private createTray(): void {
    if (this.tray) {
      return;
    }

    const tray = new Tray(nativeImage.createFromDataURL(createTrayIconDataUrl()));
    tray.setToolTip("Bridge Desktop");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show Bridge", click: () => void this.showWindow({ focus: true }) },
        { type: "separator" },
        { label: "Quit Bridge", click: () => this.quitApp() }
      ])
    );
    tray.on("click", () => {
      if (this.mainWindow?.isVisible()) {
        this.hideWindow();
        return;
      }
      void this.showWindow({ focus: true });
    });
    tray.on("double-click", () => void this.showWindow({ focus: true }));

    this.tray = tray;
  }

  private createWindow(): BrowserWindow {
    const targetUrl = this.config.targetUrl;
    const targetOrigin = new URL(targetUrl).origin;
    const windowIcon = nativeImage.createFromDataURL(createAppIconDataUrl());

    const window = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 1100,
      minHeight: 720,
      show: false,
      autoHideMenuBar: true,
      title: "Bridge Desktop",
      backgroundColor: "#1a1d21",
      icon: windowIcon,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    });

    window.once("ready-to-show", () => {
      if (!this.config.startHidden) {
        window.show();
        window.focus();
      }
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url, targetOrigin)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    window.webContents.on("will-navigate", (event, url) => {
      if (isAllowedExternalUrl(url, targetOrigin)) {
        event.preventDefault();
        void shell.openExternal(url);
        return;
      }

      try {
        if (new URL(url).origin !== targetOrigin) {
          event.preventDefault();
        }
      } catch {
        event.preventDefault();
      }
    });

    window.on("close", (event: Event) => {
      if (this.quitting || !this.config.closeToTray) {
        return;
      }
      event.preventDefault();
      window.hide();
    });

    window.on("closed", () => {
      if (this.mainWindow === window) {
        this.mainWindow = null;
      }
    });

    void window.loadURL(targetUrl);
    this.mainWindow = window;
    return window;
  }

  private ensureWindow(): BrowserWindow {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      return this.mainWindow;
    }
    return this.createWindow();
  }

  private async showWindow(options?: { focus?: boolean }): Promise<void> {
    const window = this.ensureWindow();
    if (window.isMinimized()) {
      window.restore();
    }
    if (!window.isVisible()) {
      window.show();
    }
    if (options?.focus !== false) {
      window.focus();
    }
  }

  private hideWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }
    this.mainWindow.hide();
  }

  private quitApp(): void {
    if (this.quitting) {
      return;
    }
    this.quitting = true;
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.destroy();
      this.mainWindow = null;
    }
    app.quit();
  }
}

const config = resolveDesktopConfig();
const controller = new DesktopShellController(config);

if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

app.setName("Bridge Desktop");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    controller.start();
  });
}

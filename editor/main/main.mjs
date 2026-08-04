import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  protocol,
  session
} from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isAllowedDevelopmentUrl,
  isTrustedRendererUrl,
  resolveRendererAsset
} from "./security.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const editorRoot = resolve(moduleDir, "..");
const rendererRoot = resolve(editorRoot, "dist");
const preloadPath = resolve(editorRoot, "preload", "preload.cjs");
const applicationOrigin = "whl-editor://app";
const developmentUrl = process.env.WHL_EDITOR_DEV_SERVER_URL || "";
const editorPartition = "whl-editor";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "whl-editor",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false
    }
  }
]);

app.enableSandbox();

function assertTrustedSender(event) {
  if (!isTrustedRendererUrl(event.senderFrame?.url || "", developmentUrl)) {
    throw new Error("Rejected IPC from an untrusted renderer.");
  }
}

function registerApplicationProtocol() {
  protocol.handle("whl-editor", (request) => {
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.host !== "app") return new Response("Not found", { status: 404 });
      const candidate = resolveRendererAsset(rendererRoot, requestUrl.pathname);
      if (!candidate) {
        return new Response("Not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(candidate).toString());
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  });
}

function registerIpc() {
  ipcMain.handle("whl-editor:get-app-info", (event) => {
    assertTrustedSender(event);
    return Object.freeze({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged
    });
  });
}

function hardenSession() {
  const editorSession = session.fromPartition(editorPartition);
  editorSession.setPermissionCheckHandler(() => false);
  editorSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  editorSession.on("will-download", (event) => event.preventDefault());
  return editorSession;
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: "#1f252b",
    title: "World Herb Editor",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      devTools: !app.isPackaged,
      partition: editorPartition,
      spellcheck: false
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl, developmentUrl)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl, developmentUrl)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());

  if (isAllowedDevelopmentUrl(developmentUrl)) {
    void window.loadURL(developmentUrl);
  } else {
    void window.loadURL(`${applicationOrigin}/index.html`);
  }

  return window;
}

app.whenReady().then(() => {
  registerApplicationProtocol();
  hardenSession();
  registerIpc();
  Menu.setApplicationMenu(null);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

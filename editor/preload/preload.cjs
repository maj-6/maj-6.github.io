"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const desktopApi = Object.freeze(Object.create(null, {
  getAppInfo: {
    enumerable: true,
    value: async () => {
      const value = await ipcRenderer.invoke("whl-editor:get-app-info");
      if (!value || typeof value !== "object") throw new Error("Invalid application metadata response.");
      return Object.freeze({
        name: String(value.name || "World Herb Editor"),
        version: String(value.version || "0.0.0"),
        platform: String(value.platform || "unknown"),
        packaged: value.packaged === true
      });
    }
  }
}));

contextBridge.exposeInMainWorld("whlDesktop", desktopApi);

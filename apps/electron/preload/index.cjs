const { contextBridge, ipcRenderer } = require("electron");

const DEVICE_CHANNEL_PREFIX = "cookietodo:device:";
const STORE_CHANNEL_PREFIX = "cookietodo:store:";
const SETTINGS_CHANNEL_PREFIX = "cookietodo:settings:";

const deviceAdapter = {
  getLocale: () => ipcRenderer.invoke(`${DEVICE_CHANNEL_PREFIX}getLocale`),
  saveLocale: (locale) => ipcRenderer.invoke(`${DEVICE_CHANNEL_PREFIX}saveLocale`, locale),
  getDismissPassword: () => ipcRenderer.invoke(`${DEVICE_CHANNEL_PREFIX}getDismissPassword`),
  saveDismissPassword: (password) =>
    ipcRenderer.invoke(`${DEVICE_CHANNEL_PREFIX}saveDismissPassword`, password),
  getAlarmSoundId: () => ipcRenderer.invoke(`${DEVICE_CHANNEL_PREFIX}getAlarmSoundId`),
  saveAlarmSoundId: (id) => ipcRenderer.invoke(`${DEVICE_CHANNEL_PREFIX}saveAlarmSoundId`, id),
  getWebDAVCredentials: (url) =>
    ipcRenderer.invoke(`${DEVICE_CHANNEL_PREFIX}getWebDAVCredentials`, url),
  saveWebDAVCredentials: (url, credentials) =>
    ipcRenderer.invoke(`${DEVICE_CHANNEL_PREFIX}saveWebDAVCredentials`, url, credentials),
};

const storeAdapter = {
  loadSnapshot: () => ipcRenderer.invoke(`${STORE_CHANNEL_PREFIX}loadSnapshot`),
  saveSnapshot: (snapshot) => ipcRenderer.invoke(`${STORE_CHANNEL_PREFIX}saveSnapshot`, snapshot),
};

const settingsAdapter = {
  exportSnapshot: (snapshot) =>
    ipcRenderer.invoke(`${SETTINGS_CHANNEL_PREFIX}exportSnapshot`, snapshot),
  importSnapshot: () => ipcRenderer.invoke(`${SETTINGS_CHANNEL_PREFIX}importSnapshot`),
};

contextBridge.exposeInMainWorld("cookietodoDeviceAdapter", () => deviceAdapter);
contextBridge.exposeInMainWorld("cookietodoStoreAdapter", () => storeAdapter);
contextBridge.exposeInMainWorld("cookietodoSettingsAdapter", () => settingsAdapter);

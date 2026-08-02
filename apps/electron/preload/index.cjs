const { contextBridge, ipcRenderer } = require("electron");

const DEVICE_CHANNEL_PREFIX = "cookietodo:device:";
const STORE_CHANNEL_PREFIX = "cookietodo:store:";
const SETTINGS_CHANNEL_PREFIX = "cookietodo:settings:";
const ALARM_CHANNEL_PREFIX = "cookietodo:alarm:";

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

// Slice-5 AlarmAdapter proxy — same shape as the TS preload (index.ts), kept
// in lockstep. onAlarmFired wraps an ipcRenderer.on listener and returns an
// unsubscribe.
const alarmAdapter = {
  scheduleAlarm: (reminder, todo) =>
    ipcRenderer.invoke(`${ALARM_CHANNEL_PREFIX}scheduleAlarm`, reminder, todo),
  cancelAlarm: (reminderId) =>
    ipcRenderer.invoke(`${ALARM_CHANNEL_PREFIX}cancelAlarm`, reminderId),
  onAlarmFired: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("cookietodo:alarm:fired", listener);
    return () => {
      ipcRenderer.removeListener("cookietodo:alarm:fired", listener);
    };
  },
  requestPermission: (kind) =>
    ipcRenderer.invoke(`${ALARM_CHANNEL_PREFIX}requestPermission`, kind),
};

contextBridge.exposeInMainWorld("cookietodoDeviceAdapter", () => deviceAdapter);
contextBridge.exposeInMainWorld("cookietodoStoreAdapter", () => storeAdapter);
contextBridge.exposeInMainWorld("cookietodoSettingsAdapter", () => settingsAdapter);
contextBridge.exposeInMainWorld("cookietodoAlarmAdapter", () => alarmAdapter);

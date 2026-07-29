/** Public surface of the @cookietodo/renderer workspace package. */

// Device adapter
export type {
  AlarmSoundId,
  DeviceAdapter,
  Locale,
  WebDAVCredentials,
} from "./device/DeviceAdapter";
export { electronRendererStub } from "./device/electronRendererStub";
// i18n
export { default as i18n, pickInitialLocale } from "./i18n";

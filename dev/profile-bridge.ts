/**
 * Profile bridge（个人中心 · Cookie/BUC 会话与判活）— public entry, mirroring
 * report-bridge.ts / agents-bridge.ts: implementation lives in ./profile/ and
 * this file re-exports the public surface so the router and tests can import
 * from dev/profile-bridge.ts.
 */
export {
  CHROME_UNSUPPORTED_REASON,
  createProfileBridge,
  PROFILE_ROUTES,
  type ProfileBridge,
  type ProfileBridgeOptions,
  type ProfileRoute,
} from "./profile/profile-bridge.ts";
export { ProfileBridgeError, PROFILE_ERROR_STATUS } from "./profile/profile-types.ts";
export type {
  ProfileDoc,
  ProfileErrorCode,
  ProfileLastCheck,
  ProfilePrefs,
  ProfilePrefsResult,
  ProfilePublicView,
  ProfileSessionPutResult,
  ProfileSessionRecord,
  ProfileSessionView,
  ProfileTestResult,
  SessionSource,
} from "./profile/profile-types.ts";
export {
  createProfileStore,
  DOMAIN_ALLOWLIST,
  EMP_RE,
  maskCookie,
  MAX_SESSION_COOKIE,
  countCookiePairs,
  normalizeDomains,
  publicView,
  sanitizePrefs,
  SESSION_SOURCES,
  validEmp,
  type ProfileStore,
  type ProfileStoreOptions,
} from "./profile/profile-store.ts";
export {
  createDefaultWhoamiRunner,
  defaultWhoamiPath,
  parseWhoamiStdout,
  WHOAMI_TIMEOUT_MS,
  type WhoamiOutcome,
  type WhoamiRunOptions,
  type WhoamiRunner,
} from "./profile/profile-whoami.ts";

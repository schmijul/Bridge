import Constants from "expo-constants";

type MobileExtra = {
  apiUrl?: string;
  wsUrl?: string;
  appName?: string;
};

export type MobileConfig = {
  apiUrl: string;
  wsUrl: string;
  appName: string;
};

function normalizeUrl(value: string, fallback: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

export function getMobileConfig(): MobileConfig {
  const extra = (Constants.expoConfig?.extra ?? {}) as MobileExtra;
  return {
    apiUrl: normalizeUrl(extra.apiUrl ?? "http://localhost:4000", "http://localhost:4000"),
    wsUrl: normalizeUrl(extra.wsUrl ?? "ws://localhost:4000", "ws://localhost:4000"),
    appName: extra.appName ?? "Bridge Mobile"
  };
}

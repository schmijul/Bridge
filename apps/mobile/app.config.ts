import type { ExpoConfig } from "expo/config";

type ExtraConfig = {
  apiUrl: string;
  wsUrl: string;
  appName: string;
};

function readEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

export default (): ExpoConfig => {
  const extra: ExtraConfig = {
    apiUrl: readEnv("API_URL", "http://localhost:4000"),
    wsUrl: readEnv("WS_URL", "ws://localhost:4000"),
    appName: "Bridge Mobile"
  };

  return {
    name: extra.appName,
    slug: "bridge-mobile",
    version: "0.1.0",
    orientation: "portrait",
    scheme: "bridge-mobile",
    platforms: ["ios", "android"],
    extra
  };
};

export const DEFAULT_DESKTOP_URL = "http://localhost:5173";

export type DesktopConfig = {
  targetUrl: string;
  closeToTray: boolean;
  startHidden: boolean;
};

export function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim().length === 0) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

export function parseIntegerEnv(
  value: string | undefined,
  defaultValue: number,
  options?: { min?: number; max?: number }
): number {
  if (value == null || value.trim().length === 0) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  if (options?.min != null && parsed < options.min) {
    return options.min;
  }
  if (options?.max != null && parsed > options.max) {
    return options.max;
  }
  return parsed;
}

function resolveUrlCandidate(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }

  try {
    return new URL(value).toString();
  } catch {
    return fallback;
  }
}

export function resolveDesktopConfig(env: NodeJS.ProcessEnv = process.env): DesktopConfig {
  return {
    targetUrl: resolveUrlCandidate(env.BRIDGE_DESKTOP_URL ?? env.BRIDGE_WEB_URL, DEFAULT_DESKTOP_URL),
    closeToTray: parseBooleanEnv(env.BRIDGE_DESKTOP_CLOSE_TO_TRAY, true),
    startHidden: parseBooleanEnv(env.BRIDGE_DESKTOP_START_HIDDEN, false)
  };
}

function buildIconSvg(fillColor: string, accentColor: string, text: string): string {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="${fillColor}" />
          <stop offset="100%" stop-color="${accentColor}" />
        </linearGradient>
      </defs>
      <rect x="48" y="48" width="416" height="416" rx="104" fill="url(#bg)" />
      <rect x="120" y="132" width="272" height="216" rx="48" fill="rgba(255,255,255,0.14)" />
      <path d="M184 204h144v28H184zm0 72h96v28h-96z" fill="#ffffff" opacity="0.92" />
      <circle cx="360" cy="356" r="52" fill="#ffffff" opacity="0.16" />
      <text x="256" y="318" text-anchor="middle" font-size="164" font-family="Arial, Helvetica, sans-serif" font-weight="700" fill="#ffffff">${text}</text>
    </svg>
  `;
}

export function createAppIconDataUrl(): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    buildIconSvg("#2d6cdf", "#1a1d21", "B")
  )}`;
}

export function createTrayIconDataUrl(): string {
  return createAppIconDataUrl();
}

export function isAllowedExternalUrl(url: string, targetOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.origin !== targetOrigin;
  } catch {
    return false;
  }
}

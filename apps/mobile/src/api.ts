import type { Attachment, Channel, Message, User, Workspace } from "@bridge/shared";

import type { MobileConfig } from "./config";

export type MobileBootstrapPayload = {
  users: User[];
  channels: Channel[];
  messages: Message[];
  onlineUserIds: string[];
  workspace: Workspace;
  cursor: {
    sequence: number;
  };
};

export type MobileLoginResponse = {
  user: User;
};

export type MobileMeResponse = {
  user: User;
};

export type MobileAttachment = Attachment;

export class MobileApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "MobileApiError";
    this.status = status;
  }
}

type FetchInit = Omit<RequestInit, "body"> & {
  body?: BodyInit | Record<string, unknown>;
};

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function readErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return fallback;
}

async function requestJson<T>(baseUrl: string, path: string, init: FetchInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  const response = await fetch(`${withTrailingSlash(baseUrl)}${path.replace(/^\//, "")}`, {
    ...init,
    body:
      init.body && typeof init.body === "object" && !(init.body instanceof FormData)
        ? JSON.stringify(init.body)
        : init.body,
    credentials: "include",
    headers
  });

  const rawText = await response.text();
  let parsedBody: unknown;
  if (rawText.trim().length > 0) {
    try {
      parsedBody = JSON.parse(rawText) as unknown;
    } catch {
      parsedBody = rawText;
    }
  }

  if (!response.ok) {
    throw new MobileApiError(
      readErrorMessage(parsedBody, `request failed with status ${response.status}`),
      response.status
    );
  }

  return parsedBody as T;
}

export async function login(
  config: Pick<MobileConfig, "apiUrl">,
  email: string,
  password: string
): Promise<MobileLoginResponse> {
  return requestJson<MobileLoginResponse>(config.apiUrl, "/auth/login", {
    method: "POST",
    body: {
      email,
      password
    }
  });
}

export async function fetchBootstrap(config: Pick<MobileConfig, "apiUrl">): Promise<MobileBootstrapPayload> {
  return requestJson<MobileBootstrapPayload>(config.apiUrl, "/bootstrap", {
    method: "GET"
  });
}

export async function fetchCurrentUser(config: Pick<MobileConfig, "apiUrl">): Promise<MobileMeResponse> {
  return requestJson<MobileMeResponse>(config.apiUrl, "/auth/me", {
    method: "GET"
  });
}

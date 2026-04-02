import assert from "node:assert/strict";
import test from "node:test";
import {
  createAppIconDataUrl,
  createTrayIconDataUrl,
  isAllowedExternalUrl,
  parseBooleanEnv,
  parseIntegerEnv,
  resolveDesktopConfig
} from "./native.js";

test("boolean env parsing accepts common truthy and falsy values", () => {
  assert.equal(parseBooleanEnv(undefined, true), true);
  assert.equal(parseBooleanEnv("true", false), true);
  assert.equal(parseBooleanEnv("1", false), true);
  assert.equal(parseBooleanEnv("yes", false), true);
  assert.equal(parseBooleanEnv("off", true), false);
  assert.equal(parseBooleanEnv("0", true), false);
});

test("integer env parsing falls back and clamps to bounds", () => {
  assert.equal(parseIntegerEnv(undefined, 30), 30);
  assert.equal(parseIntegerEnv("not-a-number", 30), 30);
  assert.equal(parseIntegerEnv("2000", 30, { min: 5000, max: 300000 }), 5000);
  assert.equal(parseIntegerEnv("999999", 30, { min: 5000, max: 300000 }), 300000);
  assert.equal(parseIntegerEnv("45000", 30, { min: 5000, max: 300000 }), 45000);
});

test("desktop config resolves env overrides", () => {
  const config = resolveDesktopConfig({
    BRIDGE_DESKTOP_URL: "http://desktop.local",
    BRIDGE_DESKTOP_CLOSE_TO_TRAY: "false",
    BRIDGE_DESKTOP_START_HIDDEN: "true"
  });

  assert.equal(config.targetUrl, "http://desktop.local/");
  assert.equal(config.closeToTray, false);
  assert.equal(config.startHidden, true);
});

test("desktop helpers produce secure icon data urls and external navigation guard", () => {
  assert.match(createAppIconDataUrl(), /^data:image\/svg\+xml;charset=utf-8,/);
  assert.equal(createAppIconDataUrl(), createTrayIconDataUrl());
  assert.equal(isAllowedExternalUrl("https://example.com", "http://localhost:5173"), true);
  assert.equal(isAllowedExternalUrl("http://localhost:5173", "http://localhost:5173"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)", "http://localhost:5173"), false);
});

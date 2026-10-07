import { Platform } from "react-native";
import { readAppStorage } from "./web";

// Paseo's own appearance settings, so the diff matches its native one. The plugin API does
// not expose them; on web and desktop the app keeps them in localStorage under this key.
// Elsewhere, or if the format changes, the app's defaults apply.
const APP_SETTINGS_KEY = "@paseo:app-settings";
const phone = Platform.OS !== "web";
const DEFAULTS = {
  codeFontSize: 12,
  monoFontFamily: "",
  syntaxTheme: "one",
  // Paseo's text defaults are a step larger on phones.
  contentFontSize: phone ? 16 : 15,
  uiBaseFontSize: phone ? 15 : 14,
};

function readStored(): Partial<Record<keyof typeof DEFAULTS, unknown>> {
  try {
    return JSON.parse(readAppStorage(APP_SETTINGS_KEY) ?? "{}") ?? {};
  } catch {
    // Unreadable settings: keep the defaults.
    return {};
  }
}

function clampedSize(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, typeof value === "number" ? value : fallback));
}

export interface CodeAppearance {
  fontSize: number;
  // Empty for the platform's default monospace stack.
  fontFamily: string;
  syntaxTheme: string;
}

export function readCodeAppearance(): CodeAppearance {
  const stored = readStored();
  return {
    // Paseo clamps to 9-22.
    fontSize: clampedSize(stored.codeFontSize, DEFAULTS.codeFontSize, 9, 22),
    fontFamily: typeof stored.monoFontFamily === "string" ? stored.monoFontFamily.trim() : "",
    syntaxTheme: typeof stored.syntaxTheme === "string" ? stored.syntaxTheme : DEFAULTS.syntaxTheme,
  };
}

export interface TextSizes {
  /** Prose such as messages and review comments: Paseo's Content size. */
  content: number;
  /** Regular UI text: Paseo's UI size. */
  base: number;
  /** Small UI text such as button labels: Paseo's 12px step, scaled by its UI size. */
  small: number;
}

export function readTextSizes(): TextSizes {
  const stored = readStored();
  // Paseo clamps both to 10-21.
  const uiBase = clampedSize(stored.uiBaseFontSize, DEFAULTS.uiBaseFontSize, 10, 21);
  return {
    content: clampedSize(stored.contentFontSize, DEFAULTS.contentFontSize, 10, 21),
    base: uiBase,
    small: Math.round((12 * uiBase) / 14),
  };
}

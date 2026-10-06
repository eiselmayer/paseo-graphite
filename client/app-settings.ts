// Paseo's own appearance settings, so the diff matches its native one. The plugin API does
// not expose them; on web and desktop the app keeps them in localStorage under this key.
// Elsewhere, or if the format changes, the app's defaults apply.
const APP_SETTINGS_KEY = "@paseo:app-settings";
const DEFAULTS = { codeFontSize: 12, monoFontFamily: "", syntaxTheme: "one" };

declare const globalThis: { localStorage?: { getItem(key: string): string | null } };

export interface CodeAppearance {
  fontSize: number;
  // Empty for the platform's default monospace stack.
  fontFamily: string;
  syntaxTheme: string;
}

export function readCodeAppearance(): CodeAppearance {
  let stored: Partial<typeof DEFAULTS> = {};
  try {
    stored = JSON.parse(globalThis.localStorage?.getItem(APP_SETTINGS_KEY) ?? "{}") ?? {};
  } catch {
    // Unreadable settings: keep the defaults.
  }
  const size = typeof stored.codeFontSize === "number" ? stored.codeFontSize : DEFAULTS.codeFontSize;
  return {
    // Paseo clamps to 9-22.
    fontSize: Math.min(22, Math.max(9, size)),
    fontFamily: typeof stored.monoFontFamily === "string" ? stored.monoFontFamily.trim() : "",
    syntaxTheme: typeof stored.syntaxTheme === "string" ? stored.syntaxTheme : DEFAULTS.syntaxTheme,
  };
}

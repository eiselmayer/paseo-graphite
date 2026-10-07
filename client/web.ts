import { Linking, Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const window: {
  paseoDesktop?: {
    opener?: {
      openUrl?: (url: string) => Promise<void>;
    };
  };
  open(url: string, target: string, features: string): unknown;
};
declare const document: {
  body: { appendChild(node: DragImage): void };
  createElement(tag: "div"): DragImage;
};
declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };

interface DragImage {
  textContent: string | null;
  style: Record<string, string>;
  remove(): void;
}

// A React Native view on web is its DOM element.
interface ViewElement {
  draggable: boolean;
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
  getBoundingClientRect(): { top: number };
  contains(other: unknown): boolean;
  setPointerCapture(pointerId: number): void;
}

interface PointerEvent {
  pointerId: number;
  button: number;
  clientY: number;
  shiftKey: boolean;
  target: unknown;
  preventDefault(): void;
}

interface DragEvent {
  dataTransfer: {
    effectAllowed: string;
    dropEffect: string;
    setData(format: string, data: string): void;
    setDragImage(image: DragImage, x: number, y: number): void;
  } | null;
}

export async function openExternal(url: string): Promise<void> {
  if (Platform.OS === "web") {
    const openWithSystemBrowser = window.paseoDesktop?.opener?.openUrl;
    if (openWithSystemBrowser) {
      await openWithSystemBrowser(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await Linking.openURL(url);
}

/** A value the Paseo app keeps in localStorage. Phones keep theirs elsewhere and get null. */
export function readAppStorage(key: string): string | null {
  if (Platform.OS !== "web") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Saves a value in localStorage on web and desktop; elsewhere, or if it is full, it stays in memory. */
export function writeAppStorage(key: string, value: string): void {
  if (Platform.OS !== "web") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Full or blocked: the caller still has the value in memory.
  }
}

// React Native's types reject these styles; they only mean something on web.
const webStyle = (style: Record<string, string | number>) => (Platform.OS === "web" ? style : {}) as object;
export const pickableStyle = webStyle({ cursor: "pointer", userSelect: "none" });
export const grabbableStyle = webStyle({ cursor: "grab" });
export const plainInputStyle = webStyle({ outlineWidth: 0, outlineColor: "transparent" });
export const selectableRowStyle = webStyle({ userSelect: "text" });
// Paseo's message text on web: a fixed line height, and long words break anywhere.
export const messageTextStyle = (fontSize: number) =>
  webStyle({ lineHeight: Math.round(fontSize * 1.4), overflowWrap: "anywhere" });

export interface LinePicking {
  /** Row at a vertical offset from the top of the rows; null over the comment box. */
  rowAt(offsetY: number): number | null;
  hover(row: number | null): void;
  press(row: number, extend: boolean): void;
  drag(row: number): void;
  release(): void;
}

/**
 * Press and drag across line numbers to pick lines; shift-click extends the pick. Pointer capture
 * keeps a drag going past the rows' edges. Web only: on phones a tap picks one line.
 */
export function bindLinePicking(
  rows: unknown,
  gutter: { readonly current: unknown },
  picking: { readonly current: LinePicking },
): () => void {
  if (Platform.OS !== "web" || !rows) return () => {};
  const element = rows as ViewElement;
  let pointer: number | null = null;
  const rowAt = (event: PointerEvent) => picking.current.rowAt(event.clientY - element.getBoundingClientRect().top);
  const down = (event: PointerEvent) => {
    const row = rowAt(event);
    if (event.button !== 0 || row === null || !(gutter.current as ViewElement | null)?.contains(event.target)) return;
    event.preventDefault();
    pointer = event.pointerId;
    element.setPointerCapture(event.pointerId);
    picking.current.press(row, event.shiftKey);
  };
  const move = (event: PointerEvent) => {
    const row = rowAt(event);
    if (pointer !== event.pointerId) picking.current.hover(row);
    else if (row !== null) picking.current.drag(row);
  };
  const up = (event: PointerEvent) => {
    if (pointer !== event.pointerId) return;
    pointer = null;
    picking.current.release();
  };
  const leave = () => {
    if (pointer === null) picking.current.hover(null);
  };
  const listeners: [string, (event: never) => void][] = [
    ["pointerdown", down],
    ["pointermove", move],
    ["pointerup", up],
    ["pointercancel", up],
    ["pointerleave", leave],
  ];
  for (const [type, listener] of listeners) element.addEventListener(type, listener);
  return () => {
    for (const [type, listener] of listeners) element.removeEventListener(type, listener);
  };
}

export interface LineDrag {
  mime: string;
  payload: string;
  text: string;
  label: string;
  colors: { background: string; foreground: string; border: string };
}

/**
 * Makes the picked lines draggable onto an agent's composer, which takes them like a file dragged
 * from Paseo's file tree. `onDropped` runs when something accepted the drop.
 */
export function bindLineDrag(
  node: unknown,
  drag: { readonly current: LineDrag | null },
  onDropped: () => void,
): () => void {
  if (Platform.OS !== "web" || !node) return () => {};
  const element = node as ViewElement;
  element.draggable = true;
  const start = (event: DragEvent) => {
    const current = drag.current;
    if (!current || !event.dataTransfer) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(current.mime, current.payload);
    event.dataTransfer.setData("text/plain", current.text);
    // The browser would picture the transparent drag handle; show what is being dragged instead.
    const image = document.createElement("div");
    image.textContent = current.label;
    Object.assign(image.style, {
      position: "fixed",
      top: "-1000px",
      left: "0px",
      padding: "4px 10px",
      borderRadius: "8px",
      font: "12px system-ui, -apple-system, sans-serif",
      whiteSpace: "nowrap",
      background: current.colors.background,
      color: current.colors.foreground,
      border: `1px solid ${current.colors.border}`,
    });
    document.body.appendChild(image);
    event.dataTransfer.setDragImage(image, 12, 12);
    setTimeout(() => image.remove(), 0);
  };
  const end = (event: DragEvent) => {
    if (event.dataTransfer && event.dataTransfer.dropEffect !== "none") onDropped();
  };
  element.addEventListener("dragstart", start);
  element.addEventListener("dragend", end);
  return () => {
    element.draggable = false;
    element.removeEventListener("dragstart", start);
    element.removeEventListener("dragend", end);
  };
}

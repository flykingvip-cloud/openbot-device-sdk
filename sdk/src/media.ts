/** Six digital-human categories from `LVAdapterDisplay::kEmoteCategoryMap`. */
export const EMOTION_CATEGORIES = ["crying", "happy", "loving", "neutral", "surprised", "thinking"] as const;

export type EmotionCategory = (typeof EMOTION_CATEGORIES)[number];

/**
 * Copied from `kEmoteCategoryMap` in `main/display/lv_adapter_display.cc`
 * at firmware `ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950`.
 * Names absent from this table fall back to `neutral`.
 */
export const EMOTE_CATEGORY_MAP: Readonly<Record<string, EmotionCategory>> = {
  happy: "happy",
  laughing: "happy",
  funny: "happy",
  silly: "happy",
  winking: "happy",
  cool: "happy",
  confident: "happy",
  loving: "loving",
  kissy: "loving",
  delicious: "loving",
  sad: "crying",
  crying: "crying",
  angry: "crying",
  surprised: "surprised",
  shocked: "surprised",
  embarrassed: "surprised",
  thinking: "thinking",
  confused: "thinking",
  neutral: "neutral",
  relaxed: "neutral",
  sleepy: "neutral",
};

export const CHAT_EMOTION_NAMES = [
  "angry",
  "confident",
  "confused",
  "cool",
  "crying",
  "delicious",
  "embarrassed",
  "funny",
  "happy",
  "kissy",
  "laughing",
  "loving",
  "neutral",
  "relaxed",
  "sad",
  "shocked",
  "silly",
  "sleepy",
  "surprised",
  "thinking",
  "winking",
] as const;

export const CHAT_EMOTION_NAME_MAX = 39;

export const DIGITAL_HUMAN_EMOTION_EXTENSIONS = [".eaf", ".sjpg"] as const;

export type DigitalHumanEmotionExtension = (typeof DIGITAL_HUMAN_EMOTION_EXTENSIONS)[number];

export function emotionCategory(name: string | null | undefined): EmotionCategory {
  if (name == null || name.length === 0) {
    return "neutral";
  }
  return EMOTE_CATEGORY_MAP[name] ?? "neutral";
}

/** Chat filenames allow `[A-Za-z0-9_-]` and at most 39 characters (`kEmotionNameMax`). */
export function chatEmotionName(name: string | null | undefined): string {
  if (name == null || name.length === 0 || name.length > CHAT_EMOTION_NAME_MAX) {
    return "neutral";
  }
  if (![...name].every((char) => /[A-Za-z0-9_-]/.test(char))) {
    return "neutral";
  }
  return name;
}

export function digitalHumanEmotionPath(category: EmotionCategory, extension: DigitalHumanEmotionExtension): string {
  return `system/emotion/${category}${extension}`;
}

export function chatEmotionPath(name: string | null | undefined): string {
  return `system/chat/${chatEmotionName(name)}.eaf`;
}

/**
 * Panel facts from the firmware baseline.
 * `InitializeNV3051FLCD` uses RGB888, 24 bpp, 3 framebuffers, 720×720.
 * The RGB565 byte count is arithmetic only. The comment in `lv_adapter_display.cc`
 * that says 3×720×720×2 is stale.
 */
export const DISPLAY = {
  inches: 3.95,
  width: 720,
  height: 720,
  runtimePixelFormat: "RGB888",
  bitsPerPixel: 24,
  framebuffers: 3,
  rgb565PixelBytes: 720 * 720 * 2,
  rgb888PixelBytes: 720 * 720 * 3,
} as const;

/**
 * Camera path described by the firmware baseline. Resolution is whatever the
 * driver reports; these are the values the board code prefers, not a lab measurement.
 */
export const CAMERA = {
  sensor: "OV2710",
  bus: "MIPI-CSI",
  xclkHz: 24_000_000,
  sccbAddress: 0x36,
  advertised: { width: 1920, height: 1080, fps: 25 },
  preferredPixelFormat: "V4L2_PIX_FMT_RGB565",
  previewCrop: { width: 720, height: 600, rotationDeg: 180, drawFormat: "RGB888" },
  jpeg: { quality: 55, width: 360, height: 300, directory: "/sdcard" },
  v4l2Buffers: 2,
} as const;

export interface MediaCapabilities {
  display: typeof DISPLAY;
  camera: typeof CAMERA;
  digitalHumanEmotions: readonly EmotionCategory[];
  chatEmotions: readonly string[];
  capture: "describe-only";
}

export function mediaCapabilities(): MediaCapabilities {
  return {
    display: DISPLAY,
    camera: CAMERA,
    digitalHumanEmotions: EMOTION_CATEGORIES,
    chatEmotions: CHAT_EMOTION_NAMES,
    capture: "describe-only",
  };
}

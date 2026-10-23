import {
  DECODE_QUEUE_BUDGET_MS,
  MAX_DECODE_PACKETS_IN_QUEUE,
  OPUS_FRAME_DURATION_MS,
} from "./constants.ts";
import { buildAbortMessage, type AbortReason } from "./voice-wire.ts";

export type MetalioDialogState = "idle" | "listening" | "speaking";

export type EnqueueResult = "queued" | "dropped" | "blocked";

/**
 * Decode-queue behavior on `AbortSpeaking`.
 *
 * - `metalio-faithful`: firmware baseline — abort does **not** call ResetDecoder;
 *   residual can remain up to `DECODE_QUEUE_BUDGET_MS` (2400). Use for placeholder /
 *   mock TTS only; do **not** treat 2400 ms as the final eng gate for real TTS.
 * - `clear-on-abort`: approved product deviation for a real `TtsProvider` —
 *   AbortSpeaking clears the decode queue (lab model of firmware `ResetDecoder`).
 */
export type AbortDecodePolicy = "metalio-faithful" | "clear-on-abort";

export interface MetalioAbortResidualOptions {
  /** Default `metalio-faithful` (placeholder / firmware-faithful residual). */
  abortDecodePolicy?: AbortDecodePolicy;
}

/**
 * Playback model of the firmware baseline, plus the approved clear-on-abort path.
 *
 * Metalio-faithful: `AbortSpeaking` sets `aborted_` and sends the abort JSON. It
 * does not call `ResetDecoder`. While state stays `Speaking`, late packets still
 * enter the decode queue, whose cap is 2400 ms (40 × 60 ms). `ResetDecoder` runs
 * only when the device transitions into `Speaking`. A later `tts.start` that finds
 * the device already speaking clears `aborted_` and leaves the queue in place.
 *
 * Clear-on-abort (real TTS): `AbortSpeaking` also clears the decode queue
 * (`resetDecoder`) and rejects further enqueues while `aborted`, so residual is 0.
 */
export class MetalioAbortResidual {
  state: MetalioDialogState = "idle";
  aborted = false;
  readonly abortDecodePolicy: AbortDecodePolicy;
  private readonly queue: Uint8Array[] = [];

  constructor(options: MetalioAbortResidualOptions | AbortDecodePolicy = {}) {
    if (typeof options === "string") {
      this.abortDecodePolicy = options;
    } else {
      this.abortDecodePolicy = options.abortDecodePolicy ?? "metalio-faithful";
    }
  }

  residualMs(): number {
    return this.queue.length * OPUS_FRAME_DURATION_MS;
  }

  get depth(): number {
    return this.queue.length;
  }

  enqueueDownlink(payload: Uint8Array): EnqueueResult {
    if (this.state !== "speaking") {
      return "dropped";
    }
    if (this.abortDecodePolicy === "clear-on-abort" && this.aborted) {
      return "dropped";
    }
    if (this.queue.length >= MAX_DECODE_PACKETS_IN_QUEUE) {
      return "blocked";
    }
    this.queue.push(Uint8Array.from(payload));
    return "queued";
  }

  /**
   * Lab / contract model of firmware `ResetDecoder`: empties the decode queue.
   * Metalio baseline calls this on enter-Speaking; clear-on-abort also calls it
   * from `abortSpeaking`.
   */
  resetDecoder(): void {
    this.queue.length = 0;
  }

  /**
   * `Application::AbortSpeaking`.
   * metalio-faithful: state and queue stay as they are.
   * clear-on-abort: also `resetDecoder()` (product deviation for real TTS).
   */
  abortSpeaking(sessionId: string, reason?: AbortReason): string {
    this.aborted = true;
    if (this.abortDecodePolicy === "clear-on-abort") {
      this.resetDecoder();
    }
    return buildAbortMessage(sessionId, reason);
  }

  /**
   * `type=tts,state=start`. Clears `aborted_`.
   * Enters Speaking (and therefore resets the decoder) only from Idle or Listening.
   */
  ttsStart(): void {
    this.aborted = false;
    if (this.state === "idle" || this.state === "listening") {
      this.enterSpeaking();
    }
  }

  /** `type=tts,state=stop`. Manual mode returns to Idle; otherwise Listening. */
  ttsStop(manual: boolean): void {
    if (this.state !== "speaking") {
      return;
    }
    this.state = manual ? "idle" : "listening";
  }

  private enterSpeaking(): void {
    if (this.state === "speaking") {
      return;
    }
    this.state = "speaking";
    this.resetDecoder();
  }
}

/** Cap for metalio-faithful / placeholder residual (not the real-TTS eng gate). */
export const ABORT_RESIDUAL_MS = DECODE_QUEUE_BUDGET_MS;

export { MAX_DECODE_PACKETS_IN_QUEUE, OPUS_FRAME_DURATION_MS };

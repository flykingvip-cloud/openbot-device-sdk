import {
  DECODE_QUEUE_BUDGET_MS,
  MAX_DECODE_PACKETS_IN_QUEUE,
  OPUS_FRAME_DURATION_MS,
} from "./constants.ts";
import { buildAbortMessage, type AbortReason } from "./voice-wire.ts";

export type MetalioDialogState = "idle" | "listening" | "speaking";

export type EnqueueResult = "queued" | "dropped" | "blocked";

/**
 * Playback model of the firmware baseline.
 *
 * `AbortSpeaking` sets `aborted_` and sends the abort JSON. It does not call
 * `ResetDecoder`. While state stays `Speaking`, late packets still enter the
 * decode queue, whose cap is 2400 ms (40 × 60 ms). `ResetDecoder` runs only
 * when the device transitions into `Speaking`. A later `tts.start` that finds
 * the device already speaking clears `aborted_` and leaves the queue in place.
 */
export class MetalioAbortResidual {
  state: MetalioDialogState = "idle";
  aborted = false;
  private readonly queue: Uint8Array[] = [];

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
    if (this.queue.length >= MAX_DECODE_PACKETS_IN_QUEUE) {
      return "blocked";
    }
    this.queue.push(Uint8Array.from(payload));
    return "queued";
  }

  /** `Application::AbortSpeaking`. State and queue stay as they are. */
  abortSpeaking(sessionId: string, reason?: AbortReason): string {
    this.aborted = true;
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
    this.queue.length = 0;
  }
}

export const ABORT_RESIDUAL_MS = DECODE_QUEUE_BUDGET_MS;

export { MAX_DECODE_PACKETS_IN_QUEUE, OPUS_FRAME_DURATION_MS };

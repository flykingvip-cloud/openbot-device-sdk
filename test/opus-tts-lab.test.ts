import assert from "node:assert/strict";
import test from "node:test";

import {
  OPUS_PLACEHOLDER_MAGIC,
  buildClientHello,
  buildWebsocketHeaders,
  isOpusPlaceholderPayload,
  looksLikeRawOpusPacket,
  parseServerHello,
} from "../adapters/metalio/src/index.ts";
import { createOpusFrameTtsProvider } from "../adapters/voice/src/index.ts";
import { ControlPlane } from "../services/src/index.ts";
import { startLabVoiceServer } from "../services/src/lab-voice.ts";
import { connectLabVoice, type WsFrame } from "../services/src/voice-ws.ts";

test("lab voice real Opus TtsProvider downlink is non-placeholder at 24 kHz hello", async () => {
  let refs = 0;
  let tokens = 0;
  const control = new ControlPlane({
    now: () => 1_700_000_000_000,
    code: () => "042316",
    authorizationRef: () => {
      refs += 1;
      return `aref_${refs}`;
    },
    token: () => {
      tokens += 1;
      return `ctok_${tokens}`;
    },
  });
  control.redeemClaim("dev-opus", control.issueClaim("dev-opus").code);
  control.bind({
    deviceId: "dev-opus",
    digitalHumanId: "dh-opus",
    assistant: { voiceId: "voice-lab" },
  });
  const credential = control.issueConnectionCredential("dev-opus");
  const tts = createOpusFrameTtsProvider({ frameCount: 4, pcmMode: "tone" });

  const server = await startLabVoiceServer(control, {
    host: "127.0.0.1",
    port: 0,
    env: { OPENBOT_DEVICE_DH_TEST_MODE: "1" },
    ttsProvider: tts,
  });
  try {
    const client = await connectLabVoice(
      server.url,
      buildWebsocketHeaders({ deviceId: "dev-opus", clientId: "client-opus", token: credential.token }),
    );
    client.sendText(JSON.stringify(buildClientHello()));
    const helloFrame = await client.nextFrame();
    const hello = parseServerHello(JSON.parse(helloFrame.payload.toString("utf8")));
    assert.equal(hello.sampleRate, 24000);
    assert.equal(hello.frameDurationMs, 60);
    const sessionId = hello.sessionId ?? "";
    client.sendText(JSON.stringify({ type: "listen", state: "stop", session_id: sessionId, text: "speak-opus" }));

    const frames: WsFrame[] = [];
    for (let index = 0; index < 30; index += 1) {
      const frame = await client.nextFrame();
      frames.push(frame);
      if (frame.opcode === 1 && frame.payload.toString("utf8").includes('"state":"stop"')) {
        break;
      }
    }
    const binaries = frames.filter((frame) => frame.opcode === 2);
    assert.equal(binaries.length >= 4, true);
    assert.equal(
      binaries.every((frame) => !frame.payload.includes(OPUS_PLACEHOLDER_MAGIC)),
      true,
    );
    assert.equal(binaries.every((frame) => !isOpusPlaceholderPayload(frame.payload)), true);
    assert.equal(binaries.every((frame) => looksLikeRawOpusPacket(frame.payload)), true);
    client.close();
  } finally {
    await server.close();
    if ("destroy" in tts && typeof (tts as { destroy?: () => void }).destroy === "function") {
      (tts as { destroy: () => void }).destroy();
    }
  }
});

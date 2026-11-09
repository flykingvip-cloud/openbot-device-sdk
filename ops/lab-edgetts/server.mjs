#!/usr/bin/env node
/**
 * Lab-only Edge TTS HTTP for ReferenceHttpTtsProvider.
 * POST JSON { text, voice?, sampleRate? } → mono 16-bit WAV.
 * Binds 127.0.0.1 only. Not for production gateway.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const HOST = process.env.LAB_EDGETTS_HOST ?? "127.0.0.1";
const PORT = Number(process.env.LAB_EDGETTS_PORT ?? "8800");
const DEFAULT_VOICE = process.env.LAB_EDGETTS_VOICE ?? "zh-CN-XiaoxiaoNeural";
const DEFAULT_RATE = Number(process.env.LAB_EDGETTS_SAMPLE_RATE ?? "24000");

function xmlEscape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function synthesizeWav(text, voice, sampleRate) {
  const work = path.join(tmpdir(), `lab-edgetts-${randomUUID()}`);
  await mkdir(work, { recursive: true });
  const mp3Path = path.join(work, "audio.mp3");
  const wavPath = path.join(work, "audio.wav");
  try {
    const tts = new MsEdgeTTS({ connectionTimeoutMs: 15000, synthesisTimeoutMs: 60000 });
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(xmlEscape(text));
    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on("data", (c) => chunks.push(c));
      audioStream.on("error", reject);
      audioStream.on("close", resolve);
    });
    await writeFile(mp3Path, Buffer.concat(chunks));
    if (!ffmpegPath) throw new Error("ffmpeg-static binary missing");
    await new Promise((resolve, reject) => {
      const ff = spawn(
        ffmpegPath,
        ["-y", "-i", mp3Path, "-ac", "1", "-ar", String(sampleRate), "-sample_fmt", "s16", wavPath],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let err = "";
      ff.stderr.on("data", (d) => {
        err += d.toString();
      });
      ff.on("error", reject);
      ff.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-400)}`));
      });
    });
    return await readFile(wavPath);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/healthz")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "lab-edgetts", voice: DEFAULT_VOICE }));
    return;
  }
  if (req.method === "POST" && (req.url === "/tts" || req.url === "/edgetts")) {
    try {
      const raw = await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "text required" }));
        return;
      }
      const voice = typeof body.voice === "string" && body.voice.trim() ? body.voice.trim() : DEFAULT_VOICE;
      const sampleRate =
        typeof body.sampleRate === "number" && body.sampleRate > 0 ? body.sampleRate : DEFAULT_RATE;
      const wav = await synthesizeWav(text, voice, sampleRate);
      res.writeHead(200, {
        "content-type": "audio/wav",
        "content-length": String(wav.byteLength),
      });
      res.end(wav);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }
  res.writeHead(404).end("not found");
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`lab-edgetts http://${HOST}:${PORT}/tts voice=${DEFAULT_VOICE}\n`);
});

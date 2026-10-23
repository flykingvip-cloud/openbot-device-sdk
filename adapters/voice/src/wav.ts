/**
 * Minimal RIFF/WAVE reader for whole-utterance ASR.
 * Sample rate and channels come from the fmt chunk when present.
 * Does not decode compressed WAVE formats — PCM (format 1) only.
 */

export class WavParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavParseError";
  }
}

export interface WavPcmInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Byte offset of PCM payload inside the original buffer. */
  dataOffset: number;
  dataByteLength: number;
  /** Sliced PCM payload (s16le when bitsPerSample === 16). */
  pcm: Buffer;
}

const RIFF = 0x46464952;
const WAVE = 0x45564157;
const FMT = 0x20746d66;
const DATA = 0x61746164;

/** True when the buffer looks like a RIFF/WAVE container. */
export function isWavBuffer(audio: Buffer): boolean {
  return (
    audio.byteLength >= 12 &&
    audio.readUInt32LE(0) === RIFF &&
    audio.readUInt32LE(8) === WAVE
  );
}

/**
 * Parse a PCM WAVE buffer. Throws WavParseError on truncated or non-PCM WAVE.
 */
export function parseWavPcm(audio: Buffer): WavPcmInfo {
  if (!isWavBuffer(audio)) {
    throw new WavParseError("buffer is not a RIFF/WAVE container");
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let sawFmt = false;
  let dataOffset = -1;
  let dataByteLength = 0;

  while (offset + 8 <= audio.byteLength) {
    const chunkId = audio.readUInt32LE(offset);
    const chunkSize = audio.readUInt32LE(offset + 4);
    const chunkData = offset + 8;
    if (chunkData + chunkSize > audio.byteLength) {
      throw new WavParseError(`WAVE chunk at ${offset} extends past buffer end`);
    }
    if (chunkId === FMT) {
      if (chunkSize < 16) {
        throw new WavParseError("fmt chunk too small");
      }
      audioFormat = audio.readUInt16LE(chunkData);
      channels = audio.readUInt16LE(chunkData + 2);
      sampleRate = audio.readUInt32LE(chunkData + 4);
      bitsPerSample = audio.readUInt16LE(chunkData + 14);
      sawFmt = true;
    } else if (chunkId === DATA) {
      dataOffset = chunkData;
      dataByteLength = chunkSize;
      break;
    }
    offset = chunkData + chunkSize + (chunkSize % 2);
  }

  if (!sawFmt) {
    throw new WavParseError("WAVE missing fmt chunk");
  }
  if (dataOffset < 0) {
    throw new WavParseError("WAVE missing data chunk");
  }
  if (audioFormat !== 1) {
    throw new WavParseError(`unsupported WAVE audio format ${audioFormat} (PCM=1 only)`);
  }
  if (channels < 1 || sampleRate < 1 || bitsPerSample < 8) {
    throw new WavParseError("invalid WAVE fmt fields");
  }

  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataOffset,
    dataByteLength,
    pcm: audio.subarray(dataOffset, dataOffset + dataByteLength),
  };
}

/**
 * Build a minimal mono/stereo PCM s16le WAVE buffer (for tests and fixtures).
 */
export function buildWavPcm(input: {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample?: number;
}): Buffer {
  const bitsPerSample = input.bitsPerSample ?? 16;
  const blockAlign = (input.channels * bitsPerSample) / 8;
  const byteRate = input.sampleRate * blockAlign;
  const dataSize = input.pcm.byteLength;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.writeUInt32LE(RIFF, 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.writeUInt32LE(WAVE, 8);
  buffer.writeUInt32LE(FMT, 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(input.channels, 22);
  buffer.writeUInt32LE(input.sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.writeUInt32LE(DATA, 36);
  buffer.writeUInt32LE(dataSize, 40);
  input.pcm.copy(buffer, 44);
  return buffer;
}

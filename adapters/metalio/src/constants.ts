/** CloudZao/MetalioClaw4 main tip verified on 2026-10-20. Do not substitute v2.0.5 or v2.0.5.1. */
export const FIRMWARE_REPO = "https://github.com/CloudZao/MetalioClaw4";

export const FIRMWARE_SHA = "ca3aa3fa027ff7dad2adf0c2d03c4f24aa838950";

export const FIRMWARE_BOARD = "main/boards/metalio-claw-4/";

export const FIRMWARE_TARGET = "esp32p4";

/** `audio_service.h`: `MAX_DECODE_PACKETS_IN_QUEUE (2400 / OPUS_FRAME_DURATION_MS)`. */
export const OPUS_FRAME_DURATION_MS = 60;

export const DECODE_QUEUE_BUDGET_MS = 2400;

export const MAX_DECODE_PACKETS_IN_QUEUE = DECODE_QUEUE_BUDGET_MS / OPUS_FRAME_DURATION_MS;

export const MAX_SEND_PACKETS_IN_QUEUE = DECODE_QUEUE_BUDGET_MS / OPUS_FRAME_DURATION_MS;

export const MAX_ENCODE_TASKS_IN_QUEUE = 2;

export const MAX_PLAYBACK_TASKS_IN_QUEUE = 2;

export const UPLINK_SAMPLE_RATE = 16000;

export const UPLINK_CHANNELS = 1;

export const SERVER_SAMPLE_RATE_DEFAULT = 24000;

export const SERVER_FRAME_DURATION_DEFAULT_MS = 60;

export const HELLO_TIMEOUT_MS = 10_000;

export const CHANNEL_IDLE_TIMEOUT_SECONDS = 120;

export const PROTOCOL_VERSION_DEFAULT = 1;

/** BinaryProtocol2 packed header: version, type, reserved, timestamp, payload_size. */
export const BINARY_PROTOCOL2_HEADER_BYTES = 16;

/** BinaryProtocol3 packed header: type, reserved, payload_size. */
export const BINARY_PROTOCOL3_HEADER_BYTES = 4;

export const XIAOZHI_OTA_HOST = "api.tenclass.net";

export const C5_HOSTED_BIN_HOST = "cloudzaoai.oss-rg-china-mainland.aliyuncs.com";

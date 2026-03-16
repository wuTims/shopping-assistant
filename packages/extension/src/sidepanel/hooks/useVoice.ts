import { useCallback, useEffect, useRef, useState } from "react";
import type { WsClientMessage, WsServerMessage } from "@shopping-assistant/shared";
import {
  VOICE_INPUT_SAMPLE_RATE,
  VOICE_OUTPUT_SAMPLE_RATE,
} from "@shopping-assistant/shared";

export type VoiceStatus = "idle" | "connecting" | "recording" | "paused" | "error";

export interface UseVoiceOptions {
  backendUrl: string;
  context: Record<string, unknown>;
  onConversationCommit?: (turn: { inputTranscript: string; outputTranscript: string }) => void;
}

export interface UseVoiceReturn {
  status: VoiceStatus;
  isRecording: boolean;
  inputTranscript: string;
  outputTranscript: string;
  error: string | null;
  start: () => Promise<void>;
  pauseMic: () => void;
  endSession: () => void;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const sampleCount = bytes.length / 2;
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    let sample = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    if (sample >= 32768) sample -= 65536;
    float32[i] = sample / 32768;
  }
  return float32;
}

export function applyPlaybackEnvelope(samples: Float32Array, fadeSamples = 96): Float32Array {
  if (samples.length === 0) return samples;

  const output = new Float32Array(samples);
  const fadeLength = Math.min(fadeSamples, Math.floor(output.length / 2));

  for (let i = 0; i < output.length; i++) {
    let gain = 1;
    if (fadeLength > 0 && i < fadeLength) {
      gain = Math.min(gain, i / fadeLength);
    }
    if (fadeLength > 0 && i >= output.length - fadeLength) {
      gain = Math.min(gain, (output.length - 1 - i) / fadeLength);
    }
    output[i] *= Math.max(gain, 0);
  }

  let peak = 0;
  for (let i = 0; i < output.length; i++) {
    peak = Math.max(peak, Math.abs(output[i]));
  }
  if (peak > 0.92) {
    const trim = 0.92 / peak;
    for (let i = 0; i < output.length; i++) {
      output[i] *= trim;
    }
  }

  const normalized = new Float32Array(output.length);
  normalized.set(output);
  return normalized;
}

export function useVoice({ backendUrl, context, onConversationCommit }: UseVoiceOptions): UseVoiceReturn {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [inputTranscript, setInputTranscript] = useState("");
  const [outputTranscript, setOutputTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxCaptureRef = useRef<AudioContext | null>(null);
  const audioCtxPlaybackRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const cleaningUpRef = useRef(false);
  const turnCompleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputTranscriptRef = useRef("");
  const outputTranscriptRef = useRef("");

  const commitPendingConversation = useCallback(() => {
    const nextInput = inputTranscriptRef.current.trim();
    const nextOutput = outputTranscriptRef.current.trim();
    if (!nextInput && !nextOutput) return;
    onConversationCommit?.({
      inputTranscript: nextInput,
      outputTranscript: nextOutput,
    });
    inputTranscriptRef.current = "";
    outputTranscriptRef.current = "";
    setInputTranscript("");
    setOutputTranscript("");
  }, [onConversationCommit]);

  const stopCapture = useCallback(() => {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;

    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;

    if (audioCtxCaptureRef.current?.state !== "closed") {
      audioCtxCaptureRef.current?.close();
    }
    audioCtxCaptureRef.current = null;
  }, []);

  const cleanup = useCallback(() => {
    if (cleaningUpRef.current) return;
    cleaningUpRef.current = true;

    stopCapture();

    if (turnCompleteTimerRef.current) {
      clearTimeout(turnCompleteTimerRef.current);
      turnCompleteTimerRef.current = null;
    }

    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* already closed */ }
    }
    wsRef.current = null;

    for (const src of activeSourcesRef.current) {
      try { src.stop(0); src.disconnect(); } catch { /* already stopped */ }
    }
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = 0;

    cleaningUpRef.current = false;
  }, [stopCapture]);

  useEffect(() => {
    return () => {
      cleanup();
      if (audioCtxPlaybackRef.current?.state !== "closed") {
        audioCtxPlaybackRef.current?.close();
      }
    };
  }, [cleanup]);

  const playAudioChunk = useCallback((base64Data: string) => {
    if (!audioCtxPlaybackRef.current || audioCtxPlaybackRef.current.state === "closed") {
      audioCtxPlaybackRef.current = new AudioContext({ sampleRate: VOICE_OUTPUT_SAMPLE_RATE });
    }
    const ctx = audioCtxPlaybackRef.current;
    const float32 = applyPlaybackEnvelope(base64ToFloat32(base64Data));

    const audioBuffer = ctx.createBuffer(1, float32.length, VOICE_OUTPUT_SAMPLE_RATE);
    audioBuffer.copyToChannel(float32 as unknown as Float32Array<ArrayBuffer>, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    activeSourcesRef.current.push(source);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
    };

    if (nextPlayTimeRef.current < ctx.currentTime) {
      nextPlayTimeRef.current = ctx.currentTime;
    }
    source.start(nextPlayTimeRef.current);
    nextPlayTimeRef.current += audioBuffer.duration;
  }, []);

  const clearPlaybackQueue = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try { src.stop(0); src.disconnect(); } catch { /* already stopped */ }
    }
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = 0;
  }, []);

  const sendWs = useCallback((msg: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const contextRef = useRef(context);
  contextRef.current = context;

  const ensureMicPermission = useCallback(async (): Promise<boolean> => {
    try {
      const result = await navigator.permissions.query({ name: "microphone" as PermissionName });
      if (result.state === "granted") return true;
    } catch {
      // permissions.query may not support "microphone" in all contexts — fall through
    }

    // In extension side panels the permission prompt is auto-dismissed.
    // Open a dedicated tab so the browser can show the real prompt.
    if (typeof chrome !== "undefined" && chrome.tabs) {
      const grantUrl = chrome.runtime.getURL("src/mic-permission/index.html");
      chrome.tabs.create({ url: grantUrl, active: true });

      // Wait for the grant-page to message us back
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(listener);
          resolve(false);
        }, 60_000);

        const listener = (msg: { type?: string }) => {
          if (msg.type === "MIC_PERMISSION_GRANTED") {
            clearTimeout(timeout);
            chrome.runtime.onMessage.removeListener(listener);
            resolve(true);
          }
        };
        chrome.runtime.onMessage.addListener(listener);
      });
    }

    return false;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setInputTranscript("");
    setOutputTranscript("");
    setStatus("connecting");

    try {
      const permitted = await ensureMicPermission();
      if (!permitted) {
        setError("Microphone permission is required for voice chat");
        setStatus("error");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: VOICE_INPUT_SAMPLE_RATE },
      });
      mediaStreamRef.current = stream;

      const ws = new WebSocket(backendUrl + "/live");
      wsRef.current = ws;

      // readyResolve is called when the backend sends "ready" after upstream connects
      let readyResolve: (() => void) | null = null;
      let readyReject: ((err: Error) => void) | null = null;
      const readyPromise = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data) as WsServerMessage;

        switch (msg.type) {
          case "ready":
            readyResolve?.();
            break;
          case "audio":
            playAudioChunk(msg.data);
            break;
          case "input_transcript":
            inputTranscriptRef.current += msg.content;
            setInputTranscript(inputTranscriptRef.current);
            break;
          case "output_transcript":
            outputTranscriptRef.current += msg.content;
            setOutputTranscript(outputTranscriptRef.current);
            break;
          case "interrupted":
            clearPlaybackQueue();
            break;
          case "turn_complete":
            if (turnCompleteTimerRef.current) clearTimeout(turnCompleteTimerRef.current);
            turnCompleteTimerRef.current = setTimeout(() => {
              turnCompleteTimerRef.current = null;
              commitPendingConversation();
            }, 200);
            break;
          case "go_away":
            setError(`Session expiring in ${Math.round(msg.timeLeftMs / 1000)}s`);
            break;
          case "session_resumption":
            console.log("[voice] Session resumption token received");
            break;
          case "error":
            readyReject?.(new Error(msg.message));
            setError(msg.message);
            setStatus("error");
            cleanup();
            break;
        }
      };

      const handleWsError = () => {
        readyReject?.(new Error("Connection error"));
        setError("Connection error");
        setStatus("error");
        cleanup();
      };

      ws.onerror = handleWsError;

      ws.onclose = () => {
        readyReject?.(new Error("Connection closed"));
        setStatus((prev) => (prev === "error" ? prev : "idle"));
        cleanup();
      };

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => {
          reject(new Error("WebSocket connection failed"));
        };
      });

      // Restore persistent error handler after connection promise resolves
      ws.onerror = handleWsError;

      // Send config and wait for the backend to establish the upstream Gemini session
      sendWs({ type: "config", context: contextRef.current });
      await readyPromise;

      const audioCtx = new AudioContext({ sampleRate: VOICE_INPUT_SAMPLE_RATE });
      audioCtxCaptureRef.current = audioCtx;

      const workletUrl = chrome.runtime.getURL("src/sidepanel/audio-worklet-processor.js");
      await audioCtx.audioWorklet.addModule(workletUrl);

      const source = audioCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      const workletNode = new AudioWorkletNode(audioCtx, "pcm-capture-processor");
      workletNodeRef.current = workletNode;

      workletNode.port.onmessage = (e: MessageEvent<{ type: string; buffer: ArrayBuffer }>) => {
        if (e.data.type === "pcm_chunk") {
          const base64 = arrayBufferToBase64(e.data.buffer);
          sendWs({
            type: "audio",
            encoding: "pcm_s16le",
            sampleRateHz: 16000,
            data: base64,
          });
        }
      };

      source.connect(workletNode);

      setStatus("recording");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start voice";
      setError(msg);
      setStatus("error");
      cleanup();
    }
  }, [backendUrl, cleanup, clearPlaybackQueue, commitPendingConversation, ensureMicPermission, playAudioChunk, sendWs]);

  const pauseMic = useCallback(() => {
    const node = workletNodeRef.current;
    if (node) {
      const handleFlushed = (e: MessageEvent) => {
        if (e.data?.type === "flushed") {
          node.port.removeEventListener("message", handleFlushed);
          sendWs({ type: "audioStreamEnd" });
          stopCapture();
          setStatus("paused");
        }
      };
      node.port.addEventListener("message", handleFlushed);
      node.port.postMessage({ type: "flush" });
    } else {
      sendWs({ type: "audioStreamEnd" });
      stopCapture();
      setStatus("paused");
    }
  }, [sendWs, stopCapture]);

  const endSession = useCallback(() => {
    if (turnCompleteTimerRef.current) {
      clearTimeout(turnCompleteTimerRef.current);
      turnCompleteTimerRef.current = null;
    }
    commitPendingConversation();
    cleanup();
    setStatus("idle");
  }, [cleanup, commitPendingConversation]);

  return {
    status,
    isRecording: status === "recording",
    inputTranscript,
    outputTranscript,
    error,
    start,
    pauseMic,
    endSession,
  };
}

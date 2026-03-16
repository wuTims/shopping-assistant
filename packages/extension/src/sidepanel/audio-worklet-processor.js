// AudioWorklet processor for PCM capture.
// Buffers Float32 mic input into Int16 PCM chunks of BUFFER_SIZE samples,
// then posts them to the main thread for WebSocket transmission.
// 640 samples at 16kHz = 40ms chunks (Google recommends 20-40ms).

const BUFFER_SIZE = 640;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(BUFFER_SIZE);
    this.writeIndex = 0;
  }

  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      // Clamp and convert Float32 [-1, 1] to Int16 [-32768, 32767]
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.writeIndex++] = s * 32767;

      if (this.writeIndex >= BUFFER_SIZE) {
        // Use Transferable to avoid redundant structured clone of the copy
        const copy = this.buffer.buffer.slice(0);
        this.port.postMessage({ type: "pcm_chunk", buffer: copy }, [copy]);
        this.writeIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);

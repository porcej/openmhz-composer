/** Decode, optional resample, concatenate with silence gaps, encode WAV. */

const TARGET_SAMPLE_RATE = 48000;

export async function fetchDecode(
  ctx: BaseAudioContext,
  url: string
): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch audio: ${res.status} ${url}`);
  const raw = await res.arrayBuffer();
  const buf = await ctx.decodeAudioData(raw.slice(0));
  return buf;
}

async function resampleIfNeeded(buffer: AudioBuffer): Promise<AudioBuffer> {
  if (buffer.sampleRate === TARGET_SAMPLE_RATE) return buffer;
  const frames = Math.ceil(buffer.duration * TARGET_SAMPLE_RATE);
  const offline = new OfflineAudioContext(
    buffer.numberOfChannels,
    frames,
    TARGET_SAMPLE_RATE
  );
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

function mergeBuffers(
  ctx: AudioContext,
  buffers: AudioBuffer[],
  gapSamplesAfterEach: number[]
): AudioBuffer {
  if (buffers.length === 0) {
    throw new Error("No buffers to merge");
  }
  const channels = Math.max(...buffers.map((b) => b.numberOfChannels));
  let total = 0;
  for (let i = 0; i < buffers.length; i++) {
    total += buffers[i].length;
    total += gapSamplesAfterEach[i] ?? 0;
  }
  const out = ctx.createBuffer(channels, total, TARGET_SAMPLE_RATE);
  let offset = 0;
  for (let i = 0; i < buffers.length; i++) {
    const b = buffers[i];
    for (let ch = 0; ch < channels; ch++) {
      const dst = out.getChannelData(ch);
      const srcCh = ch < b.numberOfChannels ? ch : 0;
      const src = b.getChannelData(srcCh);
      dst.set(src, offset);
    }
    offset += b.length;
    offset += gapSamplesAfterEach[i] ?? 0;
  }
  return out;
}

function writeWav(buffer: AudioBuffer): ArrayBuffer {
  const numCh = buffer.numberOfChannels;
  const length = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const byteRate = buffer.sampleRate * blockAlign;
  const dataSize = length * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  let p = 0;
  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i));
  };
  writeStr("RIFF");
  v.setUint32(p, 36 + dataSize, true);
  p += 4;
  writeStr("WAVEfmt ");
  v.setUint32(p, 16, true);
  p += 4;
  v.setUint16(p, 1, true);
  p += 2;
  v.setUint16(p, numCh, true);
  p += 2;
  v.setUint32(p, buffer.sampleRate, true);
  p += 4;
  v.setUint32(p, byteRate, true);
  p += 4;
  v.setUint16(p, blockAlign, true);
  p += 2;
  v.setUint16(p, 16, true);
  p += 2;
  writeStr("data");
  v.setUint32(p, dataSize, true);
  p += 4;
  const interleaved = new Float32Array(length * numCh);
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      interleaved[i * numCh + ch] = buffer.getChannelData(
        ch < buffer.numberOfChannels ? ch : 0
      )[i];
    }
  }
  for (let i = 0; i < interleaved.length; i++) {
    let s = Math.max(-1, Math.min(1, interleaved[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    v.setInt16(p, s, true);
    p += 2;
  }
  return buf;
}

export type MergeClip = { url: string };

export async function mergeUrlsToWav(
  clips: MergeClip[],
  delayAfterMs: number[]
): Promise<{ wav: Blob; buffer: AudioBuffer }> {
  const ctx = new AudioContext();
  try {
    const decoded: AudioBuffer[] = [];
    for (const c of clips) {
      const raw = await fetchDecode(ctx, c.url);
      decoded.push(await resampleIfNeeded(raw));
    }
    const gapSamples = delayAfterMs.map((ms) =>
      Math.round((ms / 1000) * TARGET_SAMPLE_RATE)
    );
    const merged = mergeBuffers(ctx, decoded, gapSamples);
    const wav = new Blob([writeWav(merged)], { type: "audio/wav" });
    return { wav, buffer: merged };
  } finally {
    await ctx.close();
  }
}

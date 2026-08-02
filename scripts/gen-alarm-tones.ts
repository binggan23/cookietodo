/**
 * Slice 5 — one-shot alarm tone synthesizer (ADR 0009 Decision A).
 *
 * Self-synthesizes 5 distinct short `.mp3` alarm tones into
 * `src/assets/alarm-sounds/tone1..tone5.mp3`, each a different audible peak
 * frequency with a soft sine envelope. License-clearance path per ADR 0009
 * ("self-synthesized sine/sawtooth envelopes" is one of the explicitly
 * allowed sources); the resulting tones are CC0-licensed by the act of
 * synthesizing them — we are the author and release them to the public
 * domain. `sources.md` records this provenance.
 *
 * Each tone:
 *   - Mono, 44.1 kHz, 128 kbps MP3 (ADR 0009 — single shared `mp3` format).
 *   - 1 second of sine wave with 20 ms attack + 50 ms decay (avoid click
 *     at the boundary so the mp3 loop tag — slice 5 plays `<audio autoplay
 *     loop>` — does not pop).
 *   - Peak frequency chosen so the 5 tones are audibly distinct (not a
 *     musical scale; alarm tones must feel different, not harmonic):
 *       tone1 = 880 Hz    (A5)
 *       tone2 = 660 Hz    (E5)
 *       tone3 = 990 Hz    (~B5)
 *       tone4 = 740 Hz    (~F#5)
 *       tone5 = 1320 Hz   (E6)
 *
 * Run once: `pnpm tsx scripts/gen-alarm-tones.ts`. Output is committed —
 * the repo ships the bytes, not the generation step (so a release build
 * never depends on installing lamejs at build time).
 *
 * This script is NOT in the `tsconfig*.json` include paths; it is invoked
 * ad-hoc via tsx and excluded from `pnpm typecheck` (the script-package
 * import path `@breezystack/lamejs` is a root devDep installed once).
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Mp3Encoder } from "@breezystack/lamejs";

const __dirname_subst = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = resolve(__dirname_subst, "..", "src", "assets", "alarm-sounds");

const SAMPLE_RATE = 44100;
const DURATION_SEC = 1;
const K_BPS = 128;
const ATTACK_MS = 20;
const DECAY_MS = 50;
const PEAK_AMP = 0.85; // 16-bit range head-room; leave room for next-block intersample

const FREQS = [880, 660, 990, 740, 1320];

function floatToInt16Sample(x: number): number {
  const clamped = Math.max(-1, Math.min(1, x));
  // Int16 rounding — round half away from zero per IEEE 754 default.
  return Math.sign(clamped) * Math.round(Math.abs(clamped) * 32767);
}

function buildToneSamples(freqHz: number): Int16Array {
  const total = SAMPLE_RATE * DURATION_SEC;
  const out = new Int16Array(total);
  const attackN = Math.floor((SAMPLE_RATE * ATTACK_MS) / 1000);
  const decayN = Math.floor((SAMPLE_RATE * DECAY_MS) / 1000);
  for (let i = 0; i < total; i += 1) {
    const t = i / SAMPLE_RATE;
    // Pure sine — alarm tones are designed to be unmistakable; harmonic
    // richness makes a tone musical, not alarming.
    const sample = Math.sin(2 * Math.PI * freqHz * t) * PEAK_AMP;
    let env = 1;
    if (i < attackN) {
      env = i / attackN;
    } else if (i > total - decayN) {
      env = (total - i) / decayN;
    }
    out[i] = floatToInt16Sample(sample * env);
  }
  return out;
}

function encodeMonoMp3(samples: Int16Array): Uint8Array {
  const enc = new Mp3Encoder(1, SAMPLE_RATE, K_BPS);
  const chunks: Uint8Array[] = [];
  // lamejs recommends 1152-sample blocks; we just feed the whole array in one
  // buffer + flush — a 1-second tone is small enough that memory is irrelevant.
  const buf = enc.encodeBuffer(samples);
  if (buf.length > 0) chunks.push(buf);
  const tail = enc.flush();
  if (tail.length > 0) chunks.push(tail);
  // Concatenate into a single Uint8Array for fs.writeFile.
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function main(): Promise<void> {
  await mkdir(ASSET_DIR, { recursive: true });
  for (let i = 0; i < FREQS.length; i += 1) {
    const id = i + 1;
    const samples = buildToneSamples(FREQS[i] ?? 880);
    const bytes = encodeMonoMp3(samples);
    const path = resolve(ASSET_DIR, `tone${id}.mp3`);
    await writeFile(path, bytes);
    console.log(`wrote ${path} (${bytes.length} bytes, ${FREQS[i]}Hz)`);
  }
  console.log("alarm tone synthesis complete");
}

void main().catch((err: unknown) => {
  console.error("gen-alarm-tones failed:", err);
  process.exit(1);
});

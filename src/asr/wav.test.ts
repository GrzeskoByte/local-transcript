import { describe, expect, it } from 'vitest';
import { bytesToBase64, encodeWav16, floatTo16BitPCM } from './wav';

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

describe('encodeWav16', () => {
  it('writes a valid mono 16 kHz PCM RIFF header', () => {
    const samples = new Float32Array(100).fill(0.5);
    const wav = encodeWav16(samples, 16000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(wav.length).toBe(44 + 100 * 2);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(ascii(wav, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(200);
    expect(view.getUint32(4, true)).toBe(36 + 200);
  });

  it('clamps out-of-range samples instead of wrapping', () => {
    const pcm = floatTo16BitPCM(new Float32Array([2, -2, 0]));
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
    expect(pcm[2]).toBe(0);
  });

  it('round-trips sample values through the data chunk', () => {
    const wav = encodeWav16(new Float32Array([0, 1, -1]), 16000);
    const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, 3);
    expect(Array.from(pcm)).toEqual([0, 32767, -32768]);
  });
});

describe('bytesToBase64', () => {
  it('matches the browser atob round-trip for a large buffer', () => {
    const bytes = new Uint8Array(0x10000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const b64 = bytesToBase64(bytes);
    const decoded = atob(b64);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(12345)).toBe(12345 % 251);
  });
});

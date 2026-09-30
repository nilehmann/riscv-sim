// Deterministic garbage for uninitialized registers, memory and code — looks
// like random data but is reproducible across runs, useful for teaching.

export function garbageValue(addr: number): number {
  let h = Math.imul(addr ^ 0x45d9f3b, 0x9e3779b9);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5c4d3215);
  return (h ^ (h >>> 16)) | 0;
}

/** Garbage value of register number i, as an unsigned `bytes`-wide integer. */
export function garbageReg(i: number, bytes: number): bigint {
  let v = 0n;
  for (let k = 0; k * 4 < bytes; k++)
    v |= BigInt(garbageValue(i + k * 0x10000) >>> 0) << BigInt(k * 32);
  return BigInt.asUintN(bytes * 8, v);
}

/** Little-endian value of `bytes` garbage memory bytes starting at addr. */
export function garbageMem(addr: number, bytes: number): bigint {
  let v = 0n;
  for (let i = 0; i < bytes; i++)
    v |= BigInt(garbageValue(addr + i) & 0xff) << BigInt(i * 8);
  return v;
}

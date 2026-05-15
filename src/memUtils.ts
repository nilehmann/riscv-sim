import { garbageValue } from "./simulator";

export function garbageWord(addr: number): number {
    return (garbageValue(addr) & 0xff) |
           ((garbageValue(addr + 1) & 0xff) << 8) |
           ((garbageValue(addr + 2) & 0xff) << 16) |
           ((garbageValue(addr + 3) & 0xff) << 24);
}

export function subSlots(addr: number, nativeBytes: 1 | 2 | 4, mode: 'halfword' | 'byte') {
    const subSize: 1 | 2 = mode === 'byte' ? 1 : 2;
    const count = nativeBytes / subSize;
    return Array.from({ length: count }, (_, i) => ({
        addr: addr + i * subSize,
        size: subSize as 1 | 2,
    }));
}

export function readBytes(mem: Map<number, number>, addr: number, bytes: 1 | 2 | 4): number {
    let val = 0;
    for (let i = 0; i < bytes; i++) val |= ((mem.get(addr + i) ?? 0) & 0xff) << (i * 8);
    return val;
}

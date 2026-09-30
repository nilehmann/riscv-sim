export function subSlots(addr: number, nativeBytes: 1 | 2 | 4 | 8, mode: 'halfword' | 'byte') {
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

/** Little-endian value at addr, or undefined if none of its bytes were ever written. */
export function readWritten(mem: Map<number, number>, addr: number, bytes: number): bigint | undefined {
    let val = 0n;
    let any = false;
    for (let i = 0; i < bytes; i++) {
        const b = mem.get(addr + i);
        if (b !== undefined) any = true;
        val |= BigInt((b ?? 0) & 0xff) << BigInt(i * 8);
    }
    return any ? val : undefined;
}

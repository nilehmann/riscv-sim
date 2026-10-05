/** Whether the `size` bytes at addr overlap any of the accesses. */
export function overlapsAccess(
    addr: number,
    size: number,
    access: readonly { addr: number; size: number }[] | undefined,
): boolean {
    return access?.some((a) => a.addr < addr + size && addr < a.addr + a.size) ?? false;
}

/** Splits a slot of `nativeBytes` into pieces of `subSize` bytes, lowest address first. */
export function subSlots<S extends number>(addr: number, nativeBytes: number, subSize: S) {
    return Array.from({ length: nativeBytes / subSize }, (_, i) => ({
        addr: addr + i * subSize,
        size: subSize,
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

import { AppError, fmtAddr } from "./types";
import type { Program, MemoryRegion, AssemblyResult } from "./types";
import type { Isa } from "./isa/types";

// ── Internal helpers ───────────────────────────────────────────────────────

function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < aE && bS < bE && aS < bE && bS < aE;
}

// ── Individual exported checks ─────────────────────────────────────────────

/** Addresses are 32 bits wide on 32-bit ISAs and 48 bits wide on 64-bit ones. */
export function checkAddr(v: number, name: string, isa: Isa): AppError | null {
  const bits = isa.wordBytes === 4 ? 32 : 48;
  if (!Number.isInteger(v) || v < 0 || v >= 2 ** bits)
    return new AppError(`${name} 0x${v.toString(16).toUpperCase()} does not fit in ${bits} bits`);
  return null;
}

export function checkElementFit(
  v: number,
  elementSize: MemoryRegion["elementSize"],
  label: string,
): AppError | null {
  const maxVal = elementSize === 4 ? 0xffffffff : (1 << (elementSize * 8)) - 1;
  if ((v >>> 0) > maxVal)
    return new AppError(`${label}: ${v} does not fit in ${elementSize} byte(s)`);
  return null;
}

export function checkSpStackBase(sp: number, stackBase: number): AppError | null {
  if (sp > stackBase)
    return new AppError(
      `Initial sp (${fmtAddr(sp)}) is greater than stackBase (${fmtAddr(stackBase)}); the valid stack range [sp, stackBase) would be empty`,
    );
  return null;
}

export function checkRegionElements(r: MemoryRegion, ri: number): AppError | null {
  for (let i = 0; i < r.elements.length; i++) {
    const err = checkElementFit(r.elements[i]!, r.elementSize, `memoryRegions[${ri}].elements[${i}]`);
    if (err) return err;
  }
  return null;
}

export function checkRegionRegionOverlap(regions: MemoryRegion[]): AppError | null {
  for (let ri = 0; ri < regions.length; ri++) {
    const r = regions[ri]!;
    const rEnd = r.addr + r.elements.length * r.elementSize;
    for (let rj = 0; rj < ri; rj++) {
      const r2 = regions[rj]!;
      const r2End = r2.addr + r2.elements.length * r2.elementSize;
      if (overlaps(r.addr, rEnd, r2.addr, r2End))
        return new AppError(
          `memoryRegions[${ri}] (${fmtAddr(r.addr)}–${fmtAddr(rEnd - 1)}) overlaps memoryRegions[${rj}] (${fmtAddr(r2.addr)}–${fmtAddr(r2End - 1)})`,
        );
    }
  }
  return null;
}

export function checkRegionStackOverlap(
  regions: MemoryRegion[],
  sp: number,
  stackBase: number,
): AppError | null {
  for (let ri = 0; ri < regions.length; ri++) {
    const r = regions[ri]!;
    const rEnd = r.addr + r.elements.length * r.elementSize;
    if (overlaps(r.addr, rEnd, sp, stackBase))
      return new AppError(
        `memoryRegions[${ri}] (${fmtAddr(r.addr)}–${fmtAddr(rEnd - 1)}) overlaps the stack (${fmtAddr(sp)}–${fmtAddr(stackBase - 1)})`,
      );
  }
  return null;
}

export function checkEntryPoint(
  entryPoint: string,
  labels: Record<string, number>,
): AppError | null {
  if (!(entryPoint in labels))
    return new AppError(
      `Entry point '${entryPoint}' not found`,
      `Available labels: ${Object.keys(labels).join(", ")}`,
    );
  return null;
}

export function checkRaRange(
  ra: number,
  progStart: number,
  progEnd: number,
  name = "ra",
): AppError | null {
  if (ra >= progStart && ra < progEnd)
    return new AppError(
      `Initial ${name} (${fmtAddr(ra)}) points inside the program range [${fmtAddr(progStart)}–${fmtAddr(progEnd - 1)}]`,
      `Set initialRegs.${name} to an address outside the program`,
    );
  return null;
}

export function checkCodeStackOverlap(codeEnd: number, stackBase: number): AppError | null {
  if (codeEnd > stackBase)
    return new AppError(
      `Code section ends at ${fmtAddr(codeEnd)}, overlapping stack base ${fmtAddr(stackBase)}`,
      "Reduce baseAddress or increase stackBase",
    );
  return null;
}

export function checkRegionCodeOverlap(
  regions: MemoryRegion[],
  progStart: number,
  progEnd: number,
): AppError | null {
  for (let ri = 0; ri < regions.length; ri++) {
    const r = regions[ri]!;
    const rEnd = r.addr + r.elements.length * r.elementSize;
    if (overlaps(r.addr, rEnd, progStart, progEnd))
      return new AppError(
        `memoryRegions[${ri}] (${fmtAddr(r.addr)}–${fmtAddr(rEnd - 1)}) overlaps the code segment (${fmtAddr(progStart)}–${fmtAddr(progEnd - 1)})`,
      );
  }
  return null;
}

// ── Umbrella functions ─────────────────────────────────────────────────────

export function validateProgram(prog: Program, isa: Isa): AppError | null {
  let err: AppError | null;

  err = checkAddr(prog.baseAddress, "baseAddress", isa);
  if (err) return err;

  if (prog.stackBase != null) {
    err = checkAddr(prog.stackBase, "stackBase", isa);
    if (err) return err;
  }

  const bits = isa.wordBytes * 8;
  for (const [reg, val] of Object.entries(prog.initialRegs)) {
    if (!Number.isSafeInteger(val) || val < 0 || BigInt(val) >> BigInt(bits) !== 0n)
      return new AppError(
        `Initial register ${reg} = 0x${val.toString(16).toUpperCase()} does not fit in ${bits} bits`,
      );
  }

  if (prog.osMode !== false) {
    const stackBase = prog.stackBase ?? isa.defaults.stackBase;
    err = checkSpStackBase(prog.initialRegs[isa.regs.sp] ?? 0, stackBase);
    if (err) return err;
  }

  if (prog.returnAddress != null) {
    err = checkAddr(prog.returnAddress, "returnAddress", isa);
    if (err) return err;
  }

  const regions = prog.memoryRegions ?? [];
  for (let ri = 0; ri < regions.length; ri++) {
    err = checkRegionElements(regions[ri]!, ri);
    if (err) return err;
  }

  const stackBase = prog.stackBase ?? isa.defaults.stackBase;
  const sp = prog.initialRegs[isa.regs.sp] ?? stackBase;
  err = checkRegionStackOverlap(regions, sp, stackBase);
  if (err) return err;

  return checkRegionRegionOverlap(regions);
}

export function validateAssembled(
  prog: Program,
  assembled: AssemblyResult,
  isa: Isa,
): AppError | null {
  const { labels } = assembled;
  const progStart = prog.baseAddress;
  const progEnd = assembled.endAddr;
  const stackBase = prog.stackBase ?? isa.defaults.stackBase;

  let err: AppError | null;

  if (prog.entryPoint) {
    err = checkEntryPoint(prog.entryPoint, labels);
    if (err) return err;
  }

  const ra = isa.regs.returnAddr;
  if (ra) {
    err = checkRaRange(prog.initialRegs[ra] ?? 0, progStart, progEnd, ra);
    if (err) return err;
  }

  err = checkCodeStackOverlap(progEnd, stackBase);
  if (err) return err;

  return checkRegionCodeOverlap(prog.memoryRegions ?? [], progStart, progEnd);
}

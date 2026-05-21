import { AppError, hx } from "./types";
import type { Program, MemoryRegion, AssemblyResult } from "./types";

// ── Internal helpers ───────────────────────────────────────────────────────

function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < aE && bS < bE && aS < bE && bS < aE;
}

// ── Individual exported checks ─────────────────────────────────────────────

export function checkU32(v: number, name: string): AppError | null {
  if (v >>> 0 !== v)
    return new AppError(`${name} ${hx(v)} does not fit in 32 bits`);
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
      `Initial sp (${hx(sp)}) is greater than stackBase (${hx(stackBase)}); the valid stack range [sp, stackBase) would be empty`,
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
          `memoryRegions[${ri}] (${hx(r.addr)}–${hx(rEnd - 1)}) overlaps memoryRegions[${rj}] (${hx(r2.addr)}–${hx(r2End - 1)})`,
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
        `memoryRegions[${ri}] (${hx(r.addr)}–${hx(rEnd - 1)}) overlaps the stack (${hx(sp)}–${hx(stackBase - 1)})`,
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

export function checkRaRange(ra: number, progStart: number, progEnd: number): AppError | null {
  if (ra >= progStart && ra < progEnd)
    return new AppError(
      `Initial ra (${hx(ra)}) points inside the program range [${hx(progStart)}–${hx(progEnd - 4)}]`,
      `Set initialRegs.ra to an address outside the program`,
    );
  return null;
}

export function checkCodeStackOverlap(codeEnd: number, stackBase: number): AppError | null {
  if (codeEnd > stackBase)
    return new AppError(
      `Code section ends at ${hx(codeEnd)}, overlapping stack base ${hx(stackBase)}`,
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
        `memoryRegions[${ri}] (${hx(r.addr)}–${hx(rEnd - 1)}) overlaps the code segment (${hx(progStart)}–${hx(progEnd - 1)})`,
      );
  }
  return null;
}

// ── Umbrella functions ─────────────────────────────────────────────────────

export function validateProgram(prog: Program): AppError | null {
  let err: AppError | null;

  err = checkU32(prog.baseAddress, "baseAddress");
  if (err) return err;

  if (prog.stackBase != null) {
    err = checkU32(prog.stackBase, "stackBase");
    if (err) return err;
  }

  for (const [reg, val] of Object.entries(prog.initialRegs)) {
    if (val >>> 0 !== val)
      return new AppError(
        `Initial register ${reg} = 0x${val.toString(16).toUpperCase()} does not fit in 32 bits`,
      );
  }

  if (prog.osMode !== false) {
    const stackBase = prog.stackBase ?? 0xc0000000;
    err = checkSpStackBase(prog.initialRegs.sp ?? 0, stackBase);
    if (err) return err;
  }

  const regions = prog.memoryRegions ?? [];
  for (let ri = 0; ri < regions.length; ri++) {
    err = checkRegionElements(regions[ri]!, ri);
    if (err) return err;
  }

  const stackBase = prog.stackBase ?? 0xc0000000;
  const sp = prog.initialRegs.sp ?? stackBase;
  err = checkRegionStackOverlap(regions, sp, stackBase);
  if (err) return err;

  return checkRegionRegionOverlap(regions);
}

export function validateAssembled(prog: Program, assembled: AssemblyResult): AppError | null {
  const { sourceInstrs, labels } = assembled;
  const progStart = prog.baseAddress;
  const lastSi = sourceInstrs[sourceInstrs.length - 1];
  const progEnd = lastSi ? lastSi.firstAddr + lastSi.concretes.length * 4 : progStart;
  const stackBase = prog.stackBase ?? 0xc0000000;

  let err: AppError | null;

  if (prog.entryPoint) {
    err = checkEntryPoint(prog.entryPoint, labels);
    if (err) return err;
  }

  err = checkRaRange(prog.initialRegs.ra ?? 0, progStart, progEnd);
  if (err) return err;

  err = checkCodeStackOverlap(progEnd, stackBase);
  if (err) return err;

  return checkRegionCodeOverlap(prog.memoryRegions ?? [], progStart, progEnd);
}

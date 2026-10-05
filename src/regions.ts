import { AppError } from "./types";
import type { MemoryRegion, Program, ResolvedRegion } from "./types";
import type { Isa } from "./isa/types";
import type { Value } from "./ctypes";
import { parseTypes, parseDecl, buildTree, sizeOf } from "./ctypes";

const LEGACY_TYPES = { 1: "unsigned char", 2: "unsigned short", 4: "int" } as const;

/** The declaration and initializer of a region, converting legacy regions. */
export function regionDecl(r: MemoryRegion, ri: number): { decl: string; init?: Value } {
  if ("decl" in r) return { decl: r.decl, init: r.init };
  return {
    decl: `${LEGACY_TYPES[r.elementSize]} region${ri}[${r.elements.length}]`,
    init: r.elements,
  };
}

/** Parses the program's types and every region's declaration and initializer. */
export function resolveRegions(prog: Program, isa: Isa): ResolvedRegion[] | AppError {
  const regions = prog.memoryRegions ?? [];
  if (regions.length === 0) return [];
  const env = parseTypes(prog.types ?? "", isa.wordBytes);
  if (env instanceof AppError) return new AppError(`types: ${env.message}`);

  const out: ResolvedRegion[] = [];
  for (let ri = 0; ri < regions.length; ri++) {
    const r = regions[ri]!;
    const { decl, init } = regionDecl(r, ri);
    const d = parseDecl(decl, env, isa.wordBytes);
    if (d instanceof AppError) return new AppError(`memoryRegions[${ri}]: ${d.message}`);
    if (out.some((o) => o.name === d.name))
      return new AppError(`memoryRegions[${ri}]: duplicate region name "${d.name}"`);
    const root = buildTree(d.name, d.type, init, r.addr, env, isa.wordBytes);
    if (root instanceof AppError) return new AppError(`memoryRegions[${ri}]: ${root.message}`);
    out.push({ name: d.name, addr: r.addr, type: d.type, size: sizeOf(d.type, env, isa.wordBytes), root });
  }
  return out;
}

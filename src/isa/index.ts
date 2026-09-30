import type { Isa, IsaId } from "./types";
import { rv32 } from "./rv32";
import { x86 } from "./x86";

const ISAS: Record<IsaId, Isa> = { rv32, x86 };

export function getIsa(id: IsaId = "rv32"): Isa {
  return ISAS[id];
}

export const ISA_IDS = Object.keys(ISAS) as IsaId[];

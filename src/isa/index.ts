import type { Isa, IsaId } from "./types";
import { rv32 } from "./rv32";

const ISAS: Record<IsaId, Isa> = { rv32 };

export function getIsa(id: IsaId = "rv32"): Isa {
  return ISAS[id];
}

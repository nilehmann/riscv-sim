import type { AssemblyResult, DisplayReg, FrameInfo, Program, Step } from "./types";
import { AppError, hx } from "./types";
import { assembleProgram } from "./assembler";
import { validateProgram, validateAssembled } from "./validation";
import { ALL_REGS, REG_META, garbageValue, simulate } from "./simulator";
import { inferDisplayState } from "./inferDisplay";
import { PROGRAMS } from "./programs";

// ─── Helpers ──────────────────────────────────────────────────────────────

function computeDisplayRegs(
  prog: Program,
  assembled: AssemblyResult,
): DisplayReg[] {
  const { sourceInstrs } = assembled;
  const used = new Set<string>();
  for (const r of Object.keys(prog.initialRegs)) used.add(r);
  for (const si of sourceInstrs) {
    for (const c of si.concretes) {
      for (const field of ["rd", "rs1", "rs2"] as const) {
        const val = (c as Record<string, unknown>)[field];
        if (typeof val === "string" && REG_META[val as keyof typeof REG_META])
          used.add(val);
      }
    }
  }
  return ALL_REGS.filter((r) => used.has(r)).map((r) => ({
    name: r,
    desc: REG_META[r as keyof typeof REG_META]?.desc ?? "",
    key: r,
  }));
}

// ─── UIState ─────────────────────────────────────────────────────────────
// Visual toggles and transient UI state that is independent of the simulation.

export class UIState {
  activeTab = $state<"asm" | "c">("asm");
  showFp = $state(false);
  /** Suppresses the CSS transition on the first sp-arrow render. Reset on program load. */
  firstArrowRender = $state(true);
  /** Suppresses the CSS transition on the first fp-arrow render. Reset when fp is toggled on. */
  firstFpArrowRender = $state(true);
  selectorOpen = $state(false);
  slotViewMode = $state<Map<string, 'word' | 'halfword' | 'byte'>>(new Map());
  showGarbage = $state(true);
  theme = $state<'light' | 'dark' | 'system'>(
    (localStorage.getItem('theme') as 'light' | 'dark' | 'system') ?? 'system'
  );
  showSettings = $state(false);
  showEditor = $state(false);
  vimMode = $state<boolean>(localStorage.getItem("vimMode") === "true");
}

export const ui = new UIState();

// ─── SimulationState ──────────────────────────────────────────────────────
// Owns the loaded program, assembled code, simulation steps, and navigation.

export class SimulationState {
  // ── Core state ──
  program = $state<Program | null>(null);
  assembled = $state<AssemblyResult | null>(null);
  steps = $state<Step[]>([]);
  /** Concrete step index of the last concrete instr for source[i]. sourcePositions[0]=0, then sourceToConcrete values. */
  sourcePositions = $state<number[]>([]);
  displayRegs = $state<DisplayReg[]>([]);
  callFramesByStep = $state<FrameInfo[][]>([]);
  slotLabelsByStep = $state<Map<number, string>[]>([]);
  inferError = $state<{ step: number; message: string } | null>(null);
  cur = $state(0);
  asmMode = $state<"source" | "assembled">("source");
  loadError = $state<AppError | null>(null);

  // ── Derived navigation ──
  currentSourcePosIdx = $derived.by(() => {
    let p = 0;
    for (let i = this.sourcePositions.length - 1; i >= 0; i--) {
      if (this.sourcePositions[i]! <= this.cur) {
        p = i;
        break;
      }
    }
    return p;
  });

  posIdx = $derived(
    this.asmMode === "source" ? this.currentSourcePosIdx : this.cur,
  );

  total = $derived(
    this.asmMode === "source" ? this.sourcePositions.length : this.steps.length,
  );

  progress = $derived(
    this.total <= 1 ? 100 : (this.posIdx / (this.total - 1)) * 100,
  );

  currentStep = $derived(this.steps[this.cur] ?? null);
  currentCallFrames = $derived(this.callFramesByStep[this.cur] ?? []);
  currentSlotLabels = $derived(this.slotLabelsByStep[this.cur] ?? new Map<number, string>());
  stackEnabled = $derived(this.program?.showStack !== false);

  // ── Actions ──

  goTo(idx: number): void {
    const max = this.inferError ? this.inferError.step : this.steps.length - 1;
    this.cur = Math.max(0, Math.min(max, idx));
  }

  go(dir: number): void {
    if (this.asmMode === "assembled") {
      this.goTo(this.cur + dir);
      return;
    }
    const p = this.currentSourcePosIdx;
    const newP = Math.max(
      0,
      Math.min(this.sourcePositions.length - 1, p + dir),
    );
    this.goTo(this.sourcePositions[newP]!);
  }

  scrubTo(ratio: number): void {
    if (this.asmMode === "source") {
      const posIdx = Math.round(ratio * (this.sourcePositions.length - 1));
      this.goTo(this.sourcePositions[posIdx]!);
    } else {
      this.goTo(Math.round(ratio * (this.steps.length - 1)));
    }
  }

  switchAsmMode(mode: "source" | "assembled"): void {
    this.asmMode = mode;
    if (mode === "source") {
      // Snap cur down to the nearest source boundary
      this.cur = this.sourcePositions[this.currentSourcePosIdx]!;
    }
  }

  loadProgram(prog: Program): void {
    this.loadError = null;

    this.loadError = validateProgram(prog);
    if (this.loadError) return;

    const assembled = assembleProgram(prog);
    if (assembled instanceof AppError) {
      this.loadError = assembled;
      return;
    }

    this.loadError = validateAssembled(prog, assembled);
    if (this.loadError) return;

    const { steps, sourceToConcrete } = simulate(prog, assembled);
    const { callFramesByStep, slotLabelsByStep, error } = inferDisplayState(steps, assembled, prog);

    this.program = prog;
    this.assembled = assembled;
    this.steps = steps;
    this.callFramesByStep = callFramesByStep;
    this.slotLabelsByStep = slotLabelsByStep;
    this.inferError = error;
    this.sourcePositions = [0, ...sourceToConcrete];
    this.displayRegs = computeDisplayRegs(prog, assembled);
    this.cur = 0;
    this.asmMode = "source";
    ui.activeTab = "asm";
    ui.firstArrowRender = true;
    ui.slotViewMode = new Map();
  }
}

export const sim = new SimulationState();

// ─── Deterministic garbage register values for uninitialized display ───────

export const RAND_REGS: Record<string, string> = Object.fromEntries(
  ALL_REGS.map((r, i) => [r, r === "zero" ? hx(0) : hx(garbageValue(i))]),
);

export function fmtRegVal(key: string, val: number | null | undefined): string {
  if (val == null) return RAND_REGS[key] ?? "?";
  return hx(val);
}

// ─── Load the first program immediately ───────────────────────────────────
sim.loadProgram(PROGRAMS[0]!);

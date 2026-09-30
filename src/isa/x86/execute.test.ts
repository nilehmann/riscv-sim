import { describe, test, expect } from "vitest";
import { x86 } from "./index";
import { assembleProgram } from "../../assembler";
import { simulate } from "../../simulator";
import { inferDisplayState } from "../../inferDisplay";
import { AppError } from "../../types";
import type { Program } from "../../types";

const SP = 0x7fffffffef08;

function load(assembly: string, extra: Partial<Program> = {}) {
  const prog: Program = {
    name: "t", isa: "x86", baseAddress: 0x401000, assembly,
    initialRegs: { rsp: SP }, ...extra,
  };
  const assembled = assembleProgram(prog);
  if (assembled instanceof AppError) throw new Error(assembled.message);
  const result = simulate(prog, assembled);
  return { prog, assembled, ...result };
}

/** Final register values. */
function run(assembly: string, extra: Partial<Program> = {}) {
  const { steps } = load(assembly, extra);
  return steps[steps.length - 1]!.regs;
}

const flag = (regs: Record<string, bigint>, name: string) => {
  const bit = x86.flags!.bits.find((b) => b.name === name)!.bit;
  return Number((regs.rflags! >> BigInt(bit)) & 1n);
};

describe("registers", () => {
  test("writing a 32-bit register zeroes the upper half", () => {
    expect(run("mov rax, -1\nmov eax, 5").rax).toBe(5n);
  });
  test("64-bit arithmetic wraps", () => {
    expect(run("mov rax, -1\nadd rax, 2").rax).toBe(1n);
  });
  test("32-bit arithmetic wraps at 32 bits", () => {
    expect(run("mov eax, -1\nadd eax, 2").rax).toBe(1n);
  });
  test("setcc only writes the low byte", () => {
    expect(run("mov eax, 0x1234\ncmp eax, eax\nsete al").rax).toBe(0x1201n);
  });
  test("movzx and movsx", () => {
    const regs = run("mov eax, 0xff\nmovzx ecx, al\nmovsx edx, al\nmovsx rbx, al");
    expect(regs.rcx).toBe(0xffn);
    expect(regs.rdx).toBe(0xffffffffn);
    expect(regs.rbx).toBe(0xffffffffffffffffn);
  });
  test("movsx from a 32-bit source, cdqe", () => {
    const regs = run("mov edi, -2\nmovsx rdx, edi\nmov eax, -3\ncdqe");
    expect(regs.rdx).toBe(BigInt.asUintN(64, -2n));
    expect(regs.rax).toBe(BigInt.asUintN(64, -3n));
  });
  test("lea computes base + index*scale + disp", () => {
    expect(run("mov rax, 10\nmov rcx, 3\nlea rdx, [rax+rcx*4-2]").rdx).toBe(20n);
  });
});

describe("arithmetic", () => {
  test("imul forms", () => {
    const regs = run("mov eax, 6\nmov ecx, 7\nimul eax, ecx\nimul edx, ecx, -2\nimul ecx, 3");
    expect(regs.rax).toBe(42n);
    expect(regs.rdx).toBe(BigInt.asUintN(32, -14n));
    expect(regs.rcx).toBe(21n);
  });
  test("idiv: quotient in eax, remainder in edx", () => {
    const regs = run("mov eax, -17\ncdq\nmov ecx, 5\nidiv ecx");
    expect(regs.rax).toBe(BigInt.asUintN(32, -3n));
    expect(regs.rdx).toBe(BigInt.asUintN(32, -2n));
  });
  test("64-bit idiv uses rdx:rax", () => {
    const regs = run("mov rax, 100\ncqo\nmov rcx, 7\nidiv rcx");
    expect(regs.rax).toBe(14n);
    expect(regs.rdx).toBe(2n);
  });
  test("division by zero faults", () => {
    const { steps } = load("mov eax, 1\ncdq\nmov ecx, 0\nidiv ecx\nmov eax, 9");
    expect(steps[steps.length - 1]!.fault).toEqual({ type: "divide" });
  });
  test("shifts", () => {
    const regs = run("mov eax, -8\nsar eax, 1\nmov ebx, -8\nshr ebx, 28\nmov edx, 3\nmov ecx, 4\nshl edx, cl");
    expect(regs.rax).toBe(BigInt.asUintN(32, -4n));
    expect(regs.rbx).toBe(0xfn);
    expect(regs.rdx).toBe(48n);
  });
  test("neg, not, inc, dec", () => {
    const regs = run("mov eax, 5\nneg eax\nmov ecx, 0\nnot ecx\nmov edx, 7\ninc edx\ndec edx\ndec edx");
    expect(regs.rax).toBe(BigInt.asUintN(32, -5n));
    expect(regs.rcx).toBe(0xffffffffn);
    expect(regs.rdx).toBe(6n);
  });
});

describe("flags and conditions", () => {
  test("cmp sets ZF, SF, CF, OF", () => {
    let regs = run("mov eax, 5\ncmp eax, 5");
    expect([flag(regs, "ZF"), flag(regs, "SF"), flag(regs, "CF"), flag(regs, "OF")]).toEqual([1, 0, 0, 0]);
    regs = run("mov eax, 3\ncmp eax, 5");
    expect([flag(regs, "ZF"), flag(regs, "SF"), flag(regs, "CF"), flag(regs, "OF")]).toEqual([0, 1, 1, 0]);
    regs = run("mov eax, 0x7fffffff\nadd eax, 1");
    expect([flag(regs, "ZF"), flag(regs, "SF"), flag(regs, "CF"), flag(regs, "OF")]).toEqual([0, 1, 0, 1]);
  });
  test("inc keeps CF", () => {
    const regs = run("mov eax, -1\nadd eax, 1\ninc eax");
    expect(flag(regs, "CF")).toBe(1);
    expect(flag(regs, "ZF")).toBe(0);
  });
  test("mov does not touch flags", () => {
    const { steps } = load("mov eax, 0\ncmp eax, 0\nmov eax, 7");
    expect(steps[2]!.hiReg).toContain("rflags");
    expect(steps[3]!.hiReg).not.toContain("rflags");
    expect(flag(steps[3]!.regs, "ZF")).toBe(1);
  });

  const branch = (setup: string, jcc: string) =>
    run(`${setup}\n  ${jcc} taken\n  mov eax, 1\n  jmp end\ntaken:\n  mov eax, 2\nend:`).rax;
  test("jl is signed", () => expect(branch("mov ecx, -1\ncmp ecx, 1", "jl")).toBe(2n));
  test("jb is unsigned", () => expect(branch("mov ecx, -1\ncmp ecx, 1", "jb")).toBe(1n));
  test("ja is unsigned", () => expect(branch("mov ecx, -1\ncmp ecx, 1", "ja")).toBe(2n));
  test("jge on equal", () => expect(branch("mov ecx, 4\ncmp ecx, 4", "jge")).toBe(2n));
  test("jne on equal", () => expect(branch("mov ecx, 4\ncmp ecx, 4", "jne")).toBe(1n));
  test("test + jz", () => expect(branch("mov ecx, 0\ntest ecx, ecx", "jz")).toBe(2n));
  test("jle with overflow", () =>
    expect(branch("mov ecx, 0x80000000\ncmp ecx, 1", "jle")).toBe(2n));
});

// gcc -O0 output for:
//   int sum(int n) { int s = 0; for (int i = 0; i < n; i++) s += i; return s; }
//   int main() { return sum(10); }
const SUM = `
sum:
    push rbp
    mov rbp, rsp
    mov DWORD PTR [rbp-20], edi
    mov DWORD PTR [rbp-4], 0
    mov DWORD PTR [rbp-8], 0
    jmp .L2
.L3:
    mov eax, DWORD PTR [rbp-8]
    add DWORD PTR [rbp-4], eax
    add DWORD PTR [rbp-8], 1
.L2:
    mov eax, DWORD PTR [rbp-8]
    cmp eax, DWORD PTR [rbp-20]
    jl .L3
    mov eax, DWORD PTR [rbp-4]
    pop rbp
    ret
main:
    push rbp
    mov rbp, rsp
    mov edi, 10
    call sum
    pop rbp
    ret`;

describe("stack and calls", () => {
  test("push, pop and leave", () => {
    const regs = run("mov rax, 7\npush rax\npop rcx\npush rbp\nmov rbp, rsp\nsub rsp, 32\nleave");
    expect(regs.rcx).toBe(7n);
    expect(regs.rsp).toBe(BigInt(SP));
  });

  test("call pushes the return address and ret pops it", () => {
    const { steps, assembled } = load("main:\n  call f\n  mov eax, 1\nf:\n  ret", { entryPoint: "main" });
    const afterCall = steps[1]!;
    expect(afterCall.regs.rsp).toBe(BigInt(SP - 8));
    expect(afterCall.nextAddr).toBe(assembled.labels.f);
    expect(afterCall.store).toEqual({ addr: SP - 8, reg: "ret addr", size: 8 });
    // ret lands on the instruction after the call
    expect(steps[2]!.nextAddr).toBe(assembled.labels.main! + 5);
    expect(steps[2]!.regs.rsp).toBe(BigInt(SP));
  });

  test("leaf function using the red zone does not fault", () => {
    const { steps } = load(SUM, { entryPoint: "main" });
    expect(steps.every((s) => !s.fault)).toBe(true);
    expect(steps[steps.length - 1]!.regs.rax).toBe(45n);
  });

  test("access below the red zone faults", () => {
    const { steps } = load("mov DWORD PTR [rsp-132], 1");
    expect(steps[steps.length - 1]!.fault).toEqual({ type: "segfault", addr: SP - 132 });
  });

  test("the program ends when the entry function returns", () => {
    const { steps, initialReturnAddr } = load(SUM, { entryPoint: "main", returnAddress: 0x400000 });
    expect(initialReturnAddr).toBe(0x400000);
    expect(steps[steps.length - 1]!.nextAddr).toBe(0x400000);
  });

  test("frames: the return address belongs to the callee", () => {
    const { steps, assembled, prog, initialReturnAddr, initialSlotLabels } = load(SUM, { entryPoint: "main" });
    const d = inferDisplayState(steps, assembled, prog, x86, initialReturnAddr, initialSlotLabels);
    expect(d.error).toBeNull();
    expect(d.slotLabelsByStep[0]!.get(SP)).toEqual({ name: "ret addr", size: 8 });
    // Before the first instruction, main's frame is just its return address.
    expect(d.callFramesByStep[0]![0]).toMatchObject({ entrySpBefore: SP + 8, allocatedSize: 8 });

    // Step right after `call sum`.
    const i = steps.findIndex((s) => s.control?.kind === "call");
    const frames = d.callFramesByStep[i]!;
    expect(frames.map((f) => f.label)).toEqual(["main", "sum"]);
    // main's frame starts above its own return address and also holds saved rbp.
    expect(frames[0]!.entrySpBefore).toBe(SP + 8);
    expect(frames[0]!.allocatedSize).toBe(16);
    // sum's frame starts at the return address pushed by the call.
    expect(frames[1]!.entrySpBefore).toBe(SP - 8);
    expect(frames[1]!.allocatedSize).toBe(8);
    expect(d.slotLabelsByStep[i]!.get(SP - 16)).toEqual({ name: "ret addr", size: 8 });

    // Locals of sum live below rsp, in the red zone.
    const inLoop = d.callFramesByStep.findIndex((fs) => fs.length === 2 && fs[1]!.lowWrite !== undefined);
    expect(d.callFramesByStep[inLoop]![1]!.lowWrite).toBe(SP - 24 - 20);
    // A 4-byte store labels half a slot.
    expect(d.slotLabelsByStep[inLoop]!.get(SP - 24 - 20)).toEqual({ name: "edi", size: 4 });

    // After the last ret there is one frame and no error.
    expect(d.callFramesByStep[steps.length - 1]!.map((f) => f.label)).toEqual(["main"]);
  });
});

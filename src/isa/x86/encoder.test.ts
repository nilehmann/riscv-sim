import { describe, test, expect } from "vitest";
import { x86 } from "./index";
import type { Instr } from "./types";
import { assembleProgram } from "../../assembler";
import { AppError } from "../../types";

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");

function encode(line: string) {
  const p = x86.parseInstr(line);
  if (p instanceof AppError) throw new Error(`${line}: ${p.message}`);
  const r = x86.expand(p, { addr: 0, labels: {}, raw: line, lineLabels: [] });
  if (r instanceof AppError) throw new Error(`${line}: ${r.message}`);
  return r[0]!.enc;
}

// Reference bytes from GNU as (`.intel_syntax noprefix`).
const CASES: Array<[string, string]> = [
  ["mov eax, 1", "b8 01 00 00 00"],
  ["mov eax, -1", "b8 ff ff ff ff"],
  ["mov eax, 0xffffffff", "b8 ff ff ff ff"],
  ["mov rax, 1", "48 c7 c0 01 00 00 00"],
  ["mov rax, -1", "48 c7 c0 ff ff ff ff"],
  ["mov rax, 0x123456789", "48 b8 89 67 45 23 01 00 00 00"],
  ["mov r10, 0x7fffffff", "49 c7 c2 ff ff ff 7f"],
  ["mov r10, 0x80000000", "49 ba 00 00 00 80 00 00 00 00"],
  ["movabs rax, 5", "48 b8 05 00 00 00 00 00 00 00"],
  ["mov r8d, 100", "41 b8 64 00 00 00"],
  ["mov eax, edi", "89 f8"],
  ["mov rbp, rsp", "48 89 e5"],
  ["mov r12, rax", "49 89 c4"],
  ["mov eax, r9d", "44 89 c8"],
  ["mov DWORD PTR [rbp-4], edi", "89 7d fc"],
  ["mov QWORD PTR [rbp-24], rdi", "48 89 7d e8"],
  ["mov eax, DWORD PTR [rbp-4]", "8b 45 fc"],
  ["mov rax, QWORD PTR [rbp-24]", "48 8b 45 e8"],
  ["mov DWORD PTR [rbp-4], 0", "c7 45 fc 00 00 00 00"],
  ["mov QWORD PTR [rbp-8], 42", "48 c7 45 f8 2a 00 00 00"],
  ["mov DWORD PTR [rbp-200], 5", "c7 85 38 ff ff ff 05 00 00 00"],
  ["mov eax, DWORD PTR [rax]", "8b 00"],
  ["mov eax, DWORD PTR [rbp]", "8b 45 00"],
  ["mov eax, DWORD PTR [rsp]", "8b 04 24"],
  ["mov eax, DWORD PTR [rsp+8]", "8b 44 24 08"],
  ["mov eax, DWORD PTR [r12]", "41 8b 04 24"],
  ["mov eax, DWORD PTR [r13]", "41 8b 45 00"],
  ["mov eax, DWORD PTR [r13+4]", "41 8b 45 04"],
  ["mov eax, DWORD PTR [rax+rdx*4]", "8b 04 90"],
  ["mov eax, DWORD PTR [rbp+rax*4-48]", "8b 44 85 d0"],
  ["mov eax, DWORD PTR [0+rax*4]", "8b 04 85 00 00 00 00"],
  ["mov eax, DWORD PTR [rax+rax]", "8b 04 00"],
  ["mov eax, DWORD PTR [r8+r9*8+1000]", "43 8b 84 c8 e8 03 00 00"],
  ["mov edx, DWORD PTR [rdx+rax]", "8b 14 02"],
  ["mov DWORD PTR [rax+rcx*8], edx", "89 14 c8"],
  ["mov rax, QWORD PTR [rsp+r15*2]", "4a 8b 04 7c"],
  ["mov eax, DWORD PTR [4096]", "8b 04 25 00 10 00 00"],
  ["mov DWORD PTR -4[rbp], edi", "89 7d fc"],
  ["lea rax, [rbp-16]", "48 8d 45 f0"],
  ["lea eax, [rdi+rsi]", "8d 04 37"],
  ["lea rdx, [0+rax*4]", "48 8d 14 85 00 00 00 00"],
  ["lea eax, [rax+rax*2]", "8d 04 40"],
  ["add eax, 1", "83 c0 01"],
  ["add eax, 1000", "05 e8 03 00 00"],
  ["add ebx, 1000", "81 c3 e8 03 00 00"],
  ["add rax, 1000", "48 05 e8 03 00 00"],
  ["add rsp, 16", "48 83 c4 10"],
  ["sub rsp, 16", "48 83 ec 10"],
  ["sub rsp, 200", "48 81 ec c8 00 00 00"],
  ["add eax, edx", "01 d0"],
  ["add rax, rdx", "48 01 d0"],
  ["add eax, DWORD PTR [rbp-4]", "03 45 fc"],
  ["add DWORD PTR [rbp-4], 1", "83 45 fc 01"],
  ["add DWORD PTR [rbp-4], eax", "01 45 fc"],
  ["add QWORD PTR [rbp-8], 1", "48 83 45 f8 01"],
  ["sub eax, DWORD PTR [rbp-8]", "2b 45 f8"],
  ["and eax, 15", "83 e0 0f"],
  ["and rsp, -16", "48 83 e4 f0"],
  ["or eax, ebx", "09 d8"],
  ["or edx, 0x100", "81 ca 00 01 00 00"],
  ["xor eax, eax", "31 c0"],
  ["xor r8d, r8d", "45 31 c0"],
  ["xor eax, 0xffffffff", "83 f0 ff"],
  ["cmp eax, 9", "83 f8 09"],
  ["cmp DWORD PTR [rbp-4], 9", "83 7d fc 09"],
  ["cmp eax, DWORD PTR [rbp-8]", "3b 45 f8"],
  ["cmp rdi, rsi", "48 39 f7"],
  ["cmp eax, 1000", "3d e8 03 00 00"],
  ["cmp edi, 1000", "81 ff e8 03 00 00"],
  ["test eax, eax", "85 c0"],
  ["test rdi, rdi", "48 85 ff"],
  ["test eax, 1", "a9 01 00 00 00"],
  ["test edi, 1", "f7 c7 01 00 00 00"],
  ["test DWORD PTR [rbp-4], eax", "85 45 fc"],
  ["test eax, DWORD PTR [rbp-4]", "85 45 fc"],
  ["inc eax", "ff c0"],
  ["dec DWORD PTR [rbp-4]", "ff 4d fc"],
  ["inc r10", "49 ff c2"],
  ["not eax", "f7 d0"],
  ["neg rax", "48 f7 d8"],
  ["neg DWORD PTR [rbp-4]", "f7 5d fc"],
  ["idiv ecx", "f7 f9"],
  ["idiv DWORD PTR [rbp-8]", "f7 7d f8"],
  ["idiv r9", "49 f7 f9"],
  ["imul eax, edx", "0f af c2"],
  ["imul eax, DWORD PTR [rbp-4]", "0f af 45 fc"],
  ["imul rax, rdx", "48 0f af c2"],
  ["imul eax, eax, 5", "6b c0 05"],
  ["imul eax, edx, 1000", "69 c2 e8 03 00 00"],
  ["imul eax, 5", "6b c0 05"],
  ["imul r9, QWORD PTR [rbp-8], 7", "4c 6b 4d f8 07"],
  ["shl eax, 1", "d1 e0"],
  ["shl eax", "d1 e0"],
  ["shl eax, 4", "c1 e0 04"],
  ["sal eax, 2", "c1 e0 02"],
  ["shr rax, 3", "48 c1 e8 03"],
  ["sar eax, 31", "c1 f8 1f"],
  ["sar eax, cl", "d3 f8"],
  ["shl DWORD PTR [rbp-4], 2", "c1 65 fc 02"],
  ["shr r11, cl", "49 d3 eb"],
  ["cdq", "99"],
  ["cqo", "48 99"],
  ["cdqe", "48 98"],
  ["leave", "c9"],
  ["ret", "c3"],
  ["nop", "90"],
  ["push rbp", "55"],
  ["push r12", "41 54"],
  ["push 1", "6a 01"],
  ["push 1000", "68 e8 03 00 00"],
  ["push QWORD PTR [rbp-8]", "ff 75 f8"],
  ["pop rbp", "5d"],
  ["pop r15", "41 5f"],
  ["pop QWORD PTR [rax]", "8f 00"],
  ["call rax", "ff d0"],
  ["call QWORD PTR [rax+8]", "ff 50 08"],
  ["jmp rax", "ff e0"],
  ["jmp r11", "41 ff e3"],
  ["sete al", "0f 94 c0"],
  ["setl al", "0f 9c c0"],
  ["setg dl", "0f 9f c2"],
  ["setne sil", "40 0f 95 c6"],
  ["setle r8b", "41 0f 9e c0"],
  ["setb BYTE PTR [rbp-1]", "0f 92 45 ff"],
  ["movzx eax, al", "0f b6 c0"],
  ["movzx eax, BYTE PTR [rbp-1]", "0f b6 45 ff"],
  ["movzx eax, WORD PTR [rbp-2]", "0f b7 45 fe"],
  ["movzx edx, dil", "40 0f b6 d7"],
  ["movzx eax, ax", "0f b7 c0"],
  ["movsx eax, al", "0f be c0"],
  ["movsx eax, BYTE PTR [rbp-1]", "0f be 45 ff"],
  ["movsx rax, BYTE PTR [rbp-1]", "48 0f be 45 ff"],
  ["movsx eax, WORD PTR [rax]", "0f bf 00"],
  ["movsx rdx, eax", "48 63 d0"],
  ["movsxd rdx, eax", "48 63 d0"],
  ["movsx rax, DWORD PTR [rbp-4]", "48 63 45 fc"],
  ["movzx r9d, r10b", "45 0f b6 ca"],
];

describe("encode", () => {
  test.each(CASES)("%s", (line, bytes) => {
    expect(hex(encode(line).bytes)).toBe(bytes);
  });

  test.each(CASES)("parts of %s cover every byte in order", (line) => {
    const enc = encode(line);
    let next = 0;
    for (const part of enc.parts) {
      expect(part.offset).toBe(next);
      next += part.length;
      if (!part.fields) continue;
      // Bit fields tile the part from its top bit down to bit 0.
      let bit = part.length * 8 - 1;
      for (const f of part.fields) {
        expect(f.hi).toBe(bit);
        bit = f.lo - 1;
      }
      expect(bit).toBe(-1);
    }
    expect(next).toBe(enc.bytes.length);
  });
});

describe("errors", () => {
  const err = (line: string) => expect(x86.parseInstr(line), line).toBeInstanceOf(AppError);
  test("unknown mnemonic", () => err("frobnicate eax"));
  test("mismatched operand sizes", () => err("mov eax, rbx"));
  test("memory operand without a size", () => err("mov [rbp-4], 1"));
  test("two memory operands", () => err("mov DWORD PTR [rax], DWORD PTR [rbx]"));
  test("16-bit operands are not supported", () => err("add ax, bx"));
  test("32-bit register in an address", () => err("mov eax, DWORD PTR [ebp-4]"));
  test("rsp as a scaled index", () => err("mov eax, DWORD PTR [rax+rsp*2]"));
  test("RIP-relative addressing", () => err("lea rax, [rip]"));
  test("immediate too large", () => err("add rax, 0x100000000"));
  test("wrong operand count", () => err("ret eax"));
  test("push of a 32-bit register", () => err("push eax"));
});

// ─── Whole programs: jump sizes must match gas ────────────────────────────

function assemble(assembly: string) {
  const r = assembleProgram({ name: "t", isa: "x86", initialRegs: {}, baseAddress: 0x401000, assembly });
  if (r instanceof AppError) throw new Error(r.message);
  return r;
}
const programBytes = (assembly: string) =>
  assemble(assembly).sourceInstrs.flatMap((si) =>
    si.concretes.flatMap((c) => x86.encode(c.instr as Instr).bytes),
  );
const nops = (n: number) => "  nop\n".repeat(n);

describe("jump relaxation", () => {
  test("gcc -O0 loop uses short jumps", () => {
    expect(hex(programBytes("sum:\n    push rbp\n    mov rbp, rsp\n    mov DWORD PTR [rbp-20], edi\n    mov DWORD PTR [rbp-4], 0\n    mov DWORD PTR [rbp-8], 0\n    jmp .L2\n.L3:\n    mov eax, DWORD PTR [rbp-8]\n    add DWORD PTR [rbp-4], eax\n    add DWORD PTR [rbp-8], 1\n.L2:\n    mov eax, DWORD PTR [rbp-8]\n    cmp eax, DWORD PTR [rbp-20]\n    jl .L3\n    mov eax, DWORD PTR [rbp-4]\n    pop rbp\n    ret\nmain:\n    push rbp\n    mov rbp, rsp\n    mov edi, 10\n    call sum\n    pop rbp\n    ret"))).toBe(
      "55 48 89 e5 89 7d ec c7 45 fc 00 00 00 00 c7 45 f8 00 00 00 00 eb 0a 8b 45 f8 01 45 fc 83 45 f8 01 8b 45 f8 3b 45 ec 7c ee 8b 45 fc 5d c3 55 48 89 e5 bf 0a 00 00 00 e8 c4 ff ff ff 5d c3",
    );
  });

  // The short form reaches -128…+127 bytes from the end of the jump.
  test("forward jump over 127 bytes is short", () =>
    expect(hex(programBytes(`  jmp end\n${nops(127)}end:\n  ret`).slice(0, 2))).toBe("eb 7f"));
  test("forward jump over 128 bytes is near", () =>
    expect(hex(programBytes(`  jmp end\n${nops(128)}end:\n  ret`).slice(0, 5))).toBe("e9 80 00 00 00"));
  test("backward jump of -128 is short", () =>
    expect(hex(programBytes(`top:\n${nops(126)}  jne top\n`).slice(126))).toBe("75 80"));
  test("backward jump of -129 is near", () =>
    expect(hex(programBytes(`top:\n${nops(127)}  jne top\n`).slice(127))).toBe("0f 85 7b ff ff ff"));

  test("two jumps at the limit of the short form both stay short", () => {
    const bytes = programBytes(`  je l1\n${nops(124)}  je l2\nl1:\n${nops(125)}l2:\n  ret`);
    expect(bytes).toHaveLength(254);
  });

  test("call is always rel32", () =>
    expect(hex(programBytes("f:\n  call f"))).toBe("e8 fb ff ff ff"));

  test("undefined label", () => {
    const r = assembleProgram({ name: "t", isa: "x86", initialRegs: {}, baseAddress: 0, assembly: "jmp nowhere" });
    expect(r).toBeInstanceOf(AppError);
    expect((r as AppError).message).toBe("Undefined label 'nowhere'");
  });
});

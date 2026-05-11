import type { Program } from "./types";

export const PROGRAMS: Program[] = [
  {
    name: "baz -> foo",
    cCode: `int foo(int x) {\n    return x + 1;\n}\n\nint baz(int y) {\n    return foo(1) + y;\n}`,
    entryPoint: "baz",
    initialRegs: { sp: 0xbfffff00, ra: 0x8050, a0: 3, s0: 0x54 },
    baseAddress: 0x8000,
    assembly: `\
foo:
    addi a0, a0, 1
    ret

baz:
    addi sp, sp, -16
    sw   ra, 12(sp)
    sw   s0, 8(sp)
    mv   s0, a0
    li   a0, 1
    call foo
    add  a0, a0, s0
    lw   ra, 12(sp)
    lw   s0, 8(sp)
    addi sp, sp, 16
    ret`,
  },
  {
    name: "bar -> foo -> baz",
    entryPoint: "bar",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 3, s0: 0x54 },
    baseAddress: 0x8000,
    assembly: `\
baz:
    add  a0, a0, a1
    ret

foo:
    addi sp, sp, -16
    sw   ra, 12(sp)
    li   a1, 0
    call baz
    addi a0, a0, 1
    lw   ra, 12(sp)
    addi sp, sp, 16
    ret

bar:
    addi sp, sp, -16
    sw   ra, 12(sp)
    sw   s0, 8(sp)
    mv   s0, a0
    li   a0, -1
    call foo
    add  a0, a0, s0
    lw   ra, 12(sp)
    lw   s0, 8(sp)
    addi sp, sp, 16
    ret`,
  },
  {
    name: "load big immediate",
    entryPoint: "foo",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000 },
    baseAddress: 0x8000,
    assembly: `\
foo:
    li  a0, 4097
    ret`,
  },
  {
    name: "forward call (bar → baz)",
    entryPoint: "bar",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 5 },
    baseAddress: 0x8000,
    assembly: `\
bar:
    addi sp, sp, -16
    sw   ra, 12(sp)
    call baz
    lw   ra, 12(sp)
    addi sp, sp, 16
    ret

baz:
    addi a0, a0, 1
    ret`,
  },
  {
    name: "función hoja simple",
    entryPoint: "foo",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 5 },
    baseAddress: 0x8000,
    cCode: `int foo(int x) {\n  return x + 1;\n}`,
    assembly: `\
foo:
    addi a0, a0, 1
    ret`,
  },
  {
    name: "hola",
    entryPoint: "foo",
    initialRegs: { sp: 0xbfffff00, ra: 0x9000, a0: 1 },
    baseAddress: 0x8000,
    cCode: `\
    int foo(int i) {
      int arr[] = {0, 1, 2};
      return arr[i];
    }
    `,
    assembly: `\
    foo:
        addi    sp,sp,-16
        sw      zero,4(sp)
        li      a5,1
        sw      a5,8(sp)
        li      a5,2
        sw      a5,12(sp)
        slli    a0,a0,2
        addi    a5,sp,16
        add     a0,a5,a0
        lw      a0,-12(a0)
        addi    sp,sp,16
        jr      ra`,
  },
];

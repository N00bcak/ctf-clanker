# Anti-Disassembly Techniques

Tricks that break or mislead the disassembler — distinct from anti-debug (which targets the debugger process).

## Junk Bytes
**What**: Insert unreachable bytes after an unconditional jump that look like valid instructions. Linear-sweep disassemblers (objdump) follow them; recursive-descent (IDA/Ghidra) mostly handle them.
```asm
jmp real_code
db 0xE8              ; looks like start of a CALL instruction
real_code:
; actual code here
```
**Fix**: In IDA, press `U` to undefine the junk bytes, then `C` to reanalyze from the correct offset.

## Overlapping Instructions
**What**: A jump targets the middle of an existing instruction, creating two valid interpretations.
```asm
; Bytes: EB 01 E8 ...
; Interpretation 1 (from start): jmp +1 → lands on E8 as start of CALL
; Interpretation 2 (from +1): E8 read differently, produces different instruction
; IDA may show only one interpretation
```
**Fix**: Manually define code at the jump target. In IDA: `G` to jump, `U` to undefine, `C` to recode.

## Opaque Predicates (Anti-Disassembly)
**What**: Conditional jumps with a condition that's always true/false but hard to determine statically. The "false" branch contains junk.
```asm
xor eax, eax
jz always_taken        ; always true, but disassembler analyzes both branches
db 0xFF, 0x25          ; junk in the never-taken branch
always_taken:
; real code
```
**Fix**: Patch the `jz` to `jmp` (or NOP + jmp), or mark the false branch as data.

## Call/Ret Misuse
**What**: `call` pushes return address, then `add [esp], N; ret` pops adjusted address — effectively a computed jump that confuses call-graph analysis.
```asm
call next
next:
add dword [rsp], 5     ; adjust return address
ret                     ; jump to next+5
; IDA thinks 'call next' is a real function call
```
**Fix**: Recognize the pattern, convert to `jmp next+5`.

## Exception-Based Control Flow
**What**: Intentionally trigger exceptions (divide by zero, invalid access, int3) and use the exception handler for actual program logic.
```asm
; Install SEH handler (Windows)
push handler_addr
push dword [fs:0]
mov [fs:0], esp

xor ecx, ecx
div ecx                ; triggers EXCEPTION_INT_DIVIDE_BY_ZERO
; execution continues at handler_addr, not the next instruction
```
**Fix**: Set breakpoint in the exception handler. In GDB: `catch signal SIGFPE`. In x64dbg: Debug → Exceptions → break on division by zero.

## Indirect Jumps / Computed Addresses
**What**: Jump target computed at runtime — disassembler can't follow.
```asm
lea rax, [rip + table]
movzx ecx, byte [rdi]         ; index from input
mov rax, [rax + rcx*8]        ; load function pointer from table
jmp rax                        ; computed jump
```
**Fix**: Set breakpoint on the `jmp` and observe actual targets dynamically. In IDA, convert the table to a function pointer array.

## Data in Code Sections
**What**: Large data blobs (strings, lookup tables, encrypted payloads) embedded in .text section, confusing the disassembler.
**Fix**: Select the region, press `D` (IDA) to convert to data. Or `db`/`dd`/`dq` to define the correct data type.

## Metamorphic / Polymorphic Code
**What**: Code rewrites itself on each execution — different instructions, same behavior.
- **Polymorphic**: encrypted body + varying decryptor stub.
- **Metamorphic**: instruction substitution (e.g., `add eax,1` ↔ `sub eax,-1` ↔ `inc eax`).

**Fix**: For polymorphic: break after decryption, dump decrypted code. For metamorphic: trace dynamically, ignore the specific instructions and focus on data flow.

## Function Chunking
**What**: A single function split across non-contiguous address ranges with jumps between chunks.
**Fix**: In IDA: right-click → Append function tail. In Ghidra: manually merge chunks into one function.

## Deliberate Misalignment
**What**: ARM Thumb-mode switching, or x86 code starting at odd alignment to confuse tools that assume instruction alignment.
**Fix**: ARM: check the LSB of branch targets (1 = Thumb). x86: redefine code at the actual execution offset.

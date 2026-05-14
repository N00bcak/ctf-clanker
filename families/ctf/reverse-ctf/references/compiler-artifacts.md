# Compiler Artifacts & Patterns

## Calling Conventions
| ABI | Args | Return | Callee-Saved | Notes |
|---|---|---|---|---|
| x86-64 SysV (Linux/Mac) | rdi,rsi,rdx,rcx,r8,r9 | rax | rbx,rbp,r12-r15 | 16-byte stack align at CALL; 128-byte red zone |
| x86-64 MS (Windows) | rcx,rdx,r8,r9 | rax | rbx,rbp,rdi,rsi,r12-r15 | 32-byte shadow space; no red zone |
| x86-32 cdecl | stack (R→L push) | eax | ebx,ebp,esi,edi | Caller cleans stack |
| ARM32 | r0-r3 | r0 | r4-r11 | LR=r14 |
| ARM64 | x0-x7 | x0 | x19-x28 | LR=x30 |

## Prologue/Epilogue
```asm
; Standard x86-64:  push rbp; mov rbp,rsp; sub rsp,N  ...  leave; ret
; Leaf function:    sub rsp,N  ...  add rsp,N; ret  (no frame pointer)
```

## Optimization Tells
| Pattern in ASM | What the Compiler Did |
|---|---|
| `imul rax, magic; shr rdx, K` | Division by constant → multiply+shift |
| `and eax, 7` | Modulo by power of 2 |
| Repeated similar blocks | Loop unrolling |
| `jmp func` instead of `call func; ret` | Tail call optimization |
| `movdqu xmm0,[rsi]; pxor xmm0,xmm1` | SIMD vectorization of byte loop |
| No CALL for a small helper | Function inlined |

## Recognizing Crypto Constants
| Constants | Algorithm |
|---|---|
| `0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476` | MD5 init |
| `0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A` | SHA-256 init |
| `0x63, 0x7C, 0x77, 0x7B, ...` (256 bytes) | AES S-box |
| `0x01000000, 0x02000000, ...` (10 values) | AES Rcon |
| `0x5A827999` | SHA-1 round constant K₀ |
| `0x61707865` ("expa") | ChaCha20 / Salsa20 |

## Switch Statement
**Jump table**: `cmp eax,MAX; ja default; lea rcx,[rip+table]; movsxd rax,[rcx+rax*4]; add rax,rcx; jmp rax`
**Binary search**: nested `cmp`/`jl`/`jg` — for sparse case values.

## Virtual Call (C++)
```asm
mov rax, [rdi]          ; load vtable ptr from object
call [rax + 0x10]       ; vtable[2] (3rd virtual function)
; rdi = this pointer
```

## Struct Field Access
```asm
mov rax, [rbx + 0x10]   ; field at offset 0x10
mov ecx, [rbx + 0x18]   ; field at offset 0x18
; Offsets reveal struct layout
```

## Compiler-Specific
| Indicator | Compiler |
|---|---|
| `endbr64` at entries | GCC/Clang with CET |
| `__stack_chk_fail` | GCC stack protector |
| `__security_check_cookie` | MSVC /GS |
| `rep ret` | Old GCC (AMD branch prediction) |

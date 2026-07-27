---
name: pwn-ctf
description: Exploit memory-corruption, heap, format-string, ROP, kernel, or sandbox vulnerabilities in CTF challenges.
---

# Pwn CTF

## Purpose

Analyze and exploit binary vulnerabilities in controlled CTF settings. This
covers vulnerability identification, primitive development, exploit strategy,
and remote adaptation.

## Use When

- The challenge involves memory corruption, heap behavior, format strings,
  ROP, shellcode, seccomp, or sandbox escape.
- A local or remote binary service must be exploited.
- Exploit reliability and remote adaptation matter.

## Do Not Use

- The goal is to understand logic, not exploit memory corruption — use `reverse-ctf`.
- The challenge is a web application — use `web-ctf`.
- The challenge is a cryptosystem — use `crypto-ctf`.
- The category is unknown — use `ctf-triage` first.
- Real-world unauthorized exploitation — never.
- Do not spawn, request, or rely on subagents.

## Needs

- Binary, libc, loader, Dockerfile, or remote endpoint.
- Challenge prompt and flag format if known.
- Security mitigations and runtime environment when discoverable.
- Constraints on tooling or interaction.

## Returns

- Vulnerability identification and classification.
- Exploit strategy with rationale.
- Working exploit script or explicit blocker with evidence.
- Reliability notes and remote adaptation details.

## Done Conditions

- A working exploit retrieves the flag, or the exploit path is clearly
  framed with all needed primitives documented.
- Required offsets, gadgets, and assumptions are recorded.
- Remote/local differences are called out.
- If blocked, the blocker is explicit with next recovery step.

## Persistence And Yield

Useful progress means new primitive discovered, vulnerability confirmed,
exploit strategy refined, mitigation bypassed, offset or gadget found,
or remote behavior characterized.

Before yielding:

- Try the primary exploit path.
- Try one distinct bounded alternative (different vulnerability class,
  different primitive, different bypass technique).
- Check whether missing information is discoverable (leak via format string,
  partial overwrite, brute-force small entropy).
- Confirm the next action would repeat prior work, require unsafe guessing,
  or leave this skill's boundary.

Do not yield merely because the exploit is unreliable or mitigations are
present. Those are engineering problems, not blockers.

When yielding, return the exploit development performed, primitives found,
specific blocker, why more work would repeat, and the next recovery step.

## Methodology

### Evidence-First Workflow

Start from the real binary and its environment. Identify what you have
before forming an exploit hypothesis.

```
file <binary>                          # format and architecture
checksec --file=<binary>               # security mitigations
ldd <binary>                           # linked libraries
readelf -d <binary> | grep NEEDED      # dynamic dependencies
strings <binary> | grep -i 'libc'      # libc version hints
```

If a Dockerfile is provided, read it to understand the exact environment
(libc version, ASLR settings, kernel version).

### Step 1: Identify Mitigations

Map the binary's protection state:

| Mitigation | Implication |
|------------|-------------|
| NX enabled | No shellcode on stack/heap — use ROP or ret2libc |
| Stack canary | Overflow needs canary leak or bypass |
| PIE | All addresses randomized — need info leak |
| Full RELRO | GOT read-only — cannot overwrite GOT |
| Partial RELRO | GOT writable — GOT overwrite viable |
| ASLR (system) | Library and stack randomized — need leak |
| Seccomp | Restricted syscalls — enumerate with `seccomp-tools` |

### Step 2: Find the Vulnerability

Try in order of cost (cheapest first):

1. **Buffer overflow**: send large input, check for crash with controlled EIP/RIP.
2. **Format string**: send `%p.%p.%p.%p`, check for stack leaks.
3. **Integer overflow**: boundary values in size/length fields.
4. **Heap bugs**: allocation/free sequences that produce UAF or double-free.
5. **Race condition**: concurrent operations on shared state.
6. **Logic bug**: unexpected code path via unusual input.

Use `cyclic` from pwntools to find the exact offset to return address
or canary on stack overflow.

### Step 3: Develop Exploitation Primitive

Build from crash to controlled primitive:

- **Stack overflow → RIP control**: find offset, overwrite return address.
- **Format string → arbitrary read/write**: calculate stack offset, use
  `%n` for writes or `%s` for reads.
- **Heap corruption → arbitrary write**: tcache poisoning, fastbin dup,
  unsorted bin attack, or House-of-X technique.
- **Info leak → defeat ASLR/PIE**: leak libc address from GOT, stack,
  or heap metadata.

### Step 4: Build Exploit Strategy

Common patterns:

1. **ret2libc**: leak libc base → compute `system` and `/bin/sh` → call.
2. **ROP chain**: chain gadgets for syscall or function call.
3. **ret2csu**: use `__libc_csu_init` gadgets for controlled register setup.
4. **SROP**: forge sigreturn frame to set all registers.
5. **One-gadget**: find one-gadget RCE in libc (`one_gadget <libc>`).
6. **Stack pivot**: redirect RSP to controlled heap/BSS for larger ROP.
7. **Partial overwrite**: overwrite low bytes only to redirect within page.
8. **Heap → FSOP/House-of-Apple**: abuse FILE structures for code execution.

### Step 5: Adapt for Remote

- Verify libc version matches (`strings libc.so.6 | grep 'GNU C'`,
  libc-database lookup).
- Account for socket vs stdio buffering differences.
- Add retry logic for probabilistic exploits.
- Test locally with the challenge Dockerfile if provided.

### pwntools Template

```python
from pwn import *

context.binary = elf = ELF('./binary')
libc = ELF('./libc.so.6')

def conn():
    if args.REMOTE:
        return remote('host', port)
    return process('./binary')

p = conn()
# ... exploit ...
p.interactive()
```

### Apple Silicon Notes

- Cannot run ELF binaries natively on macOS ARM.
- Ask user for Debian VM IP for dynamic analysis and exploit testing.
- Compile exploit locally, deploy and test remotely.
- Use `pwntools` with `remote()` for both VM testing and CTF server.

## Pivot Rules

- If the binary needs significant reversing before the vulnerability is
  apparent, hand off to `reverse-ctf` for logic recovery first.
- If the exploit involves breaking a cryptographic primitive (e.g., canary
  prediction via PRNG weakness), consult `crypto-ctf` for the crypto part.
- If the challenge is a kernel exploit, stay in `pwn-ctf` — kernel
  exploitation is within scope.

## Reference

- `references/mitigations.md` — checksec, NX, canary, PIE, RELRO, ASLR, seccomp
- `references/stack-overflow.md` — offset discovery, ret2win, canary bypass
- `references/rop-chain.md` — ret2libc, ret2csu, one-gadget, GOT overwrite
- `references/rop-advanced.md` — SROP, ret2dlresolve, RETF, stack pivot
- `references/format-string.md` — read/write primitives, pwntools automation
- `references/heap-basics.md` — tcache, fastbin, UAF, unsorted bin leak
- `references/heap-feng-shui.md` — grooming, spray, cross-size layout control
- `references/heap-primitives.md` — unsorted bin leak, large bin attack, tcache stashing, FSOP, exit handlers
- `references/house-of-force.md` — top chunk size overwrite → arbitrary malloc (< 2.29)
- `references/house-of-spirit.md` — fake chunk free → allocation at controlled address
- `references/house-of-einherjar.md` — off-by-null → backward consolidation overlap
- `references/house-of-orange.md` — no free() → sysmalloc → FSOP chain
- `references/house-of-botcake.md` — tcache + unsorted bin double-free (2.29+)
- `references/house-of-apple.md` — IO wide-data vtable bypass (2.34+)
- `references/house-of-banana.md` — rtld_global fake link_map (2.34+)
- `references/house-of-lore.md` — small bin bk corruption → arbitrary allocation
- `references/house-of-husk.md` — printf function table hijack (2.27+)
- `references/house-of-roman.md` — partial overwrite, no leak needed (< 2.34)
- `references/house-of-pig.md` — large bin + tcache stashing + FSOP composition (2.31+)
- `references/kernel-exploitation.md` — setup, heap spray, KASLR/KPTI bypass, cross-cache
- `references/sandbox-seccomp.md` — seccomp bypass, ORW, VM escape, container escape
- `references/shellcode.md` — writing, encoding, bad char bypass, staged

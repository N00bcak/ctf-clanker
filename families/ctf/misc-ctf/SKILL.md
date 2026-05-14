---
name: misc-ctf
description: >-
  Handle miscellaneous CTF challenges: Python and bash jail escapes,
  encoding puzzles, esoteric languages, OSINT, hardware signals, and
  challenges that do not fit a specific category. Does not use subagents.
---

# Misc CTF

## Purpose

Solve miscellaneous CTF challenges that do not cleanly fit reverse, pwn,
crypto, web, or forensics. Covers jail escapes, encoding puzzles, esoteric
languages, OSINT, signal processing, game hacking, and constraint
satisfaction problems.

## Use When

- The challenge is a Python or bash restricted shell (jail/sandbox).
- The challenge involves encoding, decoding, or esoteric language interpretation.
- OSINT techniques are needed (username lookup, geolocation, web archive).
- The challenge involves signal processing, hardware, or SDR.
- The challenge is a game, puzzle, or constraint satisfaction problem.
- The challenge does not fit any other specialist category.

## Do Not Use

- The challenge involves AI/ML systems (LLM, classifier, adversarial) — use `ai-ctf`.
- The challenge is clearly binary exploitation — use `pwn-ctf`.
- The challenge is clearly a cryptosystem — use `crypto-ctf`.
- The challenge is a web application — use `web-ctf`.
- The challenge is a forensic artifact — use `forensics-ctf`.
- The challenge is a reverse engineering target — use `reverse-ctf`.
- The category is unknown — use `ctf-triage` first.
- Do not spawn, request, or rely on subagents.

## Needs

- Challenge prompt, source code, or interactive environment.
- Connection details for remote jail/sandbox if applicable.
- Challenge files or artifacts.
- Flag format or success condition.

## Returns

- Challenge classification within misc subcategories.
- Solution approach with rationale.
- Working solution or exploit script.
- If blocked, the constraint analysis and specific barrier.

## Done Conditions

- The flag is recovered.
- If blocked, the constraint space is analyzed, attempted bypasses are
  documented, and the specific barrier is explicit.

## Persistence And Yield

Useful progress means new bypass primitive found, constraint space narrowed,
encoding layer decoded, filter characterized, or OSINT lead confirmed.

Before yielding:

- Try the primary approach for the identified challenge type.
- Try one distinct bounded alternative (different bypass, different
  decoding, different interpretation).
- Check whether missing information is discoverable (error messages,
  environment inspection, partial output analysis).
- Confirm the next action would repeat prior work, require unsafe guessing,
  or leave this skill's boundary.

Do not yield merely because the first bypass attempt failed. Jail escapes
and encoding puzzles often require systematic enumeration of constraints.

When yielding, return the techniques tried, constraints discovered, specific
blocker, why more work would repeat, and the next recovery step.

## Methodology

### Evidence-First Workflow

Start from the real challenge environment. For jails, interact to discover
what is and is not allowed. For encodings, inspect the raw data before
guessing the scheme.

### Jail Escapes

#### Python Jail

1. **Enumerate constraints**: try `import`, `eval`, `exec`, `os`, `sys`,
   `__builtins__`. Note what is blocked.
2. **Identify filter type**: character blocklist, keyword blocklist, AST
   filtering, restricted builtins, sandboxed exec.
3. **Select bypass strategy**:

| Filter | Bypass approach |
|--------|----------------|
| `import` blocked | `__import__`, importlib, subclass chain |
| `.` blocked | `getattr()`, `[]` on `__dict__` |
| `_` blocked | Unicode equivalents, `chr()` construction |
| String literals blocked | `chr()` + concatenation |
| `exec`/`eval` blocked | `compile()` + type call, `__code__` manipulation |
| Length limit | Multi-stage: store in variable, expand later |

4. **Subclass chain**: `''.__class__.__mro__[1].__subclasses__()` to find
   `os._wrap_close` or `subprocess.Popen`.

#### Bash Jail

1. **Enumerate available commands**: `type`, `which`, list `/bin/*`.
2. **Identify restrictions**: PATH, rbash, blocked characters, allowlist.
3. **Select bypass**:

| Filter | Bypass approach |
|--------|----------------|
| Command name filtered | Glob (`/bin/c?t`), PATH slicing |
| Space filtered | `${IFS}`, `{cmd,arg}`, `<>` redirection |
| Specific chars filtered | Hex escape (`$'\x63'`), octal, variable slicing |
| rbash | Escape via `vi`, `awk`, `python`, or LD_PRELOAD |

### Encoding and Decoding

1. **Identify the encoding**: look for character set patterns.
   - Base64: `[A-Za-z0-9+/=]`, length multiple of 4.
   - Hex: `[0-9a-fA-F]`, even length.
   - Binary: `[01]` in groups of 8.
   - URL encoding: `%XX` sequences.
2. **Multi-layer decoding**: decode iteratively; many challenges stack
   encodings. Use CyberChef "Magic" for automated detection.
3. **Esoteric languages**: identify by character set.

| Pattern | Language |
|---------|----------|
| `+-><[].,` only | Brainfuck |
| Whitespace only | Whitespace |
| `[]()!+` only | JSFuck |
| `Ook. Ook! Ook?` | Ook! |
| Color image | Piet |

### OSINT

1. **Username search**: check across platforms (sherlock, namechk).
2. **Image search**: reverse image search (Google, TinEye, Yandex).
3. **Geolocation**: identify landmarks, signage, sun position, vegetation.
4. **Web archive**: Wayback Machine for deleted or historical content.
5. **DNS/WHOIS**: `dig`, `whois`, historical DNS records.
6. **Git/GitHub**: search commits, gists, organizations for leaked data.

### Constraint Satisfaction and Puzzles

- **Z3 solver**: for mathematical constraints, logic puzzles, satisfiability.
- **Brute force**: when key space is small, enumerate directly.
- **Dynamic programming**: for optimization puzzles.
- **Game theory**: for interactive or adversarial challenges.

### Signals and Hardware

- **SDR / RF**: IQ data → demodulate → decode protocol.
- **Side channel**: timing analysis, power analysis, electromagnetic.
- **QR codes**: `zbarimg` to decode, check for data layer manipulation.

## Pivot Rules

- If the jail escape leads to a binary exploitation problem, hand off
  to `pwn-ctf`.
- If the encoding reveals a cryptographic challenge, hand off to
  `crypto-ctf`.
- If OSINT leads to a web application to exploit, hand off to `web-ctf`.
- If the challenge involves reversing a binary after the jail escape,
  hand off to `reverse-ctf`.

## Reference

- `references/pyjail-escapes.md` — subclass chain, filter bypass, code objects
- `references/bashjail-escapes.md` — command bypass, space bypass, rbash escape
- `references/encoding-decoding.md` — identification, multi-layer, special encodings
- `references/esoteric-languages.md` — Brainfuck, Whitespace, JSFuck, Piet
- `references/osint.md` — username, geolocation, web/DNS, social media
- `references/linux-privesc.md` — sudo, SUID, capabilities, cron, kernel
- `references/constraint-solving.md` — Z3, game theory, optimization, brute-force
- `references/dns-challenges.md` — rebinding, NSEC walking, zone transfer, tunneling
- `references/other-jail-escapes.md` — PHP, Lua, JavaScript, Perl, Vim jail techniques

---
name: ctf-triage
description: >-
  Classify a CTF challenge by inspecting real artifacts, identify the primary
  attack domain, and route to the right specialist leaf. Does not solve;
  does not use subagents.
---

# CTF Triage

## Purpose

Examine challenge artifacts, classify the category, collect initial evidence,
and hand off to the correct CTF specialist. This is a domain-specific router,
not a solver.

## Use When

- Challenge prompt or files provided but category is unknown or ambiguous.
- Multiple CTF categories seem plausible and initial evidence is needed to decide.
- User has a CTF challenge and wants to know where to start.
- Challenge files are provided without context.

## Do Not Use

- Category is already obvious from the request — route directly to the specialist.
- Task is not a CTF challenge.
- Deep exploitation or analysis is needed — that belongs to a specialist.
- Do not spawn, request, or rely on subagents.

## Needs

- Challenge prompt, description, or category tag (if available).
- Challenge files, URLs, service endpoints, or archive contents.
- Competition context: flag format, time constraints, point value (if known).

## Returns

- `challenge_classification`: primary category and confidence.
- `evidence_summary`: concrete observations from artifact inspection.
- `recommended_specialist`: which CTF leaf to route to.
- `initial_findings`: journal-ready observations for the specialist.
- `pivot_candidates`: secondary categories if evidence is ambiguous.

## Done Conditions

- Primary category identified with supporting evidence.
- Specialist recommendation made with enough context to begin.
- Initial findings documented for handoff.
- Ambiguities or missing artifacts flagged explicitly.

## Persistence And Yield

Useful progress means category narrowed, artifact type identified, attack
surface partially mapped, or ambiguity between categories resolved.

Floor: inspect all provided artifacts, identify file types and obvious signals,
check for trivially visible category markers. If still ambiguous, state the top
candidates with the discriminating evidence for each.

Never yield just because the category is unclear — try harder with the artifacts.

When yielding: state what was inspected, what categories remain plausible,
what single observation would discriminate, and recommended next action.

## Methodology

### Step 1: Inventory Artifacts

List every real artifact: files, archives, URLs, network services, images,
binaries, source code, captures, disk images. Note what is actually present
versus what the challenge description claims.

```
file *                        # identify file types
strings <file> | head -80     # quick string scan
xxd <file> | head -20         # hex header inspection
binwalk <file>                # embedded file detection
```

If an archive is provided, extract it and inventory the contents. If a URL is
provided, fetch the landing page and note the technology stack.

### Step 2: Category Signal Identification

Map observations to category signals:

| Signal | Likely Category |
|--------|----------------|
| ELF/PE binary with libc or Dockerfile | `pwn-ctf` |
| Obfuscated binary, custom VM, APK, WASM, .NET | `reverse-ctf` |
| Python crypto script, .pem files, large integers | `crypto-ctf` |
| URL, HTTP service, HTML/JS/CSS, web framework | `web-ctf` |
| PCAP, disk image, memory dump, forensic artifact | `forensics-ctf` |
| Image with stego hint or unusual file size | `forensics-ctf` |
| LLM chatbot, AI classifier, adversarial ML | `ai-ctf` |
| Pyjail, encoding puzzle, esoteric language, OSINT | `misc-ctf` |
| Multiple strong signals across categories | note all, pick strongest |

### Step 3: Resolve Ambiguity

When multiple categories are plausible:

1. A web app serving a binary — `web-ctf` first (the web app is the attack surface).
2. A crypto challenge with a network oracle — `crypto-ctf` first (crypto is the target).
3. A binary needing reversing before exploitation — `reverse-ctf` first.
4. A forensic artifact containing encrypted data — `forensics-ctf` first.
5. When genuinely equal — pick the category that produces the most useful first-pass evidence.

Trust artifacts over challenge descriptions. A challenge tagged "misc" might be
pure crypto once you inspect the files. A "crypto" tag on a challenge that ships
a binary often means reverse the custom cipher.

### Step 4: Start Findings Journal

Create a findings file for the specialist to continue:

```markdown
# Findings: <challenge-name>

## Artifacts
- <file>: <type>, <size>, <notable observations>

## Category Assessment
- Primary: <category> (confidence: high/medium/low)
- Evidence: <concrete observations>
- Secondary candidates: <if any>

## Initial Observations
- <observation 1>
- <observation 2>
```

### Step 5: Hand Off

Route to the specialist with:
- Category classification and confidence.
- All artifacts and their identified types.
- Findings journal with initial observations.
- Competition constraints or flag format if known.

## Pivot Rules

- If triage reveals a clean single-category fit, route there directly.
- If triage reveals genuine multi-domain work, note this for potential council
  consideration but still recommend the primary specialist for first pass.
- If no artifacts are available and the challenge description is insufficient,
  ask the user for the missing material.

## Reference

Read `references/triage-checklist.md` for the full category signal table and
disambiguation rules.

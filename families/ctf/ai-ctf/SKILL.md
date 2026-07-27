---
name: ai-ctf
description: Exploit prompt injection, adversarial ML, model extraction, poisoning, or jailbreak weaknesses in AI CTFs.
---

# AI CTF

## Purpose

Exploit vulnerabilities in AI and machine learning systems in CTF settings.
Covers LLM prompt injection, adversarial example generation, model
extraction, data poisoning, and AI-specific logic flaws.

## Use When

- The challenge involves an LLM chatbot, text-generation API, or AI assistant.
- Adversarial images, audio, or inputs are needed to fool a classifier.
- Model weights, architecture, or training data must be extracted or inferred.
- Data poisoning or backdoor insertion is the objective.
- The challenge combines AI with another domain (web + LLM, crypto + ML).

## Do Not Use

- The challenge is a pure ML modeling task (training, tuning) — defer to
  ML family skills (`dataset-triage`, `classical-ml-baseline`,
  `deep-learning-experiment`) when they are fully authored.
- The challenge is a standard web app without AI components — use `web-ctf`.
- The category is unknown — use `ctf-triage` first.
- Do not spawn, request, or rely on subagents.

## Needs

- Target AI system: chatbot URL, API endpoint, model file, or notebook.
- Challenge prompt and success condition (extract flag, bypass filter, etc.).
- Any provided model weights, training data, or architecture details.

## Returns

- Identified vulnerability class (prompt injection, adversarial, extraction).
- Working exploit or adversarial input.
- Flag or explicit blocker with evidence.

## Done Conditions

- The AI system is exploited and the flag is recovered.
- If blocked, the attack surface is mapped with tested techniques and specific barrier.

## Persistence And Yield

Useful progress means new bypass found, constraint on the AI system discovered,
partial flag extracted, or defense mechanism characterized.

Before yielding:

- Try the primary attack vector (direct injection, then encoding, then multi-turn).
- Try one distinct bounded alternative (different encoding, different role-play, different modality).
- Check whether missing information is discoverable (error messages, model behavior probing).
- Confirm the next action would repeat prior work, require unsafe guessing, or leave this skill's boundary.

Do not yield merely because the first injection attempt was filtered.

When yielding, return techniques tried, defenses identified, specific blocker,
why more work would repeat, and the next recovery step.

## Methodology

### Step 1: Identify the AI System

Determine: LLM chatbot, image classifier, text classifier, recommendation
system, or custom ML model. Check for API access, model file, or black-box
interaction only.

### Step 2: Probe Constraints

For LLMs: test what triggers refusal, what encoding bypasses exist, whether
the system prompt is extractable. For classifiers: test input format,
confidence scores, error behavior.

### Step 3: Select Attack Class

| System Type | Primary Attacks |
|---|---|
| LLM chatbot | Prompt injection, jailbreak, system prompt extraction |
| Image classifier | Adversarial perturbation (FGSM, PGD, C&W) |
| Text classifier | Adversarial text (synonym swap, Unicode, homoglyphs) |
| ML API (black-box) | Model extraction via query, membership inference |
| Training pipeline | Data poisoning, backdoor injection |

### Step 4: Implement and Verify

Run the attack, verify the flag or objective, document the approach.

## ML Family Hook

For challenges requiring actual ML work (training models, tuning
hyperparameters, feature engineering) rather than attacking ML systems,
the ML family skills provide the modeling methodology:

- `dataset-triage` — data quality, splits, leakage detection
- `classical-ml-baseline` — tabular/structured data modeling
- `deep-learning-experiment` — neural network training

These are currently stubs. Until fully authored, handle the ML modeling
portion of an AI CTF within this skill using standard Python ML tooling
(sklearn, PyTorch, TensorFlow). Leave pure modeling tasks to native Codex.

## Pivot Rules

- If the AI challenge is wrapped in a web application, the web exploitation
  layer belongs to `web-ctf` — handle the AI-specific attack here.
- If the challenge involves reversing a model binary (ONNX, TFLite, custom),
  the binary analysis belongs to `reverse-ctf`.
- If cryptographic techniques protect the model, consult `crypto-ctf`.

## Reference

- `references/prompt-injection.md` — LLM jailbreak, extraction, encoding bypass
- `references/adversarial-ml.md` — adversarial examples, model extraction, data poisoning

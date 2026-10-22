---
name: ultracode-orchestrate
description: Orchestration playbook for ultracode mode — how to decompose a substantive task, choose between a dynamic workflow and parallel Agent fan-out, run map/map-reduce/verify patterns, merge results, and gate completion on an adversarial review pass. Load when running a turn in ultracode mode (keyword "ultracode" or standing mode active) before spawning any subagent or workflow, or whenever the user asks how to structure multi-agent work.
---

# Ultracode orchestration playbook

The depth mandate ("exhaustive, correct — not fast or cheap") is worthless
without structure. This playbook turns the mandate into concrete mechanics.
Read it before decomposing; it exists so every ultracode turn orchestrates the
same way instead of improvising.

## 1. Choose the orchestration vehicle

| Situation | Vehicle |
|---|---|
| Subtask boundaries are known up front, each has a checkable deliverable, and the whole thing benefits from a typed pipeline with gates | **CreateWorkflow** (load the `dynamic-workflows` skill first; under the ultracode convention the keyword is the explicit workflow request) |
| The task is exploratory, the subtask list will change as you learn, or you need a handful of parallel perspectives once | **Agent tool fan-out** — several `Agent` calls in a single message so they run concurrently |
| Conversational or trivial (per the ultracode skill's definition) | **Solo** — orchestration overhead on trivia is waste, not depth |

When torn between workflow and fan-out: workflow if you expect to re-run or
gate the pipeline; fan-out if it's a one-shot burst.

## 2. Decompose

- Name the independent subproblems before spawning anything. If you cannot
  state a subproblem's deliverable in one sentence, it is not decomposed yet.
- Give every subagent a **self-contained brief**: they start with zero
  conversation context. Include file paths, the exact question, the expected
  output shape, and the acceptance check. Never say "as discussed".
- Cap fan-out at 3–8 agents. Beyond that, decompose into stages instead of a
  single giant fan.
- Sorting a sequence of dependent steps is not parallelism — pipeline those
  through a workflow's control flow rather than pretending they're parallel.

## 3. Parallel patterns

- **Map** — same operation over independent items (files, modules, questions).
  Merge by concatenation with dedupe.
- **Map-reduce** — map produces findings, a reduce step (often you, the
  orchestrator) reconciles contradictions. Always reconcile explicitly; never
  average away a disagreement silently.
- **Verify** — after a producer agent finishes, a reviewer agent checks the
  claim against the artifact. Use for anything load-bearing.
- **Pipeline** — stages with typed handoffs (explore → implement → test).

## 4. Merge discipline

1. Collect every agent's deliverable; dedupe overlapping findings.
2. Resolve contradictions by evidence, not by vote — check the artifact when
   two agents disagree.
3. Integrate into the actual deliverable yourself; agents' outputs are input,
   not the final artifact.

## 5. Verification gate (mandatory before "done")

Spawn (or run) a reviewer whose mandate is adversarial: find the flaws, the
unhandled edge, the claim that doesn't hold. A reviewer that agrees is a
failed review — rewrite its brief or do it yourself with fresh eyes.

Checklist before declaring the turn done:

- [ ] Every subproblem's deliverable landed or was explicitly dropped with a
      stated reason.
- [ ] The adversarial pass ran and its findings are either fixed or answered.
- [ ] Tests/builds/verification commands actually ran and passed (say what
      ran; report failures as failures).
- [ ] Nothing claimed without a source: file path, command output, or agent
      deliverable.

## 6. Anti-patterns

- Spawning agents for steps that are strictly sequential anyway.
- Every subagent re-reading the same large file — pass the distilled summary
  in the brief instead.
- Skipping the verification gate because the result "looks right".
- Confusing volume with depth: an idle or vague agent is cost without
  correctness. Every agent needs a deliverable and an acceptance check.

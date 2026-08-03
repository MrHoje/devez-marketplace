---
name: hoje-goals-validation-batch
description: Internal Hoje Goals validation-batch checkpoint contracts.
user-invocable: false
---

# Hoje Goals Validation-Batch Contracts Fragment

Internal Hoje Goals sub-skill fragment (an internal Hoje-Code plugin skill, parent skill `ultragoal`, installed at `/hoje-code:hoje-goals-validation-batch`). The Hoje Goals leader loads it on demand before checkpointing a validation-batch member; it is never user-facing, not slash-command discoverable, and never resolvable through `skill://`. The runtime enforces every rule below verbatim and fails closed.

## Validation-batch checkpoint contract

- **Non-final members** checkpoint `complete` with a single top-level `deferredToBatch` quality gate (kind `validation-batch-deferred`): a passing `targetedVerification` lane plus a cumulative-since-base change set. An ai-slop-cleaner pass and a full verification rerun are boundary duties and are optional here; when either is supplied it must pass and be blocker-free. A `deferredToBatch` gate must NOT contain `architectReview`, `executorQa`, or `validationBatchClose` — deferring never manufactures fake review approvals.
- **Lane declaration is fail-closed.** `deferredToBatch.ranLanes` declares which lanes actually ran. A declared lane whose evidence is missing is rejected, evidence for an undeclared lane is rejected, `targetedVerification` must always be declared when `ranLanes` is present, and `ranLanes` can never declare `architectReview` or `executorQa`. Omitting `ranLanes` is allowed only for a gate that carries the mandatory targeted lane alone.
- **Derivable fields are auto-filled — never hand-compute a hash.** When omitted, the runtime fills `kind`, the batch tuple, `deferredLanes`, and the whole `changeSet` block (`memberGoalId`, `cumulativeFromBase`, `paths` from the computed cumulative diff, `changeSetHash`); the minimal deferred gate is `{"deferredToBatch":{"targetedVerification":{"status":"passed","commands":["..."],"evidence":"..."}}}`. A supplied value must still match reality; `changeSet.paths` rows may be plain path strings or `{path, status}` objects.
- **The final member** (`finalGoalId`) checkpoints `complete` with the normal full strict gate PLUS a top-level `validationBatchClose` proof that covers all member IDs, member metadata hashes, member receipt/checkpoint-ledger-event IDs, per-member change-set hashes, and union change-set coverage. Every close field except `coverageEvidence` is auto-filled from durable receipts and the computed cumulative diff when omitted — the minimal close is `{"validationBatchClose":{"coverageEvidence":"..."}}` alongside the strict gate, and a supplied value must still match durable state. The final close only starts once every non-final member is already `complete` with a structurally fresh deferred receipt (out-of-order close is rejected).
- Close state is append-only proof: it lives in the final member's checkpoint receipt and matching `goal_checkpointed` ledger row only. Never stamp `closedReceiptId`/`closedAt` or any close-state field onto member goals, and never append a separate close ledger event.
- Change sets are cumulative-since-base: each member's `changeSet.paths` is the whole-worktree diff vs base (`cumulativeFromBase: true`), `memberGoalId` is a label not a per-path attribution, and `unionChangeSet.paths` carries no per-goal attribution.
- Batch invalidation is fail-closed: steering mutations that would invalidate a batch are rejected while any member holds a fresh deferred receipt.


## Hoje-native validation-batch JSON

The non-final gate contains only `deferredToBatch` with `kind`, `batchId`, `memberGoalId`, passed `targetedVerification`, passed `cleaner`, passed `iteration` with `fullRerun: true`, and `changeSet: { cumulativeFromBase: true, paths: [...] }`. Each check includes evidence and an empty blockers array; verification checks also include commands.

The final full gate adds `validationBatchClose` with `kind: "validation-batch-close"`, matching `batchId`, `finalGoalId`, ordered `memberIds`, maps named `memberReceiptIds`, `memberMetadataHashes`, and `memberChangeSetHashes`, plus `unionChangeSet: { cumulativeFromBase: true, paths: [...] }` and non-empty `evidence`. Map keys cover each non-final member. The runtime rejects missing, stale, out-of-order, or uncovered proof.

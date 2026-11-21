# Agent Note: Product analytics consent evidence

Status: implemented

English | [中文](2026-11-18-product-analytics-consent-evidence.zh.md)

## Problem

An asynchronous account lookup or preference refresh can finish after a user action. A grant or account change during that gap must not authorize the earlier action, and device clocks do not establish the order of consent across clients.

## Decision

The Host keeps optional product measurement separate from editor content and begins with collection disabled. It captures a server-issued order reference before a login or root turn, preserves the captured subject and revision, and sends a signed reference with the immutable queued event. The backend compares the signed order to the current decision under its consent transaction. Feature controls capture the subject, revision, and signed reference before invoking an action. Revocation discards pending events for the affected grant.

The signed reference establishes that the backend issued an order; it does not prove when a device action happened. That boundary remains the client's responsibility. The [collector package](../../../../packages/host/verboo-analytics/README.md) owns the Host contract.

## Alternatives considered

**Compare wall clocks.** Device clocks and backend instances can differ, and a consent transaction can commit after its timestamp is assigned.

**Look up consent after completion.** A later grant or account switch could authorize or reassign an earlier action.

## Consequences

Actions without a prior valid reference are not measured, including some actions immediately after startup or while offline. The receiver needs a configured proof key and a coordinated backend rollout; rotation must retain verification for queued proofs. The collector never puts prompts, responses, tool arguments, or the proof itself into PostHog properties.

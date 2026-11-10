# Agent Note: Verboo stamina presentation

Status: implemented

English | [中文](2026-11-04-verboo-stamina.zh.md)

## Problem

Selected unlimited-plan users need a compact stamina reading without exposing internal budgets or inference rates. An account switch can leave earlier HTTP reads outstanding.

## Decision

The product API reads the authenticated server's public stamina projection. The gateway owns enrollment, consumption and throttling. The Client adds no admission policy and displays no monetary reserves.

The Chat composer consumes the registered resource. Its address includes the current credential revision and profile ID; account replacement aborts the old read and rejects late responses. Visible, online holders drive one bounded read at a time. Failures preserve the last confirmed value and mark the liquid stale; an empty server list hides stamina. A missing endpoint supports older deployments by returning that empty list.

Stamina fills the primary Send/Stop button as liquid inside a thin purple ring, preserving the action, disabled state and keyboard focus. The accepted composer model selects its server group by routing slug and group ID; missing or conflicting metadata leaves the reading unknown. Stamina appears only in Chat. Reduced-motion preferences stop the waves, and accessibility ignores the decoration.

## Alternatives considered

**Infer the limit from observed TPS.** Provider capacity and transport delay affect observed speed independently of the server's budgets, so that reading cannot establish an admission limit.

**Poll independently in each component.** Separate caches can disagree and retain different account generations. The existing resource registry supplies shared values and releases the provider when its last holder leaves.

## Consequences

Stamina does not enter prompts, Session persistence or local credentials. Offline windows show retained readings rather than a fabricated recharge. Availability still requires the backend pilot to select the account and plan.

The owning API, resource lifecycle and component tests exercise malformed responses, failures, replayed account changes, cancellation and button decoration. Built-browser acceptance covers Chat and the absence of stamina on other pages with a loopback API.

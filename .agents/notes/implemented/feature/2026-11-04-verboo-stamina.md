# Agent Note: Verboo stamina presentation

Status: implemented

English | [中文](2026-11-04-verboo-stamina.zh.md)

## Problem

Selected unlimited-plan users need to understand their next-request speed without exposing internal budgets. A desktop cannot infer a gateway's admission ceiling from observed generation speed, and an account switch can leave earlier HTTP reads outstanding.

## Decision

The product API reads the authenticated server's public stamina projection. The gateway owns enrollment, consumption and throttling. The Client adds no admission policy and displays no monetary reserves.

The composer and My plan consume the same registered resource. Its address includes the current credential revision and profile ID; account replacement aborts the old read and rejects late responses. Visible, online holders drive one bounded read at a time. Failures preserve the last confirmed value with localized feedback; an empty server list hides stamina. A missing endpoint supports older deployments by returning that empty list.

## Alternatives considered

**Infer the limit from observed TPS.** Provider capacity and transport delay affect observed speed independently of the server's budgets, so that reading cannot establish an admission limit.

**Poll independently in each component.** Separate caches can disagree and retain different account generations. The existing resource registry supplies shared values and releases the provider when its last holder leaves.

## Consequences

Stamina does not enter prompts, Session persistence or local credentials. Offline windows show retained readings rather than a fabricated recharge. Availability still requires the backend pilot to select the account and plan.

The owning API, resource lifecycle and component tests exercise malformed responses, failures, replayed account changes, cancellation and localized readings. Built-browser acceptance covers the registered views with a loopback API.

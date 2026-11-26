# Agent Note: Desktop usage analytics

Status: implemented

English | [中文](2026-11-26-desktop-usage-analytics.zh.md)

## Problem

Desktop users need the selected subscription usage metrics and the web dashboard's activity calendar without navigating away from their workspace.

## Decision

A product page in the sidebar reads the existing authenticated usage summary, per-plan summary, annual activity and stamina services. It also streams account generation speed from the web dashboard’s authenticated live service, labels estimates and prior measurements, and stops displaying stale data. The Host validates the selected period, group identity and response fields; credentials stay in the Host and account changes invalidate pending responses. The page defaults to 30 days and provides the web dashboard's other subscription periods. It renders input, output and cached tokens, requests, plan totals, a time chart and a 365-day calendar. A failed activity read is never presented as a year of zero use; plan failures do not hide successful totals. Requests are cancelled when their account or period changes.

## Alternatives considered

**Embed the web dashboard.** Its authentication and full set of metrics do not match the requested desktop scope. Reusing its server data and calculations keeps the selected experience within the application.

## Consequences

The page shows subscription usage only and does not expose concurrency, global rankings or equivalent cost. Its calendar follows local calendar days and displays the server's daily counts. The Host does not forward private API grants to the Client.

## Related

- [Verboo product API](../../../../packages/api/verboo-product/README.md)
- [Verboo product UI](../../../../packages/client/ui-verboo/README.md)

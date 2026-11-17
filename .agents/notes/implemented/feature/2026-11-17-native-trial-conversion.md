# Agent Note: Native trial attention and explicit subscription conversion

Status: implemented

English | [中文](2026-11-17-native-trial-conversion.zh.md)

## Problem

The desktop client's short subscription projection cannot explain a depleted trial or present a trustworthy payment decision. A dashboard-only notice leaves the buyer without a clear next action in the chat. Inferring expiry from an inference failure or an isolated client clock also confuses outages with commercial state.

## Decision

The backend projects trial attention, remaining tokens and paid group access. The app shows a composer notice at 24 hours or 20% remaining tokens, whichever comes first. Actual expiry opens a dismissible offer, featuring Pro while keeping other plans visible. Dismissal belongs to the window lifetime, so another application launch presents the ended trial again. The focused pane's accepted model and server group own the attention context.

The product Host owns signed authorizations. The Client receives price, interval, expiry and a masked card summary, never a provider customer or payment-method identifier. Viewing, card setup, trial plan transfer and charging remain separate. Each charge requires the displayed offer and explicit authorization; a changed or expired quote needs another confirmation. The subscription period starts after persisted payment confirmation.

The catalog stays in USD. A Brazilian primary-account Pix purchase obtains a separate signed BRL quote from the backend's official FX cache. It fixes the BRL recurring amount and shows the bank authorization ceiling including IOF. The original purchase attempt preserves USD and FX evidence. A browser handoff or successful return URL does not prove payment. Restart, timeout and additional authentication resume that original attempt.

## Alternatives considered

**Dashboard-only notices.** The product request requires an action inside the app, at the point where the trial affects chat use.

**Automatic charging after showing the offer or saving a card.** Neither action supplies the explicit authorization required by this flow. Card setup ends with another reviewable quote.

**Client-side currency conversion.** It cannot bind the displayed amount to the server's charge or safely preserve an earlier attempt after the rate changes. Pix uses an independently signed server quote.

**Persisting a dismissed modal indefinitely.** That would hide the upgrade opportunity after a restart. Reopening on every poll would interrupt navigation, so dismissal lasts only for the current window.

## Consequences

The backend and its FX snapshot migration precede the Client release. Unsupported payment methods remain unavailable rather than being approximated. Browser-only provider steps remain external until a native provider flow exists. Commercial data and all new Remote operations remain owner-only in shared sessions and stay out of model context.

The ownership, quote, presentation and recovery tests live with their packages. A Loader-composed service test uses an external HTTP fixture and verifies that observing a Pix quote does not create a purchase and repeated confirmation creates only one checkout. The active Agent Note tree contains no earlier Verboo trial-conversion decision to supersede.

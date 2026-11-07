# Verboo Code interface

Keep the product compact and neutral, with purple reserved for accents. Sidebar conversations occupy one line. Show a small spinner to the left of the title only while that conversation is working; remove it on completion or pause. Inactive conversations have no idle label, status subtitle, persistent badge or reserved indicator space. Preserve title ellipsis, a separate menu target and accessible touch targets. Idle composer feedback occupies no space. Avoid duplicate information and unnecessary controls.

Match the Verboo Code web app's visual identity: near-black neutral surfaces, local Nunito text, the official mark with a `verboo:code` wordmark, purple user messages and small purple controls. Keep plan comparison in clear cards and ended subscriptions collapsed. Use typed slots and optional theme tokens for product styling so upstream renderers remain replaceable.


Show stamina as water inside the existing Send/Stop button, with a thin purple circular ring around it. Keep the arrow, actions, disabled state and keyboard focus owned by the composer. Do not add a separate stamina bar or control beside the model. Keep inference speeds and rate ceilings out of the interface, tooltips and accessibility labels. Respect reduced motion.

Keep the normal Working label out of the composer; retain waiting, connection and error feedback. Opt-in staminaDebug diagnostics may show exact server percentages, plan names and server reading times, but never inference rates or financial reserves. Normal mode keeps these diagnostics hidden.

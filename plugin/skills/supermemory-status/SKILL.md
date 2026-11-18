---
name: supermemory-status
description: >-
  Check whether Supermemory is connected: authentication source, signed-in
  account, active repository memory namespace, session-scoping settings, and API
  reachability. Use when the user asks about Supermemory status or connection.
---

# Check Supermemory status

1. Run the status probe for the current workspace (it never prints credentials):

   ```sh
   antigravity-supermemory status --workspace "<workspace root>" --account
   ```

2. Summarize the result concisely:
   - Whether Supermemory is connected and the `authSource` (`oauth`, `env`,
     `project`, `config`, or `credentials`), plus `account` email/organization
     when available.
   - Active `namespace` and `workspace` root.
   - `recallMode`, `captureEnabled`, and session scoping (`captureSubagents`,
     `captureHeadless`, `captureOrchestrated`).
   - If authentication failed or no credentials are configured, suggest running
     `/supermemory-login` or setting `SUPERMEMORY_API_KEY`.

---
name: supermemory-logout
description: >-
  Sign Supermemory out of Antigravity, revoke the stored OAuth token, and clear
  local recall caches. Use only when the user explicitly asks to sign out of or
  disconnect Supermemory.
---

# Sign out of Supermemory

1. Run:

   ```sh
   antigravity-supermemory logout
   ```

2. Confirm to the user that Supermemory is now signed out: new conversations
   will not load or save memories until they run `/supermemory-login` (unless an
   explicit `SUPERMEMORY_API_KEY` is still set in their environment or config).
   Existing remote memories remain intact in their Supermemory account.

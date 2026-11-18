---
name: supermemory-login
description: >-
  Connect Supermemory to Antigravity through a browser OAuth sign-in. Use when
  the user asks to sign in or reconnect Supermemory, or after a status check
  shows Supermemory is not connected.
---

# Connect Supermemory

1. Run from the user's project directory:

   ```sh
   antigravity-supermemory login --workspace "<workspace root>"
   ```

   It opens the browser (or prints the authorization URL if no browser opener is
   available) and returns within ~20 seconds while keeping a background listener
   open for up to 5 minutes.
2. Relay the command's output. If a browser window opened or a URL was printed,
   tell the user to finish signing in there; memory activates automatically on
   the next message.
3. On a headless machine where interactive browser sign-in is inconvenient, tell
   the user they can also set `SUPERMEMORY_API_KEY` (or `apiKey` in the config
   file) from https://console.supermemory.ai.

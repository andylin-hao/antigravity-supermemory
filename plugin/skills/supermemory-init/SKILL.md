---
name: supermemory-init
description: Initialize or refresh persistent Supermemory knowledge of the current codebase when the user asks to index or memorize the repository.
---

# Index this codebase

1. Identify the absolute repository root. Call `supermemory_context` with that
   workspace to see what is already known.
2. Read the README, agent instructions, package/build manifests, main entry
   points, and representative implementation files. Respect repository ignore
   rules. Focus on structure, test/build commands, conventions, and architecture.
3. Save a few concise, verified facts through `supermemory` with `mode: "add"`,
   `scope: "project"`, and an appropriate `type`: `project-config`, `architecture`,
   or `learned-pattern`. Include useful paths. Avoid duplicating existing facts.
4. Never upload whole repositories, generated files, credentials, private regions,
   or unrelated personal data. Do not invent facts about unexplored code.
5. Report the topics submitted and distinguish queued ingestion from searchable
   memories. This indexes durable project knowledge, not every source chunk.

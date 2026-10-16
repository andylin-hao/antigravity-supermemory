# antigravity-supermemory

Persistent memory for **Google Antigravity**, powered by [Supermemory](https://supermemory.ai).
Inspired by [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory).
This is an independent integration, using Antigravity's native plugin, hook, skill,
and MCP interfaces.

## Features

- **Automatic recall:** profile and recent project facts on the first model call;
  semantic project recall on each new substantive user prompt. Recall requests run
  concurrently with a three-second timeout each and no automatic retries.
- **Automatic capture:** at an idle `Stop`, save new user/assistant turns with stable
  document IDs and persistent checkpoints. Repeated hooks skip acknowledged saves.
- **Memory tools:** add, search, profile, list, and forget; plus read-only recall
  and session-context tools.
- **Remember requests:** hooks and an always-on rule remind the agent to store the
  fact when you say “remember”, “save this”, or “don't forget”.
- **Codebase knowledge:** a `supermemory-init` skill explores and remembers build
  commands, architecture, and conventions.
- **Privacy:** remove `<private>...</private>` regions, including nested and
  unclosed regions, before uploads and searches. Capture excludes tool output,
  reasoning, and recognized synthetic/system messages.
- **Shared repository identity:** the same canonical namespace and `sm_scope`
  metadata convention as current OpenCode Supermemory.

## Install with npx

Requires **Node.js 22+**, npm, a Supermemory API key, and Antigravity.
The package has not been published to npm yet. Use the local release tarball now:

```sh
npx --yes ./antigravity-supermemory-0.1.0.tgz install --workspace /absolute/path/to/your/project
```

For all workspaces, replace `--workspace /absolute/path/to/your/project` with
`--global`. Then [configure your API key](#configure-the-api-key) and restart
Antigravity.

Once this package is published to npm, the equivalent short command will be:

```sh
npx --yes antigravity-supermemory@latest install --workspace /absolute/path/to/your/project
# Or: npx --yes antigravity-supermemory@latest install --global
```

Installation copies a standalone runtime into the managed plugin directory.
Antigravity can continue using it after npx's cache is cleared or the original
checkout/tarball is removed. Node.js must remain at the installed executable path;
rerun installation after changing your Node installation.

### Install from this checkout

```sh
git clone https://github.com/andylin-hao/antigravity-supermemory.git
cd antigravity-supermemory
npm ci
npm run build

# Install for a project you open in Antigravity:
node dist/cli.js install --workspace /absolute/path/to/your/project
```

This creates `.agents/plugins/supermemory/` in the target project, with a manifest,
MCP configuration, hooks, rule, skill, and standalone runtime. Generated commands
use absolute paths to Node and the installed runtime, with no dependency on this
checkout's `node_modules`.

For all workspaces instead:

```sh
node dist/cli.js install --global
```

This installs into `~/.gemini/config/plugins/supermemory/`. Global MCP calls must
include an absolute `workspace` path; the bundled rule tells the agent to supply
it. Hooks use the single `workspacePaths` entry in Antigravity's payload. For
multi-root sessions, automatic hooks skip ambiguous workspaces; tools still work
with an explicit path. Choose one installation route per workspace to avoid
duplicate plugin components.

### Configure the API key

Set `SUPERMEMORY_API_KEY` in the environment of the **Antigravity process**, or
create the global config file printed by:

```sh
npx --yes ./antigravity-supermemory-0.1.0.tgz config-path
```

Default: `~/.config/antigravity-supermemory/config.jsonc`

```jsonc
{
  "apiKey": "sm_your_api_key"
}
```

The global file is convenient for GUI launches that do not inherit terminal
environment variables. Keep it outside your repository and restrict its file
permissions (for example, `chmod 600` on Unix).

Reload Antigravity's customizations/MCP servers or restart the application. Check
the connection with:

```sh
npx --yes ./antigravity-supermemory-0.1.0.tgz status --workspace /absolute/path/to/your/project
```

Then ask Antigravity:

> Remember that this project uses npm and tests run with npm test.

In another conversation:

> What package manager and test command does this project use?

Supermemory processes uploads asynchronously; queued documents can take minutes
to become searchable memories.

### Older Antigravity IDE versions

If your IDE supports MCP but not native plugins/hooks, use:

```sh
node dist/cli.js install --legacy --workspace /absolute/path/to/your/project
```

The installer merges a project-specific server into
`~/.gemini/antigravity/mcp_config.json` and adds `.agent/rules/supermemory.md` and
`.agent/workflows/supermemory-init.md`. Existing servers and JSONC comments are
preserved. If **MCP Servers → View raw config** shows another path, specify it:

```sh
node dist/cli.js install --legacy --workspace /absolute/path/to/project \
  --mcp-config /absolute/path/to/mcp_config.json
```

This mode uses agent-driven recall and saving through the rule. **It does not
automatically capture turns or inject context through hooks.** Run
`/supermemory-init` to index project knowledge using the workflow.

### Update and uninstall

To update, rerun the npx install command with the new release tarball (or
`@latest` after publication). From a checkout, run `npm ci`, `npm run build`, and
the same install command. Installation is repeatable and refuses to overwrite
locally modified managed files. Uninstall uses the same scope/mode flags:

```sh
npx --yes ./antigravity-supermemory-0.1.0.tgz uninstall --workspace /absolute/path/to/project
```

From the checkout:

```sh
node dist/cli.js uninstall --workspace /absolute/path/to/project
# Or: node dist/cli.js uninstall --global
# Or: node dist/cli.js uninstall --legacy --workspace /absolute/path/to/project
```

Only unmodified managed files (including the runtime) and the matching legacy MCP entry are removed.
Unrelated configuration, remote memories, API credentials, and capture checkpoints
are retained. If a managed file was edited, reconcile it before rerunning.

## Tools

| Tool | Purpose |
| --- | --- |
| `supermemory` | `mode`: `add`, `search`, `profile`, `list`, `forget`, `help` |
| `supermemory_recall` | Read-only semantic search: `query`, `scope?`, `limit?` |
| `supermemory_context` | Read-only profile + recent project memories; optional `query` |

All tools accept `workspace`: an absolute project directory. It is optional when
the server was started with `--workspace` (as in a workspace installation).
Antigravity may prefix tool names with the plugin/server name.

`supermemory` examples:

```json
{"mode":"add","content":"Tests run with npm test","type":"project-config","scope":"project"}
{"mode":"search","query":"test command","scope":"project"}
{"mode":"profile"}
{"mode":"list","scope":"project","limit":10}
{"mode":"forget","memoryId":"mem_from_search_or_list","scope":"project"}
```

**Scopes:** `project` is the default. `user` means personal facts **within the
current repository**, matching the current OpenCode plugin, not a global profile
shared across unrelated repositories.

**Types:** `project-config`, `architecture`, `error-solution`, `preference`,
`learned-pattern`, `conversation`.

**IDs:** `add` returns an ingested **document** ID. `search` and `list` return
extracted **memory** IDs. `forget` checks the memory's namespace and scope before
removing it from normal recall; it preserves Supermemory audit history and source
documents. This tool is not a permanent document-erasure API.

## Configuration

All options are optional. Environment variables take precedence over JSONC.

```jsonc
{
  "apiKey": "sm_...",
  "baseUrl": "https://api.supermemory.ai",
  "recallMode": "direct", // direct | advisory | off
  "captureEnabled": true,
  "injectProfile": true,
  "maxMemories": 5,
  "maxProfileItems": 5,
  "similarityThreshold": 0.55,
  "recallTimeoutMs": 3000,
  "requestTimeoutMs": 8000,
  "maxContextChars": 8000,
  "isolateWorktrees": false,
  // "projectContainerTag": "my_explicit_namespace",
  // "stateDir": "/absolute/path/to/local/checkpoints"
}
```

| Environment variable | Purpose |
| --- | --- |
| `SUPERMEMORY_API_KEY` | API key |
| `SUPERMEMORY_CONFIG` | Override the global JSONC file path |
| `SUPERMEMORY_API_URL` / `SUPERMEMORY_BASE_URL` | API base URL |
| `SUPERMEMORY_REPO_TAG` | Explicit namespace override |
| `SUPERMEMORY_ISOLATE_WORKTREES` | `true` or `false` |
| `SUPERMEMORY_STATE_DIR` | Local checkpoint directory |

The client uses the official **Supermemory v5 SDK**, including `ns/...` routes.
Custom servers must implement that API. There is no legacy API fallback or
automatic rerouting to hosted Supermemory.

### Scoping and compatibility

Default namespace: `repo_<sanitized-repository-name>__<16-char-sha256>`.
The hash uses normalized Git `origin`, or the repository's real path if there is
no origin. SSH and HTTPS origins share an identity; different remotes remain
isolated. Worktrees share the main repository unless isolation is enabled.
Metadata `sm_scope` is `project` or `personal`.

Current OpenCode memories using this convention are shared automatically when
both integrations use the same account/API endpoint. Custom namespaces require
the same explicit override. Historical `opencode_project_*`/`opencode_user_*`
containers and other agents' config overrides are not automatically discovered.

## Hook behavior and limitations

- `PreInvocation` reads the transcript path supplied by Antigravity and injects
  an `ephemeralMessage`. Repeated model/tool-loop calls for the same user prompt
  do not repeat searches. `off` disables hook recall, not explicit MCP tools.
- `Stop` acts as a **turn boundary**, not session shutdown. Only `fullyIdle: true`
  permits capture. New turns are uploaded individually; raw tool output and
  thinking are not collected. Disable this with `captureEnabled: false`.
- Transcript extraction supports current `USER_INPUT`/`PLANNER_RESPONSE` text
  records and explicit `role`/`content` records. It reads only the supplied file,
  not private databases or other conversation directories. Unknown records and
  incomplete JSON lines are skipped; missing, oversized (>20 MiB), or changed
  transcript formats can prevent automatic recall/capture. MCP tools still work.
- Capture checkpoints contain hashes, not conversation text, under
  `~/.cache/antigravity-supermemory/`. File leases protect simultaneous hooks;
  checkpoints advance after acknowledged uploads. Failed saves can retry on a
  later idle Stop. Stable IDs reduce duplication but do not guarantee exactly-once
  processing/billing after an ambiguous response. Removing checkpoints may replay
  old turns; changing transcript indices can change capture identity.
- Hook errors fail open, print sanitized diagnostics to stderr, and produce valid
  JSON. Capture has a bounded per-hook budget; a large backlog may require later
  Stop events. Pending captures cannot be flushed after Antigravity is killed.
- Rules guide model behavior; they cannot guarantee that an explicit memory tool
  is called. There is no native compaction interception, browser OAuth flow, or
  OpenCode-style status footer in this release.

## Development and verification

```sh
npm ci
npm run check
agy plugin validate plugin --strict --json
npm pack
```

Tests exercise real SDK requests against a local mock HTTP service, a real stdio
MCP client/server handshake using the installed standalone runtime, hook timeouts, capture retries/concurrency, privacy,
repository scoping, and non-destructive installation/uninstallation. They need no
API key and do not contact hosted Supermemory. Antigravity CLI 1.4.0's validator
accepts the bundled plugin. Full IDE operation with a live Supermemory account
requires a manual smoke test after configuration. The npx tarball install has also
been verified with hooks and MCP still working after deleting the npx cache and
the source tarball.

For portable native-plugin distribution, install this npm package globally from
an `npm pack` tarball and use `agy plugin install /path/to/checkout/plugin`.
The checked-in template invokes `antigravity-supermemory` on PATH; the recommended
CLI installer replaces these with absolute commands.

References: [plugins](https://antigravity.google/docs/plugins/),
[hooks](https://antigravity.google/docs/hooks/),
[MCP](https://antigravity.google/docs/mcp/),
[rules](https://antigravity.google/docs/rules/).

MIT licensed.

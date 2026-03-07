# Agent Instructions for chatluna-character

This file defines how agentic tools should work in this repository.
It applies to the entire tree under the repo root.

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- Prefer automation: execute requested actions without extra confirmation unless
  blocked by missing info or safety/irreversibility.

## Repo & Branches

- Koishi plugin (TypeScript, ESM) that lets LLMs role-play as a group chat
  member. Depends on `koishi` and `koishi-plugin-chatluna`.
- Default branch is `main`; use `main` or `origin/main` for diffs.
- No monorepo structure; everything lives at the repo root, source under `src/`.
- Build output goes to `lib/`; never hand-edit files there.
- If `.cursor/rules`, `.cursorrules`, or `.github/copilot-instructions.md` are
  added later, follow them in addition to this file.

## Tooling & Commands

### Install

- Use Node.js >= 18 and Yarn.
- Install dependencies: `yarn install`

### Build

- Full build (includes dynamic-import processing): `yarn build`
- Fast build (skip dynamic-import step): `yarn fast-build`
- Both delegate to `yakumo` which runs `tsc` then `esbuild`.

### Lint

- Run ESLint: `yarn lint`
- Auto-fix: `yarn lint-fix`
- ESLint uses `@typescript-eslint`, `prettier`, and `standard` configs.
- Do **not** add new linters/formatters or config files without an explicit
  request.

### Tests

- There are currently **no** test files or test runner configured.
- Do **not** introduce a test framework unless explicitly requested.

## Project Architecture

```
src/
  index.ts          — Plugin entry: exports apply(), Config schema, injects
  plugin.ts         — Sequentially applies all sub-plugins from src/plugins/
  preset.ts         — Preset loading (YAML), file watching, schema registration
  types.ts          — Shared interfaces & types
  utils.ts          — Response parsing, XML lexer, markdown rendering, LLM chain creation
  service/
    message.ts      — Core service (MessageCollector extends Service): message storage,
                      group state, concurrency locks, filter dispatch, broadcast pipeline
  plugins/
    chat.ts         — LLM response pipeline: model selection, message preparation,
                      streaming, response parsing, sending with typing delays
    commands.ts     — Koishi commands (chatluna.character.clear etc.)
    config.ts       — Dynamic schema registration for model selection
    filter.ts       — Activity scoring, trigger detection, idle/wake-up/next-reply scheduling
    interception.ts — Intercepts ChatLuna main plugin events for character-handled groups
resources/
  presets/          — Default YAML preset files, copied to user data dir on first run
```

### Plugin Lifecycle

```
index.ts apply()
  -> ctx.plugin(MessageCollector)         // registers ctx.chatluna_character service
  -> ctx.plugin({ apply: on('ready') })   // after ready: init presets, run plugins()
  -> ctx.middleware()                      // calls service.broadcast() for every message

plugin.ts plugins()
  -> sequentially calls: [chat, commands, config, filter, interception]

Data flow:
  User message -> middleware -> service.broadcast(session)
    -> store message, run filters (filter.ts)
    -> if triggered: acquireResponseLock -> emit 'chatluna_character/message_collect'
    -> chat.ts handler: prepare messages -> stream model -> parse -> send -> release lock
```

### Key Abstractions

| Abstraction | Location | Description |
|---|---|---|
| `MessageCollector` | `service/message.ts` | Koishi `Service` registered as `ctx.chatluna_character`. Central coordinator for message storage, group locks, filter dispatch |
| `Preset` | `preset.ts` | Loads/watches YAML presets from disk, registers dynamic schema |
| `ChatLunaChain` | `types.ts` + `utils.ts` | Wraps LangChain agent executor for tool-calling LLM invocation |
| `GroupInfo` | `types.ts` + `filter.ts` | Per-group activity state: message counts, timestamps, scoring thresholds, pending triggers |
| `GroupLock` | `types.ts` + `service/message.ts` | Per-group mute timer + response mutex to serialize LLM calls |

### Service Access Patterns

The `MessageCollector` service is the single entry point for cross-module interaction:

```ts
// Available everywhere via Koishi DI
ctx.chatluna_character.broadcast(session)
ctx.chatluna_character.getMessages(groupId)
ctx.chatluna_character.mute(session, time)
ctx.chatluna_character.collect(handler)
ctx.chatluna_character.addFilter(filter)
ctx.chatluna_character.triggerCollect(session, reason)
ctx.chatluna_character.preset  // Preset instance
ctx.chatluna_character.logger  // Logger instance
```

### Per-Group Config Merging

The pattern for per-group configuration override is consistent across the codebase:

```ts
const guildConfig = config.configs[guildId]
const merged = Object.assign({}, config, guildConfig)
```

Use this exact pattern. Do not create helper functions for it.

### Module Augmentation

The project extends Koishi's type system via `declare module 'koishi'`:

```ts
// in service/message.ts
declare module 'koishi' {
    export interface Context {
        chatluna_character: MessageCollector
    }
    export interface Events {
        'chatluna_character/message_collect': (...) => void | Promise<void>
    }
}
```

When adding new services or events, follow this exact pattern in the relevant
file.

## Code Style (MANDATORY)

### Simplicity First

THIS IS THE MOST IMPORTANT RULE FOR AGENT-WRITTEN CODE.

Write the **simplest possible code** that works. Fewer abstractions, fewer
functions, fewer variables. If in doubt, inline it.

- **Do NOT create `resolveXXX`, `normalizeXXX`, `ensureXXX`, `toSafeXXX`
  functions.** These are banned patterns.
- **Do NOT add defensive/fallback checks.** Do not guess what types or
  structures might be. Use the most probable type directly. If it turns out
  wrong at runtime, we will tell you and you fix it then.
- **Do NOT wrap values in helper functions.** If a value needs a simple
  transform, do it inline.
- **Do NOT create extra functions for short logic.** If a function body would
  be 1-5 lines, inline it at the call site instead.

```ts
// BANNED — do not write code like this
function normalizeNumberValue(value?: number | string | bigint | null) {
    if (value == null) return undefined
    const numberValue = Number(value)
    if (Number.isNaN(numberValue)) return undefined
    return numberValue
}

// BANNED — unnecessary wrapper
function resolveGuildId(session: Session): string {
    return session.guildId ?? session.channelId ?? ''
}

// BANNED — unnecessary abstraction
function ensureArray<T>(value: T | T[]): T[] {
    return Array.isArray(value) ? value : [value]
}

// GOOD — use the value directly, trust the type
const guildId = session.guildId
const count = Number(rawCount)
```

### Maximize Implementation

THIS RULE IS MANDATORY.

- **Always implement the full feature.** Never leave placeholder comments like
  `// TODO: implement later`, `// ... rest of implementation`, or
  `// add more cases as needed`.
- **Never write stub functions** that return dummy values or throw
  "not implemented" errors.
- **Never truncate code** with `// ...` or `// similar for other cases`.
  Write every case, every branch, every line.
- **If a function needs 200 lines, write 200 lines.** Do not artificially
  split it or leave parts unfinished.
- If you are uncertain about a specific implementation detail, make your best
  guess and implement it fully. We will correct you if wrong. An incorrect
  full implementation is **always** preferable to a correct but incomplete
  skeleton.

```ts
// BANNED — incomplete implementation
async function handleResponse(response: string) {
    const parsed = parseMessageContent(response)
    // TODO: handle voice and sticker cases
    return parsed
}

// GOOD — full implementation, every case handled
async function handleResponse(response: string) {
    const parsed = parseMessageContent(response)
    if (parsed.messageType === 'voice') {
        // full voice handling code here...
    }
    if (parsed.sticker) {
        // full sticker handling code here...
    }
    return parsed
}
```

### Inline Over Extract

Prefer inline code over extracting into functions. A function is justified only
when it is called from **multiple distinct call sites** with **non-trivial
logic** (> ~5 lines).

```ts
// GOOD — inline one-shot logic
const messages = config.configs[guildId]
    ? Object.assign({}, config, config.configs[guildId])
    : config

// BAD — unnecessary extraction for single-use logic
function getMergedConfig(config: Config, guildId: string) {
    const guildConfig = config.configs[guildId]
    return guildConfig ? Object.assign({}, config, guildConfig) : config
}
const messages = getMergedConfig(config, guildId)
```

### No Speculative Defensive Code

Do not add type guards, null checks, or fallback values unless there is
**concrete evidence** (from existing code or reported error) that the value can
actually be null/undefined/wrong-type.

```ts
// BANNED — speculative defense
const name = session.username ?? session.userId ?? 'unknown'
const elements = session.elements ?? []
const content = typeof raw === 'string' ? raw : String(raw ?? '')

// GOOD — trust the types, use directly
const name = session.username
const elements = session.elements
const content = raw
```

If something actually can be undefined (as declared in the interface with `?`),
a single simple check is fine. But do not chain fallbacks or add checks for
types that are not declared optional.

### Extract Class-Independent Functions

If a method inside a class does **not** depend on the class instance (`this`) —
i.e. it does not read or write instance fields, call other instance methods, or
use injected services — it **must** be extracted as a standalone module-level
function.

Class methods should only contain logic that genuinely needs instance state.
Pure computation, formatting, parsing, and other self-contained logic belong
outside the class.

```ts
// BAD — method does not use `this` at all
class MessageCollector extends Service {
    formatTimestamp(ts: number): string {
        return new Date(ts).toISOString()
    }
}

// GOOD — extracted as a standalone function
function formatTimestamp(ts: number): string {
    return new Date(ts).toISOString()
}
```

### Minimize Constants

Do **not** define named constants unless the value is truly important and
reused. Inline literal values directly at the call site when they are used
once or are self-explanatory.

Only extract a constant when **all** of the following apply:

1. The value is used in **multiple** places, OR
2. The meaning of the literal is **not obvious** from context, OR
3. The value is a **critical tuning parameter** that may need adjustment.

```ts
// BAD — unnecessary constants for one-off or obvious values
const MAX_RETRY_COUNT = 1
const DEFAULT_SEPARATOR = '\n'
const EMPTY_STRING = ''

// GOOD — inline obvious values
await retry(() => fetch(url), 1)
messages.join('\n')

// GOOD — constant is justified (tuning parameter, used in multiple places)
const WINDOW_SIZE = 10
const MIN_COOLDOWN_TIME = 3000
```

## TypeScript Style

- Use modern ES modules (`.ts`).
- Target `es2022` as configured in `tsconfig.json`.
- Prefer `const` over `let` and never use `var`.
- Prefer early returns over deep nesting and `else` chains.
- Avoid `any` where possible; if needed for interop (LangChain, koishi
  internals), keep it localized.
- Use interfaces/types for exported shapes; define them in `types.ts` for
  shared types or near the top of the file for local types.
- Use TypeScript's type inference for local variables; avoid redundant type
  annotations.
- Prefer functional array methods (`map`, `filter`, `flatMap`) over manual
  loops when clarity is maintained.

### Derived Types

The codebase uses advanced TypeScript patterns for deriving types. Follow these
patterns:

```ts
// Derive from function return type
type ParsedResponse = Awaited<ReturnType<typeof parseResponse>>

// Extract from service method parameters
type Configurable = Parameters<
    ChatLunaService['promptRenderer']['renderTemplate']
>[2]['configurable']
```

### Discriminated Unions

Use discriminated unions with a `type` field for variant types:

```ts
export type NextReplyPredicate =
    | { type: 'time'; seconds: number }
    | { type: 'id'; userId: string }
    | { type: 'time_id'; seconds: number; userId: string }
```

## Formatting

- **4-space indentation** (configured in `.prettierrc`).
- **Single quotes** for strings (`'hello'` not `"hello"`).
- **No semicolons** (configured: `semi: false`).
- **No trailing commas** (configured: `trailingComma: "none"`).
- **Max line width: 80** (prettier) / **160** (eslint warning).
- Arrow functions always use parentheses: `(x) => x` not `x => x`.
- Follow existing code style in surrounding context when editing.

## Imports

- Use ESM import syntax at the top of the file.
- Group imports roughly in this order:
  1. Node built-ins (`fs`, `path`, `url`).
  2. Third-party packages (`@langchain/core`, `js-yaml`, `marked`, `he`).
  3. Koishi framework (`koishi`).
  4. ChatLuna imports (`koishi-plugin-chatluna/...`).
  5. Local imports (`./types`, `./utils`, `../service/message`).
- Empty type-only imports for augmentation are used and accepted:
  ```ts
  import type {} from 'koishi-plugin-chatluna/services/chat'
  import {} from '@initencounter/vits'
  ```

## Naming Conventions

- **PascalCase** for classes, interfaces, types, enums: `MessageCollector`,
  `GroupInfo`, `PresetTemplate`.
- **camelCase** for functions, variables, parameters: `calculateActivityScore`,
  `groupInfos`, `triggerReason`.
- **UPPER_SNAKE_CASE** for constants: `WINDOW_SIZE`, `RECENT_WINDOW`,
  `MIN_COOLDOWN_TIME`.
- **Underscore prefix** for private class members: `_messages`, `_filters`,
  `_groupLocks`.
- **Files** use lowercase: `chat.ts`, `filter.ts`, `message.ts`.
- Plugin entry functions are always named `apply`.
- For new TypeScript **locals, parameters, and small helpers**, prefer short
  names when they stay clear: `ctx`, `el`, `msg`, `cfg`, `err`, `opts`.
  - Multi-word names are fine when a single word would be confusing
    (`activityScore`, `triggerReason`, `currentTokens`).

### Naming Enforcement (Read This)

THIS RULE IS MANDATORY FOR AGENT-WRITTEN CODE.

- Use short names by default for new locals, params, and helper functions.
- Multi-word names are allowed only when a single word would be unclear or
  ambiguous.
- Do not introduce new camelCase compounds when a short single-word
  alternative is clear.
- **Before finishing edits, review touched lines and shorten newly introduced
  identifiers where possible.**
- Good short names to prefer: `ctx`, `cfg`, `err`, `opts`, `el`, `msg`,
  `idx`, `state`, `result`.
- Examples to avoid unless truly required: `inputElement`, `existingConfig`,
  `resolvedTimeout`, `formattedMessage`.

```ts
// Good
const score = calculateActivityScore(info, now)
function format(msg: Message) {}

// Bad
const activityScoreResult = calculateActivityScore(groupInfo, currentTime)
function formatSingleMessage(messageItem: Message) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const prompt = `${systemPrompt}\n${formatTimestamp(Date.now())}`

// Bad
const timestamp = formatTimestamp(Date.now())
const prompt = `${systemPrompt}\n${timestamp}`
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
session.guildId
session.userId
config.maxTokens

// Bad
const { guildId, userId } = session
const { maxTokens } = config
```

Exception: destructuring is fine when it improves readability in function
parameters or when the source object name is very long.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of
reassignment.

```ts
// Good
const merged = guildConfig
    ? Object.assign({}, config, guildConfig)
    : config

// Bad
let merged
if (guildConfig) merged = Object.assign({}, config, guildConfig)
else merged = config
```

### Control Flow

Avoid `else` statements when a simple early return works.

```ts
// Good
function getPreset(name: string) {
    if (!name) return defaultPreset
    return presets.find((p) => p.name === name)
}

// Bad
function getPreset(name: string) {
    if (!name) return defaultPreset
    else return presets.find((p) => p.name === name)
}
```

## Koishi Plugin Patterns

### Plugin Entry

Every sub-plugin exports an `apply` function:

```ts
export function apply(ctx: Context, config: Config) {
    // plugin logic
}
```

Sub-plugins in `src/plugins/` are called directly as functions (not via
`ctx.plugin()`), sequentially in `plugin.ts`.

### Service Registration

Services extend `Service` and call `super(ctx, 'service_name')`:

```ts
export class MessageCollector extends Service {
    constructor(public readonly ctx: Context, public _config: Config) {
        super(ctx, 'chatluna_character')
    }
}
```

### Event Handling

```ts
ctx.on('ready', async () => { /* ... */ })
ctx.on('dispose', () => { /* cleanup */ })
ctx.middleware((session, next) => { /* ... */ })
ctx.setInterval(fn, ms)
```

### Command Registration

```ts
ctx.command('chatluna.character')
    .option('flag', '-f <value>')
    .action(async ({ session, options }) => { /* ... */ })
```

## Error Handling

- Use `try`/`catch` around LLM calls and file I/O; log via `logger.error(e)`.
- Always release response locks in `finally` blocks.
- Use `ChatLunaError` with specific error codes for preset/model errors.
- For streaming retry: catch, sleep 3s, retry once, then propagate.
- Do NOT add speculative error handling for paths that have no evidence of
  failing.

## Key Dependencies

| Package | Usage |
|---|---|
| `koishi` | Framework: Context, Service, Session, Schema, h (element builder), Logger |
| `koishi-plugin-chatluna` | LLM platform: models, chains, agents, prompt rendering, token counting |
| `@langchain/core` | Message types (BaseMessage, HumanMessage, AIMessageChunk), RunnableConfig |
| `js-yaml` | YAML preset file parsing |
| `marked` | Markdown-to-element rendering for model output |
| `he` | HTML entity decoding in parsed text |

## Agent-Specific Tips

- When editing `filter.ts`, be careful with the activity scoring algorithm
  constants — they are tuned and changes have large behavioral impact.
- The response lock in `service/message.ts` uses a "latest-wins" strategy:
  when multiple requests queue, only the most recent waiter is resolved. Do
  not change this behavior without understanding the concurrency model.
- `utils.ts` contains a hand-written XML tag lexer (`textMatchLexer`). It
  handles nested tags, attributes, and multiple tag types. Extend it by
  adding entries to `tagMappings` or adding new explicit tag handlers in the
  main loop.
- Preset templates use ChatLuna's `promptRenderer.renderTemplate()` for
  variable interpolation. Template variables are passed as a plain
  `Record<string, string>`.
- The `processElements` function in `utils.ts` converts parsed model output
  into sendable Koishi element arrays, handling message splitting, quote
  attachment, voice rendering, and fragment management.
- When in doubt about patterns, look at `src/plugins/chat.ts` and
  `src/service/message.ts` — they are the most representative files.

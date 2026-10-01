# prompt-optimizer (Claude Code Mod)

[한국어](README.md) | **English**

Every command, configuration key, and default in this document is taken only from values confirmed in this repository's code (`.claude-plugin/plugin.json`, `hooks/*`) and in the help of the installed CLI 2.1.285.

## 1. Introduction

When you press Enter in the normal prompt box, an eligible submission is intercepted before it reaches the main session. The optimizer refines that request with a separate cheap model and puts the result back in the prompt box. You press the final Enter.

Full flow (based on the code):

1. The `prompt.submit` event checks the origin, trigger, and in-progress state (`hooks/eligibility.ts`).
2. If the submission is to be intercepted, the original text and the submission context are kept in plugin memory.
3. Inside the same submit hook, it either opens a pane (it must open within the user's keypress so that it can be laid out even on a narrow terminal) or chooses the prompt-box dialogue mode (`chooseUi` in `hooks/register.ts`).
4. The submit hook does not wait for the model and returns `{ drop: '프롬프트를 다듬는 중입니다.' }` (the Korean means "Refining the prompt."). The original text does not go to the main model.
5. A job scheduled with `$.clock.after(1, ...)` reads the context once (`hooks/context.ts`) and calls `$.model.complete` once (`hooks/model.ts`).
6. Each time the user refines in the pane/prompt box, one round is added (3 rounds maximum by default).
7. "입력창에 넣기" (Put in prompt box) runs `prompt.fill` with the improved draft and issues a one-shot bypass. When the user edits it and presses Enter, only that draft passes through interception and goes to the main session.

**What it refines**

The optimizer classifies the request by type before refining it. A change is judged by the requested change and the verification result, a diagnosis by the cause, evidence, and unconfirmed points, research by a sourced answer, and writing by text in the requested format; a long-output requirement is checked as well. When a problem description, question, idea, or plan contains no change request, it is treated as a diagnosis and refined into a request that reports only the cause and evidence without modifying anything; an explicit change request is kept as a change. A short, clear request with a single goal and a simple deliverable is kept as a natural sentence, while one with several conditions, inputs, or steps, or a long-output requirement, is organized into the four fields goal/context/scope/done criteria. The add-on guidance matched to the main session model is described in 5.4.

**Why and how it is separated from the main session**

- The improvement dialogue lives only in the plugin's own state (`RuntimeState`) and is not recorded in the main transcript.
- There is only one model call, `$.model.complete`. It does not use `$.model.fork`, `agent.spawn`, the Agent SDK, `prompt.context`/`prompt.section`, or transcript rewriting/compaction. So it does not consume the main session's turns or context cache prefix.
- Context is read read-only only (`$.session.messages`, `$.fs`, `$.session.cwd/root/repo`).
- **However, it is billed against the same account's usage.** The separation above means it does not touch the main session's cache prefix or turns; it does not mean the optimizer calls are free or on a separate quota.

## 2. Requirements

| Item | Value | Basis |
|---|---|---|
| Claude Code | 2.1.285 or newer | The version used in this repository for verification and type generation: `2.1.285` |
| Mod (function hook) support | early access | The hook modules are not turned on without the flag |
| Required environment variable | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | Without it, `claude plugin test` refuses with "hooks modules are not turned on in this build yet (early access)" |
| For development | Node.js + npm | Needed to run `scripts/*.mjs` and `claude plugin test` |

The Mod API is early access, so the contract can change between versions. Indeed, the `model.complete` return shape changed between 2.1.277 → 2.1.285 (`docs/DESIGN.md`). Each time you upgrade the CLI, verify again with `npm run typecheck`.

## 3. Installation and running

The marketplace name is `prompt-optimizer-cc`, and the plugin name is `prompt-optimizer`.

Install from a terminal:

```bash
claude plugin marketplace add RunaticMoon/prompt-optimizer-cc
claude plugin install prompt-optimizer@prompt-optimizer-cc
```

`marketplace add` has a `--scope` option (user by default / project / local).

To install from inside a session:

```text
/plugin marketplace add RunaticMoon/prompt-optimizer-cc
/plugin install prompt-optimizer@prompt-optimizer-cc
```

Running it still requires the `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` environment variable. Without it, the hook modules are not turned on and nothing is intercepted.

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

To put it in your shell profile:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

Or put it in the `env` of your Claude Code settings file (`~/.claude/settings.json`) so it is on in every session without shell setup:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

If the settings file already exists, merge into its `env` key instead of overwriting other settings.

Update:

```bash
claude plugin marketplace update prompt-optimizer-cc
claude plugin update prompt-optimizer@prompt-optimizer-cc
```

Remove:

```bash
claude plugin uninstall prompt-optimizer@prompt-optimizer-cc
```

### 3.1 For development and local checkouts

You can also load a checked-out directory directly into a session.

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 \
  claude --plugin-dir /path/to/prompt-optimizer
```

- `--plugin-dir <path>`: loads the plugin into that session only (`claude --help`). It accepts a directory or a `.zip`, and can be given repeatedly.
- When it loads, the modules from `.claude-plugin/plugin.json` and `hooks/hooks.json` (`./register.ts`) come up together.
- Running without the same flag leaves the hooks off, so nothing is intercepted.

Skill-directory scaffolding (`claude plugin init|new`) is not provided by this repository.

## 4. Usage

### 4.1 Basic flow

1. Type a request in the prompt box and press Enter.
2. The hook blocks the submission (`프롬프트를 다듬는 중입니다.`, "Refining the prompt.") and opens the pane (when possible). On a narrow terminal it falls back to prompt-box dialogue mode.
3. In the pane, refine the improvement request, or use the buttons to handle the result once it arrives.
4. Press **입력창에 넣기** (Put in prompt box) (recommended) to put the improved draft in the prompt box, review and edit it yourself, then press Enter.

### 4.2 Pane buttons and key flow

The pane title is `프롬프트 옵티마이저` ("Prompt Optimizer"), its height is 18 rows, focus is taken on the requested pane, and it can be closed with Esc (`hooks/ui/ui-ports.ts`).

| Button / input | Behavior |
|---|---|
| **입력창에 넣기 (수정 후 전송)** (Put in prompt box; edit before sending) | Closes the pane, fills the prompt box with the improved draft via `replace`, and issues a one-shot bypass. Review or edit it, then send with Enter. |
| **보완 내용** (Refinement) input (`Enter로 다시 다듬기`, Enter to refine again) | Runs one more round with the entered refinement. Focus returns to the prompt-box button after completion. |
| **개선안 바로 전송** (Send improved draft now) | Immediately sends the improved draft via `$.prompt.submit`. The origin is the engine-attached `plugin` and is not forged. |
| **원문 그대로 전송** (Send original unchanged) | Immediately sends the stored original text without editing it. |

If the pane is unfocused, use `ctrl+x tab` to focus it. Focus starts on **입력창에 넣기** (Put in prompt box), so Enter activates it. `Tab` moves through the refinement input, Send improved draft now, and Send original unchanged. Enter in the refinement input starts another refinement. Arrow keys (↑↓) depend on the pane placement (a side pane moves focus; the bottom pane on a narrow terminal scrolls the body), so the pane's key hint shows only `Tab`, and `Tab` or digits are the reliable choice. `Esc` closes and cancels the pane.

| Digit | Button |
|---|---|
| `1` | Put in prompt box; edit then send (`입력창에 넣기`) |
| `2` | Send improved draft now (`개선안 바로 전송`) |
| `3` | Send original unchanged (`원문 그대로 전송`) |
| `0` | Show / hide full original (shown when the original exceeds 24 characters in a narrow layout or 180 in a wide layout) |

`Cmd+Enter` is unsupported in the Pane: the Mods API accepts only one digit or lowercase letter for a Button `hotkey`. Use `2` to send immediately.

Displayed state: it shows the stage (`수집 중`/`생성 중`/`검토`/`실패`/`전달 중`/`전송 중` — collecting / generating / reviewing / failed / delivering / sending), `n/최대회` (n/max rounds), the total returned tokens, the current draft, the latest optimizer message in its own section, and the original summary. The original toggle appears when the original exceeds 24 characters in a narrow layout (pane body at most 90 columns) or 180 characters in a wide layout.
On a narrow terminal, the pane's limited height may put the original below the first screen. Use `Tab` to move to the toggle or press `0` to access it.

### 4.3 Display by surface

The pane is drawn not only in the terminal but also on other surfaces such as `desktop` and `vscode` (`ui.render` in `hooks/ui/register.tsx` now looks only at the pane id and no longer filters by `surface`). If a surface does not provide buttons or input elements (for example, mobile), the pane shows only a read-only text summary and points to the command path.

- Text-only pane display: stage, round, tokens, the full original text, the current improved draft, optimizer messages/errors, and `명령: /optimize accept · send · raw · cancel · retry <보완>` (command: ...).
- Even on surfaces without buttons or input, all the same actions can be performed with the `/optimize` command.

### 4.4 Narrow terminals and composer mode

If the pane cannot be laid out or `uiMode` is `composer`, the improvement dialogue takes place in the prompt box. In this case:

- Status line: `옵티마이저 <단계> (n회) · 보완 내용을 입력해 Enter · /optimize accept(입력창으로) · /optimize send · /optimize raw · /optimize cancel` ("Optimizer <stage> (n rounds) · type a refinement and press Enter · ...").
- Type a refinement and press Enter → handled as a refinement request (`refine`).
- A prompt-box submission while still generating (collecting/generating/delivering/sending) is dropped with `프롬프트 옵티마이저가 작업 중입니다. /optimize cancel 로 취소할 수 있습니다.` ("The prompt optimizer is working. You can cancel with /optimize cancel.").
- End it with slash commands (table below).
- **How it is displayed**: unlike pane mode, composer mode emits the improved draft, optimizer messages, errors, and notifications as `$.ui.log` notifications (`hooks/ui/present.ts`). Pane mode uses only `$.ui.invalidate`/`$.ui.toast` and does not store the dialogue via `$.ui.log`.

### 4.5 Raw bypass and prefix mode

- **Raw bypass**: a submission starting with `rawPrefix` (default `::raw `) has only the prefix stripped and the rest passed through to `next` unchanged. If what follows the prefix is empty or only whitespace, it neither refines nor sends and is dropped with `보낼 내용이 없습니다.` ("There is nothing to send.") (the prefix does not go to the main session).
- **Prefix mode**: when `triggerMode` is `prefix`, only submissions starting with `triggerPrefix` (default `?? `) are improved. The prefix is stripped and the rest is trimmed to become the original text. If the rest is empty, it passes through.
- If the two prefixes overlap, `rawPrefix` wins and `triggerPrefix` reverts to its default (`settlePrefixes` in `hooks/config.ts`).

### 4.6 The `/optimize` command

Command name `optimize`, description `프롬프트 옵티마이저: 개선 시작·승인·전송·설정` ("Prompt Optimizer: start, approve, send, configure improvements"), argument hint `[text|on|off|accept|send|raw|cancel|retry|status|model <id>]` (`hooks/commands.ts`). The first token is compared case-insensitively against the reserved words, and the rest are the arguments.

| Command | Behavior |
|---|---|
| `/optimize [text]` | Starts improvement with the entered text. With no argument, it takes the current prompt-box draft. |
| `/optimize on` / `off` | Turns automatic interception on / off. |
| `/optimize accept` | Brings the improved draft to the prompt box. |
| `/optimize send` | Reserves a send of the improved draft. If a job is in progress or there is no improved draft to send, it does not reserve and prints the reason immediately. |
| `/optimize raw` | Reserves a send of the original text. The reservation conditions are the same as `send`. |
| `/optimize retry [instruction]` | Refines again with the refinement (or the last refinement if none). |
| `/optimize cancel` | Cancels the improvement job. |
| `/optimize status` | Shows the configuration, the current stage, and this session's usage. It includes `옵티마이저 모델:` (optimizer model), `모델별 지침: 켜짐`/`꺼짐(공통 지침만 사용)` (model-specific guidance on/off, off keeps common guidance only), the target model applied to the last optimization (5.4), and `장기 기억 문맥: 켬`/`끔` (long-term memory context on/off). |
| `/optimize model <alias-or-id>` | Changes the optimizer model. |
| `/optimize -- <text>` | Starts improvement even for a sentence that begins with a reserved word. |
| `/optimize help` | Shows command help. |

- If it is not a reserved word (or is escaped with `--`), the entire argument is used as the improvement text.
- `model` with no argument returns a usage error.
- Calling `accept`/`send`/`raw`/`cancel`/`retry` when there is no job in progress returns a single line `진행 중인 개선 작업이 없습니다. ...` ("There is no improvement job in progress. ...").
- The command hook returns only `{ text }` and never carries `context`. In other words, running the command itself does not put the optimizer dialogue into the main model/transcript.
- `send` and `raw` do not call `$.prompt.submit` directly inside the `command.run` hook. While the hook still holds the command turn the host refuses the submission (it would make the submission wait for the in-progress turn), so the command reserves the send with `$.clock.after(0)` and immediately prints `개선안 전송을 예약했습니다.` ("Reserved sending the improved draft.") or `원문 전송을 예약했습니다.` ("Reserved sending the original text."). If a job is in progress or there is no text to send, it does not reserve and prints the reason immediately. If the actual send later fails after the reservation, it is shown as a notification (toast).

These commands first pass through the `prompt.submit` classification as slash commands, and the `command.run` hook (`matcher: { command: 'optimize' }`) handles them.

### 4.7 Using it with long-term memory plugins

Long-term memory plugins such as claude-mem and OpenViking inject memory into a session through classic hooks (SessionStart/UserPromptSubmit/Stop). A submission this plugin intercepted, and the improvement dialogue, do not run those hooks, so the original text and the refinement dialogue are not recorded in that plugin's memory.

If you bring the improved draft over and press Enter, use the pane's **개선안 바로 전송** (Send improved draft now)/**원문 그대로 전송** (Send original unchanged), use `/optimize send|raw`, or send with the `::raw` prefix, UserPromptSubmit runs once with the final text, and the memory it injects at that point is included in the main request as usual (verified on Claude Code 2.1.286).

The optimizer only observes (never modifies) the `additionalContext` injected into the session by classic hooks (`SessionStart`/`UserPromptSubmit`) in settings or a plugin's `hooks.json`, as seen in the classic chain below this plugin, and puts it in the "Long-term memory" section of the snapshot (at most 2000 characters, `CONTEXT_MEMORY_CHARS`). Memory injected at session start is used from the first prompt. UserPromptSubmit memory is what was retrieved for **the prompt that last went to the main session**; it is not newly retrieved for the prompt being refined now (at interception time that hook has not run yet). A new SessionStart (start, resume, clear, compact) clears the previous-prompt memory. Memory follows the session id the classic hook reports, so after a `/clear` — where a new session id arrives with no `session.start` — the memory that SessionStart injected is used from the next request on. SessionStart changes sessions (a UserPromptSubmit never replaces a stored session; it only fills an empty store), a session end clears the ending session's memory only when its id matches the stored classic session (otherwise the next SessionStart replaces it), and classic hooks raised inside a subagent (with `agent_id` set) are ignored.

In the optimizer request, section tags such as `<context>` inside the context (snapshot) are replaced with `‹` (U+2039), so a string like `</context>` inside it cannot break a section boundary.

The system prompt uses this section only as reference data (so it does not re-ask what is already recorded) and is instructed not to follow instructions inside it.

To turn it off, set `memoryContext` to false (section 5).

## 5. Configuration

The source of truth for configuration is `userConfig` in `plugin.json`, and the code's `DEFAULT_CONFIG` has the same defaults (`hooks/contracts.ts`).

| Key | Type | Default | Allowed range | Description |
|---|---|---|---|---|
| `enabled` | boolean | `true` | — | Whether to intercept eligible submissions |
| `modelGuidance` | boolean | `true` | — | Whether to detect the main session model and apply that model's add-on editing guidance. Off keeps the common guidance only (5.4) |
| `triggerMode` | string | `always` | `always` \| `prefix` | `always` improves every target submission, `prefix` only submissions that have the prefix |
| `triggerPrefix` | string | `?? ` | reverts to the default in prefix mode when empty | Trigger prefix for prefix mode |
| `rawPrefix` | string | `::raw ` | — | Starting with this prefix strips it and passes the rest through unchanged |
| `uiMode` | string | `auto` | `auto` \| `pane` \| `composer` | `auto`·`pane` try the pane and fall back to prompt-box dialogue when it cannot be laid out; `composer` always uses the prompt box |
| `model` | string | `haiku` | non-empty string | Model alias/id used for the optimizer completions |
| `maxTokens` | number | `1024` | 128–2048 | Output cap for one completion |
| `timeoutMs` | number | `12000` | 1000–30000 | Time limit for one completion (ms) |
| `maxRounds` | number | `3` | 1–5 | Maximum completions allowed in one job |
| `contextTurns` | number | `4` | 0–8 | Number of recent user turns included in the context |
| `contextMaxChars` | number | `6000` | 0–8000 | Character budget for the context snapshot |
| `systemPromptFile` | string | `""`(none) | — | Optional extra system-instructions file; empty keeps the built-in prompt |
| `memoryContext` | boolean | `true` | — | Include the long-term memory (`additionalContext`) injected by classic hooks (`SessionStart`/`UserPromptSubmit`) in settings or a plugin's `hooks.json` in the optimizer context |

`auto` and `pane` for `uiMode` behave the same way: they try opening the pane first, and if it can be laid out they use the pane; otherwise they fall back to prompt-box dialogue. This matches the current description in `plugin.json` (`chooseUi` in `hooks/register.ts`).

### 5.1 `/config` rows

The `config.set` handler in `register.ts` handles keys starting with the `<plugin>.<key>` prefix, i.e. `prompt-optimizer.`. The `/config` menu shows the following rows.

```text
prompt-optimizer.enabled
prompt-optimizer.modelGuidance
prompt-optimizer.triggerMode
prompt-optimizer.triggerPrefix
prompt-optimizer.rawPrefix
prompt-optimizer.uiMode
prompt-optimizer.model
prompt-optimizer.maxTokens
prompt-optimizer.timeoutMs
prompt-optimizer.maxRounds
prompt-optimizer.contextTurns
prompt-optimizer.contextMaxChars
prompt-optimizer.systemPromptFile
prompt-optimizer.memoryContext
```

Changing a value here is reflected in the base configuration, and any session-only override tied to the same key is cleared.

`claude plugin configure <plugin>` (present in the CLI help) also shows the option values and can save them with `--values-stdin`. However, its interaction with the `--plugin-dir` session-only loader must be verified separately.

### 5.2 Storage scope of `/optimize on|off|model`

- `/optimize on`·`off`·`model <id>` is first applied to the session override layer (`overrides` in `hooks/register.ts`) so it takes effect immediately, and once it passes validation it is saved to the persistent configuration with `$.config.set({ key: 'prompt-optimizer.enabled' | 'prompt-optimizer.model', value })` (`hooks/commands.ts`).
- On a successful save, `설정에 저장했습니다.` ("Saved to settings.") is appended to the result line, and the value is kept on the next run too.
- If the engine denies it (`deny`) or an exception occurs, `이번 세션에만 적용됨(<사유>)` ("Applied to this session only (<reason>)") is appended and it applies only to this session.
- Value validation is done with `validateConfigChange` before saving. If it is refused, only `...하지 못했습니다: <이유>` ("... failed: <reason>") is shown and nothing is saved.
- This save call does not go through the plugin's own `config.set` hook (that hook is for the `/config` menu), so the session override is kept as is.
- Changing the corresponding `/config` row directly changes the base configuration and removes the session override for that key.

### 5.3 Customizing the system prompt

- If `systemPromptFile` is empty, the built-in prompt (`BASE_SYSTEM_PROMPT` in `hooks/system-prompt.ts`) is used.
- If a file is specified, a leading `~` is expanded directly to `HOME` (with no shell execution) and the file is read with `$.fs`.
- At most the first 4000 characters are used; the excess is truncated and a warning is left.
- If the file is missing or cannot be read, it falls back to the built-in prompt and shows a `시스템 프롬프트 파일을 읽지 못해 기본 프롬프트를 사용합니다: <사유>` notification once for that job ("Could not read the system prompt file, so the default prompt is used: <reason>") (the file is read only once at job start, so the notification is also once per job).
- The extra instructions go under `[추가 지침]` ("[Additional instructions]"), and the role limits and JSON output contract (`[고정 계약]`, "[Fixed contract]") are always re-appended at the very end.
- Recommended location: `~/.claude/prompt-optimizer/system-prompt.md`.
- This file is read only once at the start of a job (workflow) and cached for that job. It is read again when a new job/session starts.

### 5.4 Model-specific prompting guidance

What the optimizer produces is **the user message to be sent to the main session model**; the `model` setting (default `haiku`) is a separate model that edits that message. So the two are not confused, status labels the optimizer's own model `옵티마이저 모델:` (Korean for "Optimizer model:").

- **Re-read on every optimization.** Right before the request is assembled in every round — the first call, a retry, and a refinement (`retry`/`refine`) alike — it reads the main session model with `$.session.model()` and adds that model's short add-on guidance to the optimizer's system prompt. After `/model`, the next optimization reflects the new model. A draft already placed in the prompt box is not rewritten automatically.
- **If the model cannot be read within 500 ms or the read fails**, only the common guidance applies and the optimization proceeds as usual. Timeout, rejection, a synchronous throw, an empty value, and a missing port all fall back to common and never become an optimization failure or a change to the existing model settings.
- **The optimizer's own model and effort do not change.** `model` (default `haiku`) and effort `low` stay as they are, and `/optimize model` changes only the optimizer model. The main conversation and the main model settings are untouched. There is no effort-based branching (the plugin cannot read the current effort).
- **Only what takes effect as request wording is distilled.** API/harness settings such as effort, thinking, and max_tokens are excluded from the guidance; only the parts expressible as the request's goal, scope, and completion criteria are kept.

**Supported models**

The raw string from `$.session.model()` is preserved exactly; only a lookup copy is trimmed, lowercased, and stripped of a single trailing `[1m]` and a single trailing `-YYYYMMDD` date. Model-specific guidance is used only when the whole string matches the allowlist exactly; partial matches never map (`hooks/target-model.ts`).

| Model ID | Applied profile |
|---|---|
| `claude-fable-5-1`, `claude-mythos-5-1` | `fable-5-1` |
| `claude-fable-5`, `claude-mythos-5` | `fable-5` |
| `claude-opus-5-5` | `opus-5-5` |
| `claude-opus-5` | `opus-5` |
| `claude-opus-4-8` | `opus-4-8` |
| `claude-sonnet-5-5` | `sonnet-5-5` |
| `claude-sonnet-5` | `sonnet-5` |
| Haiku 4.5 (`claude-haiku-4-5-...`), every other model, alias-only values (`opus`, `sonnet`, …) | `common` (common guidance only) |

- `[1m]` and date suffixes are ignored. For example, `claude-opus-5-5[1m]` and `claude-opus-5-5-20260901[1m]` → `claude-opus-5-5`.
- A version-less alias, a new version outside the allowlist, an empty value, or a non-string value uses the common guidance. It never falls back to a nearby version.
- IDs returned by other providers such as Bedrock, Vertex, and gateways have not been observed, so they use the common guidance.

**Status display**

`/optimize status` does not read the current model at query time; it shows only the detection result applied to the last request actually sent. Example values of `마지막 최적화 대상:` ("last optimization target"):

```text
아직 감지하지 않음
claude-opus-5-5[1m] · 적용: opus-5-5
미확인 · 적용: common (timeout)
감지 생략 · 적용: common (disabled)
```

- `아직 감지하지 않음` ("not detected yet"): no optimization has been detected or sent in this session yet (including session start/reset).
- `<raw> · 적용: <profile>` ("applied: <profile>"): detection succeeded. When it is `common`, the reason is shown too, as `· 적용: common (<reason>)`.
- `미확인 · 적용: common (<reason>)` ("unconfirmed"): the value could not be read (timeout, error, …) and the common guidance was applied.
- `감지 생략 · 적용: common (disabled)` ("detection skipped"): `modelGuidance` is off, so no lookup was made at all.

Right after a setting change, the current toggle and the last round's applied value can differ; the `마지막 최적화 대상` ("last optimization target") label keeps them distinct.

**System prompt assembly order**

`composeSystemPrompt` in `hooks/system-prompt.ts` assembles the final text in this order.

1. The built-in prompt (`BASE_SYSTEM_PROMPT`, which already contains the common editing guidance)
2. The target model's add-on block — omitted when the profile is `common`. Its heading names only the code-defined profile, e.g. `[대상 모델 편집 지침: opus-5-5]` ("[Target-model editing guidance: opus-5-5]"); no raw model string is added.
3. The user's extra instructions (`systemPromptFile`, 5.3) — added under `[추가 지침]` ("[Additional instructions]") only when non-blank after trimming.
4. The fixed contract (`[고정 계약]`, "[Fixed contract]") — always last. It restates the role limits and the JSON output contract, and no additional instruction can override it.

Turning `modelGuidance` off still keeps the common editing guidance, and the fixed contract is always appended last.

**Sources**

- The recommendations in [Anthropic's prompt engineering best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) and the per-model pages (Fable, Opus, Sonnet) were distilled into request wording. The source text is not downloaded at runtime or included in the repository.
- The request classification, the four-field goal/context/scope/done-criteria structure, and the idea of resolving referents came from the `fable-prompt` skill in [oh-my-fable](https://github.com/Junhan2/oh-my-fable) (MIT). That skill's "execute after improving" procedure and its rule of copying the blocks verbatim are not adopted.

## 6. Cost and privacy

- **Call count**: exactly one `$.model.complete` per round. At most `maxRounds` (default 3) per job. There is no automatic retry, higher-model fallback, or fork.
  - However, even if the plugin calls once, **the engine's API client can retry the same request itself on 5xx errors**. In local mock API verification (2.1.285), a single HTTP 500 produced 3 requests (1 initial + 2 retries). `$.model.complete` has no retry option, so the plugin cannot turn it off. In the same verification, a response delay (15 seconds) was aborted after `timeoutMs` (12 seconds) and the original text was restored. It was not checked whether retries are included within the timeout.
- **Default parameters**: model `haiku`, effort `low` (fixed), `maxTokens 1024`, `timeoutMs 12000`.
- **Request composition**: `<context>` + `<original_prompt>` + (if present) `<current_draft>` + `<dialogue>` + `<instruction>` + the JSON output instruction. If the full prompt + system exceeds 16000 characters (`MAX_REQUEST_CHARS`), older dialogue is dropped first, and if it still exceeds, the context is truncated from the end. The original text is not truncated.
- **Context limits**: from the most recent `contextTurns` (default 4) user turns, newest first, at most 8 messages/4000 characters, 1200 characters per message (with `[중략]`, "[omitted]", in the middle), 1200 characters of project rules, 400 characters of cwd/repo, 400 characters of tool names, 2000 characters of long-term memory (`CONTEXT_MEMORY_CHARS`), and 6000 characters total (`contextMaxChars` default). When the total budget is exceeded the oldest conversation lines are dropped first, so when the memory section is present the conversation share shrinks by that 2000 characters. For rule files, only the candidates `root/CLAUDE.md`, `root/.claude/CLAUDE.md`, `cwd/CLAUDE.md` are read, and any over 256 KiB is skipped.
- **Tool results, whole files, and image transcripts are not sent.** Only tool name metadata goes into the context.
- **There is no separate model call to summarize the context.**
- **Long-term memory context**: when `memoryContext` is on (the default), the long-term memory (`additionalContext`) injected by classic hooks (`SessionStart`/`UserPromptSubmit`) in settings or a plugin's `hooks.json` is included in the optimizer model (default `haiku`) request as the "Long-term memory" section of the snapshot (at most 2000 characters, `CONTEXT_MEMORY_CHARS`). This section goes only into the optimizer model request and adds no separate model call. To turn it off, set `memoryContext` to false.
- **No disk storage (plugin state)**: prompts, context, dialogue, bypasses, and usage are only in plugin memory, and the plugin does not write them to files or `$.store`.
- **Transcript rows from composer notifications**: in composer (prompt-box dialogue) mode, the improved draft, optimizer messages, errors, and notifications are emitted as `$.ui.log` notifications, so the host may record them as notification rows in the session transcript file. This is not a dialogue sent as main-model input, and pane mode uses only `$.ui.invalidate`/`$.ui.toast` instead of `$.ui.log`, so it uses only local state (`hooks/ui/present.ts`).
- **No monetary display**: only token usage is shown (the pane header total, and the session total in `/optimize status`). Prices are not fixed. The 0 in a cancel response is "returned usage" and does not guarantee a final provider charge of 0.

## 7. Limitations

- **Attachments (images/audio/documents)**: submissions with attachments are not intercepted. The engine handles them by their original path.
- **In-progress turns and waiting submissions**: submissions with a `turnId` or with `wait === true` are left to the main session's queue as is.
- **Slash commands and shell input**: input starting with `/` or `!` is not intercepted (commands are handled by `command.run`).
- **Overly long originals**: if the original exceeds 6000 characters (`MAX_ORIGINAL_CHARS`), it is passed through without improvement.
- **Context loss on explicit send (Mod hooks only)**: "개선안 바로 전송" (Send improved draft now), `/optimize send`, and `/optimize raw` call only `$.prompt.submit({ text })`. The engine's `PromptSubmitArgs` has no `context` field, so blocks that a Mod hook above this plugin may have attached with `context` on the initial submission are not re-attached on an explicit send. Classic hooks (settings/plugin `hooks.json`), by contrast, run again on an explicit send, so the long-term memory injection is kept (verified on 2.1.286). The default path, where the user restores to the prompt box and presses Enter themselves, is unaffected (that path sends the final text the user put in the prompt box, not the original submission context).
- **Cancel refusals**: cancel is refused while already transferring to the prompt box (`transferring`) or while sending (`sending`) (respectively `입력창으로 옮기는 중이라 취소할 수 없습니다`, "Cannot cancel while transferring to the prompt box", and `전송 중이라 취소할 수 없습니다`, "Cannot cancel while sending"). At the points where an in-progress call is aborted (`collecting`/`generating`/`reviewing`/`failed`), cancel works normally.
- **Empty raw submission drop**: if what follows `rawPrefix` is empty or only whitespace, it is dropped with `보낼 내용이 없습니다.` ("There is nothing to send."). The prefix is not delivered to the main session.
- **Closing the pane = cancel**: pressing Esc/closing in the pane (origin `person`) cancels the job in progress and restores the original text.
- **Restore conflict protection**: if the prompt box has new content typed by the user, it is not overwritten with the improved draft (`draft-conflict`). If the fill is refused, no bypass is issued.
- **Bypass lifetime**: a bypass issued by a restore expires after 10 minutes and is consumed only once. If the user edits, it follows the edited text; if the prompt box is cleared, it is invalidated. If another plugin fills the prompt box, the bypass follows that new text (so it no longer has effect on the original improved draft) and the next Enter is not intercepted, sending that text instead.
- **Composer notifications may remain in the transcript**: in composer mode, the improved draft and messages go out as `$.ui.log` notifications, so the host may save them as notification rows in the session transcript file. Such a row is recorded with the shape `type: "system"`, `subtype: "informational"`, `isMeta: false`, and no role (measured). It does not affect transcript parsers that select user messages only (for example a memory plugin's Stop hook), but a parser that filters on `isMeta` alone can include this row. The improvement dialogue in pane mode does not remain in the transcript (measured). It is not sent as main-model input, and pane mode does not use this path.
- **The optimizer does not newly retrieve memory for the current prompt**: the UserPromptSubmit memory in the long-term memory context (4.7) is what was retrieved for the prompt that last went to the main session; it is not newly retrieved for the prompt being refined now (at interception time that hook has not run yet).
- **Usage is memory-only**: this session's usage is only in plugin memory (`RuntimeState.usage`) and is not saved to `$.store`. It disappears when the session ends.
- **System prompt file fallback notification**: if `systemPromptFile` cannot be read, a `시스템 프롬프트 파일을 읽지 못해 기본 프롬프트를 사용합니다: <사유>` notification ("Could not read the system prompt file, so the default prompt is used: <reason>") is shown once for that job, and the built-in prompt is used.
- **The real effect of the model-specific guidance is unverified**: whether the guidance improves the actual model response depends on the model's response. There is no automated quality evaluation in this repository; the tests guarantee only the normalization, selection, and assembly contract (5.4).
- **500 ms model-detection limit**: reading the main session model must finish within 500 ms (`TARGET_MODEL_TIMEOUT_MS`). If it does not, that round uses only the common guidance and the optimization continues. The `마지막 최적화 대상` ("last optimization target") in `/optimize status` is the last request actually sent, not the current model at query time.
- **Provider-specific model IDs**: ID formats returned by other providers such as Bedrock, Vertex, and gateways have not been observed, so only the common guidance applies.
- **early-access API**: the Mod contract can change (there is a return-shape change history from 2.1.277 → 2.1.285).
- **Real terminal screen verification status**: in this repository's history, the actual terminal behavior of pane layout, focus, and fill has not yet been verified (network errors in the development environment). Verification is planned with the procedure in `docs/smoke.md`, and until then the screen behavior is **unverified**. The automated tests guarantee only the contract on the mock engine.

## 8. Development

```bash
npm ci
```

Type declarations are generated by the CLI into `.claude-plugin/types/` when it loads the Mod. This folder is gitignored and is not committed. If it is still missing, generate it once with the following command that the typecheck script points to (`scripts/check-types.mjs`):

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 \
  claude --plugin-dir . -p "type generation" \
  --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'
```

Check commands:

| Command | What actually runs | What it does |
|---|---|---|
| `npm run typecheck` | `node scripts/check-types.mjs` | Checks that the generated types exist, then runs `tsc -p tsconfig.json` |
| `npm test` | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .` | Runs the Mod tests (no API cost, mock engine) |
| `npm run validate` | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate .claude-plugin/marketplace.json && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate .claude-plugin/plugin.json` | Validates the marketplace, manifest and hooks |
| `npm run check:package` | `node scripts/check-package.mjs` | Checks that no generated types/references/official declarations are among the tracked files |
| `npm run version:bump` | `node scripts/bump-version.mjs <major\|minor\|patch\|X.Y.Z>` | Bumps the version in all three files (`plugin.json`, `package.json`, `package-lock.json`) together and prints the new version |
| `npm run check:version` | `node scripts/bump-version.mjs --check` | Checks that the three files' versions agree |

File structure:

```text
.claude/
  skills/
    release-label/
      SKILL.md         # the Claude Code skill that picks the release label
.claude-plugin/
  plugin.json          # manifest: name and the 14 userConfig keys
  marketplace.json     # Marketplace definition (name, owner, plugins)
  types/               # generated by the CLI, gitignored, do not commit
.github/
  workflows/
    version-bump.yml   # bumps, commits and tags after a merge to main
hooks/
  hooks.json           # {"modules":["./register.ts"]}
  register.ts          # assembly: config resolution, 6 events + UI/command wiring
  contracts.ts         # shared types and constants (defaults, ranges, caps)
  config.ts            # option normalization, reading systemPromptFile
  eligibility.ts       # submission classification rules
  context.ts           # context snapshot collection
  memory.ts            # stores and renders the injected long-term memory
  model-guidance.ts    # common and per-model editing guidance strings
  system-prompt.ts     # built-in prompt + fixed contract
  target-model.ts      # main model string → guidance profile normalization
  resolve-target-model.ts # 500 ms bounded target-model lookup (common on failure)
  model.ts             # single-completion request/response mapping
  state.ts             # pure reducer
  delivery.ts          # prompt-box restore (prompt.fill) and explicit send (prompt.submit)
  controller.ts        # improvement dialogue controller
  commands.ts          # /optimize parsing and dispatch
  ui/
    register.tsx       # ui.render/press/input/close hooks
    present.ts         # composer status/log display
    ui-ports.ts        # pane arguments and UI boundary types
tests/                 # per-module unit tests, UI tests, smoke tests
scripts/
  check-types.mjs
  check-package.mjs
  bump-version.mjs     # bump the version, or check agreement with --check
docs/
  DESIGN.md            # the design document
  smoke.md             # manual and verifier smoke procedure
tsconfig.json          # extends .claude-plugin/types/tsconfig.json
```

Rules:

- The official type declarations in `.claude-plugin/types/` are under Anthropic's proprietary license, so they are not committed to the repository (enforced by `.gitignore` + `scripts/check-package.mjs`).
- Reference folders, official examples, and official `.d.ts` files are likewise not copied and committed.

### 8.1 Versioning and releases

When a PR is merged into `main`, the `Version bump` workflow (`.github/workflows/version-bump.yml`) runs, bumps the version in `.claude-plugin/plugin.json`, `package.json`, and `package-lock.json`, and pushes a `chore(release): vX.Y.Z` commit and a `vX.Y.Z` annotated tag to `main`.

| PR label | Level |
|---|---|
| `semver:major` | major |
| `semver:minor` | minor |
| (none) | patch |
| `skip-release` | no bump (docs/CI-only PRs, etc.) |

- For that reason, do not edit the version value in a PR. The workflow bumps it after the merge.
- Claude Code identifies plugin updates by the version in `plugin.json`, so the version must change for users to get the new code with a `/plugin` update.
- The PR label is chosen by the Claude Code `release-label` skill (`.claude/skills/release-label/SKILL.md`): it reads the change, creates the `semver:`/`skip-release` labels when missing, and applies one of major, minor or skip-release to the PR (no label for a patch).
- The manual commands are `npm run version:bump -- <major|minor|patch|X.Y.Z>` (updates all three files at once and prints the new version) and `npm run check:version` (checks that the three files agree).
- It uses `pull_request_target` so fork PRs are handled too, but it never runs PR code and only checks out `main`.

## 9. License

This repository is under the MIT License. See [LICENSE](LICENSE).

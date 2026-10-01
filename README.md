# prompt-optimizer (Claude Code Mod)

**한국어** | [English](README.en.md)

이 문서의 모든 명령·설정 키·기본값은 이 저장소의 코드(`.claude-plugin/plugin.json`, `hooks/*`)와 설치된 CLI 2.1.285의 도움말에서 확인한 값만 적었다.

## 1. 소개

일반 입력창에 Enter를 누르면, 조건에 맞는 제출은 메인 세션으로 가기 전에 가로채진다. 옵티마이저는 별도의 저렴한 모델로 그 요청을 다듬고, 결과를 다시 입력창에 넣어 준다. 최종 Enter는 사용자가 누른다.

전체 흐름(코드 기준):

1. `prompt.submit` 이벤트에서 출처·트리거·진행 상태를 검사한다(`hooks/eligibility.ts`).
2. 가로챌 제출이면 원문과 제출 문맥을 플러그인 메모리에 보관한다.
3. 같은 제출 훅 안에서 패인을 열거나(사용자의 키 입력 안에서 열어야 좁은 터미널에도 배치된다) 입력창 대화 모드를 고른다(`hooks/register.ts`의 `chooseUi`).
4. 제출 훅은 모델을 기다리지 않고 `{ drop: '프롬프트를 다듬는 중입니다.' }`를 반환한다. 원문은 메인 모델로 가지 않는다.
5. `$.clock.after(1, ...)`로 예약된 작업이 문맥을 한 번 읽고(`hooks/context.ts`) `$.model.complete`를 한 번 호출한다(`hooks/model.ts`).
6. 사용자가 패인/입력창에서 보완하면 라운드가 하나씩 추가된다(기본 최대 3회).
7. "입력창으로 가져오기"로 개선안을 `prompt.fill`하고 일회용 bypass를 발급한다. 사용자가 편집하고 Enter를 누르면 그 초안만 가로채기를 통과해 메인 세션으로 간다.

**메인 세션과 분리되는 이유와 방식**

- 개선 대화는 플러그인 자체 상태(`RuntimeState`)에만 있고 메인 transcript에 기록되지 않는다.
- 모델 호출은 `$.model.complete` 하나뿐이다. `$.model.fork`, `agent.spawn`, Agent SDK, `prompt.context`/`prompt.section`, transcript 재작성·compact를 쓰지 않는다. 그래서 메인 세션의 턴·문맥 캐시 prefix를 소비하지 않는다.
- 문맥은 읽기 전용(`$.session.messages`, `$.fs`, `$.session.cwd/root/repo`)으로만 읽는다.
- **단, 같은 계정의 사용량으로 과금된다.** 위 분리는 메인 세션의 캐시 prefix·턴을 건드리지 않는다는 뜻이며, 옵티마이저 호출이 무료이거나 별도 한도라는 뜻이 아니다.

## 2. 요구사항

| 항목 | 값 | 근거 |
|---|---|---|
| Claude Code | 2.1.285 이상 | 이 저장소에서 검증·타입 생성에 사용한 버전: `2.1.285` |
| Mod(함수 훅) 지원 | early access | 플래그 없이는 훅 모듈이 켜지지 않는다 |
| 필수 환경 변수 | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | 없으면 `claude plugin test`가 "hooks modules are not turned on in this build yet (early access)"로 거부 |
| 개발용 | Node.js + npm | `scripts/*.mjs`, `claude plugin test` 실행에 필요 |

Mod API는 early access라 버전 간 계약이 바뀔 수 있다. 실제로 2.1.277 → 2.1.285 사이에 `model.complete` 반환형이 바뀌었다(`docs/DESIGN.md`). CLI를 올릴 때마다 `npm run typecheck`로 다시 확인한다.

## 3. 설치·실행

마켓플레이스 이름은 `prompt-optimizer-cc`, 플러그인 이름은 `prompt-optimizer`다.

터미널에서 설치:

```bash
claude plugin marketplace add RunaticMoon/prompt-optimizer-cc
claude plugin install prompt-optimizer@prompt-optimizer-cc
```

`marketplace add`에는 `--scope` 옵션이 있다(user 기본 / project / local).

세션 안에서 설치하려면:

```text
/plugin marketplace add RunaticMoon/prompt-optimizer-cc
/plugin install prompt-optimizer@prompt-optimizer-cc
```

실행에는 여전히 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` 환경 변수가 필요하다. 없으면 훅 모듈이 켜지지 않아 아무 것도 가로채지 않는다.

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

셸 프로필에 넣어 두려면:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

또는 Claude Code 설정 파일(`~/.claude/settings.json`)의 `env`에 넣어 두면 셸 설정 없이 매번 켜진다:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

기존 설정 파일이 있으면 `env` 키에 병합하고 다른 설정을 덮어쓰지 않는다.

업데이트:

```bash
claude plugin marketplace update prompt-optimizer-cc
claude plugin update prompt-optimizer@prompt-optimizer-cc
```

제거:

```bash
claude plugin uninstall prompt-optimizer@prompt-optimizer-cc
```

### 3.1 개발·로컬 체크아웃용

체크아웃한 디렉터리를 세션에 직접 올릴 수도 있다.

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 \
  claude --plugin-dir /path/to/prompt-optimizer
```

- `--plugin-dir <path>`: 해당 세션에만 플러그인을 로드한다(`claude --help`). 디렉터리 또는 `.zip`을 받고, 반복 지정할 수 있다.
- 로드되면 `.claude-plugin/plugin.json`과 `hooks/hooks.json`의 모듈(`./register.ts`)이 함께 올라온다.
- 같은 플래그 없이 실행하면 훅이 켜지지 않으므로 아무 것도 가로채지 않는다.

스킬 디렉터리 스캐폴딩(`claude plugin init|new`)은 이 저장소가 제공하지 않는다.

## 4. 사용법

### 4.1 기본 흐름

1. 입력창에 요청을 쓰고 Enter.
2. 훅이 제출을 막고(`프롬프트를 다듬는 중입니다.`) 패인을 연다(가능하면). 좁은 터미널에서는 입력창 대화 모드로 폴백한다.
3. 패인에서 개선 요청을 보완하거나, 결과가 나오면 버튼으로 처리한다.
4. **입력창으로 가져오기**(권장)를 눌러 개선안을 입력창에 넣고, 직접 확인·편집한 뒤 Enter.

### 4.2 패인 버튼

패인 제목은 `프롬프트 옵티마이저`, 높이 18행, 포커스는 요청한 패인에 잡히며 Esc로 닫을 수 있다(`hooks/ui/ui-ports.ts`).

| 버튼 / 입력 | 동작 |
|---|---|
| **입력창으로 가져오기** | 패인을 닫고 개선안을 입력창에 `replace`로 채운 뒤 일회용 bypass를 발급한다. 최종 Enter는 사용자. |
| **바로 보내기** | 개선안을 `$.prompt.submit`으로 즉시 전송한다. 출처는 엔진이 붙이는 `plugin`이며 위조하지 않는다. |
| **원문 보내기** | 보관한 원문을 즉시 전송한다. |
| **다시 다듬기** | 보완어 없이 같은 요청을 한 번 더 생성한다(대화의 마지막 보완어가 있으면 그것을 사용). `라운드 < 최대`이고 진행 중이 아닐 때만 활성. |
| **취소** | 진행 중 호출을 중단(`AbortController`)하고 원문을 입력창에 복원하며 bypass를 발급한다. 자동 전송하지 않는다. Esc/패인 닫기도 같은 동작을 한다. 단, 입력창으로 옮기는 중(`입력창으로 옮기는 중이라 취소할 수 없습니다`)이거나 전송 중(`전송 중이라 취소할 수 없습니다`)이면 거부된다. |
| **보완 내용** 입력(`다듬기`) | 입력한 보완어로 한 라운드를 더 실행한다. |

패인에 포커스가 있을 때 숫자키로 버튼을 실행한다. 포커스가 없다면 `ctrl+x tab`으로 패인에 포커스를 준다. `Tab`은 버튼·입력 요소 사이를 이동하고 `Enter`는 선택한 버튼을 누른다. 방향키는 버튼 이동이 아니라 스크롤에 쓰이며 `Esc`는 패인을 닫는다.

| 숫자키 | 버튼 |
|---|---|
| `1` | 입력창으로 가져오기 |
| `2` | 바로 보내기 |
| `3` | 원문 보내기 |
| `4` | 다시 다듬기 |
| `5` | 취소 |
| `0` | 원문 전체 보기 / 접기 (긴 원문일 때만 표시) |

표시 상태: 단계(`수집 중`/`생성 중`/`검토`/`실패`/`전달 중`/`전송 중`), `n/최대회`, 반환 토큰 합계, 원문 요약(180자 초과 시 "원문 전체 보기" 토글), 최신 옵티마이저 메시지를 보여준다.

### 4.3 표면(surface)별 표시

패인은 터미널뿐 아니라 `desktop`·`vscode` 등 다른 표면에서도 그려진다(`hooks/ui/register.tsx`의 `ui.render`는 이제 `surface`로 거르지 않고 패인 id만 본다). 표면이 버튼·입력 요소를 제공하지 않으면(예: 모바일) 패인은 읽기 전용 텍스트 요약만 보여주고 명령 경로를 안내한다.

- 텍스트 전용 패인 표시: 단계·라운드·토큰, 원문 전체, 현재 개선안, 옵티마이저 메시지·오류, 그리고 `명령: /optimize accept · send · raw · cancel · retry <보완>`.
- 버튼·입력이 없는 표면에서도 `/optimize` 명령으로 같은 동작을 모두 실행할 수 있다.

### 4.4 좁은 터미널과 composer 모드

패인을 배치할 수 없거나 `uiMode`가 `composer`이면, 개선 대화는 입력창에서 진행된다. 이때:

- 상태 줄: `옵티마이저 <단계> (n회) · 보완 내용을 입력해 Enter · /optimize accept(입력창으로) · /optimize send · /optimize raw · /optimize cancel`
- 보완 내용을 입력하고 Enter → 보완 요청으로 처리(`refine`).
- 아직 생성 중(수집/생성/전달/전송)일 때의 입력창 제출은 `프롬프트 옵티마이저가 작업 중입니다. /optimize cancel 로 취소할 수 있습니다.`와 함께 드롭된다.
- 종료는 슬래시 명령으로 한다(아래 표).
- **표시 방식**: 패인 모드와 달리 composer 모드는 개선안·옵티마이저 메시지·오류·알림을 `$.ui.log` 알림으로 내보낸다(`hooks/ui/present.ts`). 패인 모드는 `$.ui.invalidate`/`$.ui.toast`만 쓰고 `$.ui.log`로 대화를 저장하지 않는다.

### 4.5 raw 우회와 prefix 모드

- **raw 우회**: `rawPrefix`(기본 `::raw `)로 시작하는 제출은 접두어만 떼고 나머지를 그대로 `next`로 통과시킨다. 접두어 뒤가 비었거나 공백뿐이면 개선도 전송도 하지 않고 `보낼 내용이 없습니다.`와 함께 드롭된다(접두어가 메인 세션으로 가지 않는다).
- **prefix 모드**: `triggerMode`가 `prefix`이면 `triggerPrefix`(기본 `?? `)로 시작하는 제출만 개선한다. 접두어를 떼고 나머지를 trim해 원문으로 쓴다. 나머지가 비면 통과.
- 두 접두어가 서로 겹치면 `rawPrefix`가 우선하고 `triggerPrefix`는 기본값으로 되돌아간다(`hooks/config.ts`의 `settlePrefixes`).

### 4.6 `/optimize` 명령

명령 이름 `optimize`, 설명 `프롬프트 옵티마이저: 개선 시작·승인·전송·설정`, 인자 힌트 `[text|on|off|accept|send|raw|cancel|retry|status|model <id>]`(`hooks/commands.ts`). 첫 토큰을 대소문자 구분 없이 예약어로 비교하고, 나머지가 인자다.

| 명령 | 동작 |
|---|---|
| `/optimize [text]` | 입력한 텍스트로 개선 시작. 인자가 없으면 현재 입력창 초안을 가져온다. |
| `/optimize on` / `off` | 자동 가로채기 켜기 / 끄기. |
| `/optimize accept` | 개선안을 입력창으로 가져오기. |
| `/optimize send` | 개선안을 지금 전송. |
| `/optimize raw` | 원문을 그대로 전송. |
| `/optimize retry [instruction]` | 보완어(없으면 마지막 보완어)로 다시 다듬기. |
| `/optimize cancel` | 개선 작업 취소. |
| `/optimize status` | 설정·진행 단계·이 세션 사용량 표시. |
| `/optimize model <alias-or-id>` | 옵티마이저 모델 변경. |
| `/optimize -- <text>` | 예약어로 시작하는 문장도 개선 시작. |
| `/optimize help` | 명령 도움말 표시. |

- 예약어가 아니면(또는 `--` 이스케이프) 전체 인자를 개선 텍스트로 쓴다.
- `model`에 인자가 없으면 사용법 오류를 반환한다.
- 진행 중인 작업이 없는데 `accept`/`send`/`raw`/`cancel`/`retry`를 부르면 `진행 중인 개선 작업이 없습니다. ...` 한 줄을 반환한다.
- 명령 훅은 `{ text }`만 반환하고 `context`를 절대 싣지 않는다. 즉 명령 실행 자체로 옵티마이저 대화가 메인 모델/transcript에 들어가지 않는다.

이 명령들은 `prompt.submit` 분류에서 슬래시 명령으로 먼저 통과되고, `command.run` 훅(`matcher: { command: 'optimize' }`)이 처리한다.

## 5. 설정

설정의 기준은 `plugin.json`의 `userConfig`이며, 코드의 `DEFAULT_CONFIG`가 같은 기본값을 갖는다(`hooks/contracts.ts`).

| 키 | 타입 | 기본값 | 허용 범위 | 설명 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | — | 조건에 맞는 제출을 가로챌지 여부 |
| `triggerMode` | string | `always` | `always` \| `prefix` | `always`는 모든 대상 제출, `prefix`는 접두어가 있는 제출만 |
| `triggerPrefix` | string | `?? ` | 비어 있으면 prefix 모드에서 기본값으로 복귀 | prefix 모드 트리거 접두어 |
| `rawPrefix` | string | `::raw ` | — | 이 접두어로 시작하면 접두어를 떼고 그대로 통과 |
| `uiMode` | string | `auto` | `auto` \| `pane` \| `composer` | `auto`·`pane`은 패인을 시도하고 배치되지 않으면 입력창 대화로 폴백, `composer`는 항상 입력창 |
| `model` | string | `haiku` | 비어 있지 않은 문자열 | 옵티마이저 완성에 쓸 모델 별칭/ID |
| `maxTokens` | number | `1024` | 128–2048 | 한 번의 완성 출력 상한 |
| `timeoutMs` | number | `12000` | 1000–30000 | 한 번의 완성 시간 제한(ms) |
| `maxRounds` | number | `3` | 1–5 | 한 작업에서 허용하는 최대 완성 횟수 |
| `contextTurns` | number | `4` | 0–8 | 문맥에 넣을 최근 사용자 턴 수 |
| `contextMaxChars` | number | `6000` | 0–8000 | 문맥 스냅샷 문자 예산 |
| `systemPromptFile` | string | `""`(없음) | — | 추가 시스템 지침 파일. 비면 내장 프롬프트 유지 |

`uiMode`의 `auto`와 `pane`은 같은 동작을 한다: 패인을 먼저 열어 보고 배치에 성공하면 패인, 실패하면 입력창 대화로 폴백한다. 이는 `plugin.json`의 현재 설명과 일치한다(`hooks/register.ts`의 `chooseUi`).

### 5.1 `/config` 행

`register.ts`의 `config.set` 핸들러는 `<plugin>.<key>` 접두어, 즉 `prompt-optimizer.`로 시작하는 키를 처리한다. `/config` 메뉴에는 다음 행이 나타난다.

```text
prompt-optimizer.enabled
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
```

여기서 값을 바꾸면 기준 설정에 반영되고, 같은 키에 걸려 있던 세션 한정 override는 지워진다.

`claude plugin configure <plugin>`(CLI 도움말에 존재)도 옵션 값을 보여주고 `--values-stdin`으로 저장할 수 있다. 다만 `--plugin-dir` 세션 한정 로더와의 연동은 별도로 확인해야 한다.

### 5.2 `/optimize on|off|model`의 저장 범위

- `/optimize on`·`off`·`model <id>`는 먼저 세션 override 레이어(`hooks/register.ts`의 `overrides`)에 적용해 즉시 반영하고, 검증을 통과하면 `$.config.set({ key: 'prompt-optimizer.enabled' | 'prompt-optimizer.model', value })`로 영구 설정에 저장한다(`hooks/commands.ts`).
- 저장에 성공하면 결과 줄에 `설정에 저장했습니다.`가 붙고, 그 값은 다음 실행에도 유지된다.
- 엔진이 거부(`deny`)하거나 예외가 나면 `이번 세션에만 적용됨(<사유>)`가 붙고 이 세션에서만 적용된다.
- 값 검증은 저장 전에 `validateConfigChange`로 한다. 거부되면 `...하지 못했습니다: <이유>`만 표시하고 저장하지 않는다.
- 이 저장 호출은 플러그인 자신의 `config.set` 훅을 거치지 않으므로(그 훅은 `/config` 메뉴용), 세션 override는 그대로 유지된다.
- `/config`의 해당 행을 직접 바꾸면 기준 설정이 바뀌고 그 키의 세션 override가 제거된다.

### 5.3 시스템 프롬프트 커스터마이즈

- `systemPromptFile`이 비어 있으면 내장 프롬프트(`hooks/system-prompt.ts`의 `BASE_SYSTEM_PROMPT`)를 쓴다.
- 파일을 지정하면 선행 `~`를 `HOME`으로 직접 확장해(`셸 실행 없음`) `$.fs`로 읽는다.
- 최대 4000자까지만 사용하고, 초과분은 잘라내며 경고를 남긴다.
- 파일이 없거나 읽지 못하면 내장 프롬프트로 폴백하고, 그 작업에서 한 번 `시스템 프롬프트 파일을 읽지 못해 기본 프롬프트를 사용합니다: <사유>` 알림을 보여 준다(파일은 작업 시작 시 한 번만 읽으므로 알림도 작업당 1회).
- 추가 지침은 `[추가 지침]` 아래에 들어가고, 역할 제한과 JSON 출력 계약(`[고정 계약]`)이 항상 맨 뒤에 다시 붙는다.
- 권장 위치: `~/.claude/prompt-optimizer/system-prompt.md`.
- 이 파일은 한 작업(workflow) 시작 시 한 번만 읽고 그 작업 동안 캐시한다. 새 작업/세션 시작 시 다시 읽는다.

## 6. 비용·프라이버시

- **호출 수**: 라운드당 정확히 `$.model.complete` 1회. 작업당 최대 `maxRounds`(기본 3)회. 자동 재시도·상위 모델 폴백·fork는 없다.
  - 단, 플러그인이 1회 호출해도 **엔진의 API 클라이언트가 5xx 오류에서 같은 요청을 자체 재시도**할 수 있다. 로컬 mock API 검증(2.1.285)에서 HTTP 500 한 번에 요청 3건(최초 1 + 재시도 2)이 관찰됐다. `$.model.complete`에는 재시도 옵션이 없어 플러그인에서 끌 수 없다. 같은 검증에서 응답 지연(15초)은 `timeoutMs`(12초) 뒤 중단되고 원문이 복원됐다. 재시도가 타임아웃 안에 포함되는지는 확인하지 않았다.
- **기본 파라미터**: 모델 `haiku`, effort `low`(고정), `maxTokens 1024`, `timeoutMs 12000`.
- **요청 구성**: `<context>` + `<original_prompt>` + (있으면) `<current_draft>` + `<dialogue>` + `<instruction>` + JSON 출력 지시. 전체 프롬프트+시스템이 16000자(`MAX_REQUEST_CHARS`)를 넘으면 오래된 대화부터 버리고, 그래도 넘으면 문맥을 뒤에서 자른다. 원문은 자르지 않는다.
- **문맥 상한**: 최근 `contextTurns`(기본 4)개 사용자 턴에서 최신 우선으로 최대 8개 메시지·4000자, 메시지당 1200자(중간 `[중략]`), 프로젝트 규칙 1200자, cwd/repo 400자, 도구 이름 400자, 전체 6000자. 규칙 파일은 `root/CLAUDE.md`, `root/.claude/CLAUDE.md`, `cwd/CLAUDE.md` 후보만 읽고, 256 KiB를 넘으면 건너뛴다.
- **도구 결과·파일 전체·이미지 transcript는 보내지 않는다.** 도구는 이름 메타데이터만 문맥에 들어간다.
- **문맥을 요약하는 별도 모델 호출은 없다.**
- **디스크 저장 없음(플러그인 상태)**: 프롬프트·문맥·대화·bypass·사용량은 플러그인 메모리에만 있고, 플러그인이 파일이나 `$.store`에 쓰지 않는다.
- **composer 알림의 transcript 행**: composer(입력창 대화) 모드에서는 개선안·옵티마이저 메시지·오류·알림을 `$.ui.log` 알림으로 내보내므로, 호스트가 이를 세션 transcript 파일에 알림 행으로 기록할 수 있다. 이는 메인 모델 입력으로 전송되는 대화가 아니며, 패인 모드는 `$.ui.log` 대신 `$.ui.invalidate`/`$.ui.toast`만 써서 로컬 상태만 사용한다(`hooks/ui/present.ts`).
- **금액 표시 없음**: 토큰 사용량만 보여준다(패인 헤더 합계, `/optimize status`의 세션 합계). 가격표는 고정하지 않는다. 취소 응답의 0은 "반환된 사용량"이며 공급자 최종 청구액 0을 보장하지 않는다.

## 7. 제한 사항

- **첨부(이미지·오디오·문서)**: 첨부가 있는 제출은 가로채지 않는다. 엔진이 원래 경로로 그대로 처리한다.
- **진행 중 턴·대기 제출**: `turnId`가 있거나 `wait === true`인 제출은 메인 세션의 큐에 그대로 맡긴다.
- **슬래시 명령·셸 입력**: `/` 또는 `!`로 시작하는 입력은 가로채지 않는다(명령은 `command.run`이 처리).
- **너무 긴 원문**: 원문이 6000자(`MAX_ORIGINAL_CHARS`)를 넘으면 개선하지 않고 그대로 통과시킨다.
- **명시적 전송의 문맥 손실**: "바로 보내기"·`/optimize send`·`/optimize raw`는 `$.prompt.submit({ text })`만 호출한다. 엔진의 `PromptSubmitArgs`에는 `context` 필드가 없어서, 처음 제출에 다른 훅이 붙였을 수 있는 추가 문맥 블록은 명시 전송 때 다시 붙지 않는다. 입력창으로 복원한 뒤 사용자가 직접 Enter 하는 기본 경로에는 영향이 없다(그 경로는 원래 제출 문맥이 아니라 사용자가 입력창에 든 최종 텍스트를 보낸다).
- **취소 거부**: 이미 입력창으로 옮기는 중(`transferring`)이거나 전송 중(`sending`)이면 취소가 거부된다(각각 `입력창으로 옮기는 중이라 취소할 수 없습니다`, `전송 중이라 취소할 수 없습니다`). 진행 중 호출을 중단하는 시점(`collecting`/`generating`/`reviewing`/`failed`)에는 정상적으로 취소된다.
- **빈 raw 제출 드롭**: `rawPrefix` 뒤가 비었거나 공백뿐이면 `보낼 내용이 없습니다.`와 함께 드롭된다. 접두어가 메인 세션으로 전달되지 않는다.
- **패인 닫기 = 취소**: 패인에서 Esc/닫기를 하면(origin `person`) 진행 중 작업을 취소하고 원문을 복원한다.
- **복원 충돌 보호**: 입력창에 사용자가 새로 쓴 내용이 있으면 개선안으로 덮어쓰지 않는다(`draft-conflict`). fill이 거부되면 bypass를 발급하지 않는다.
- **bypass 수명**: 복원으로 발급된 bypass는 10분 후 만료되고, 한 번만 소비된다. 사용자가 편집하면 그 편집 텍스트로 따라가고, 입력창을 비우면 무효화된다. 다른 플러그인이 입력창을 채우면 bypass는 그 새 텍스트를 따라가므로(원래 개선안에는 효력이 없어진다) 다음 Enter는 가로채지 않고 그 텍스트를 보낸다.
- **composer 알림이 transcript에 남을 수 있음**: composer 모드에서는 개선안·메시지가 `$.ui.log` 알림으로 나가므로 호스트가 세션 transcript 파일에 알림 행으로 저장할 수 있다. 메인 모델 입력으로 전송되지 않으며, 패인 모드는 이 경로를 쓰지 않는다.
- **사용량은 메모리에만**: 이 세션의 사용량은 플러그인 메모리(`RuntimeState.usage`)에만 있고 `$.store`에 저장하지 않는다. 세션이 끝나면 사라진다.
- **시스템 프롬프트 파일 폴백 알림**: `systemPromptFile`을 읽지 못하면 그 작업에서 한 번 `시스템 프롬프트 파일을 읽지 못해 기본 프롬프트를 사용합니다: <사유>` 알림을 보여 주고 내장 프롬프트를 쓴다.
- **early-access API**: Mod 계약이 바뀔 수 있다(2.1.277 → 2.1.285에서 반환형 변경 이력).
- **실제 터미널 화면 검증 상태**: 이 저장소 이력에서는 패인 배치·포커스·fill의 실제 터미널 동작을 아직 검증하지 못했다(개발 환경의 네트워크 오류). `docs/smoke.md`의 절차로 검증 예정이며, 그때까지 화면 동작은 **미검증**이다. 자동 테스트는 mock 엔진에서의 계약만 보장한다.

## 8. 개발

```bash
npm ci
```

타입 선언은 CLI가 Mod를 로드할 때 `.claude-plugin/types/`에 생성한다. 이 폴더는 gitignore 대상이며 커밋하지 않는다. 아직 없으면 타입체크 스크립트가 안내하는 다음 명령으로 한 번 생성한다(`scripts/check-types.mjs`):

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 \
  claude --plugin-dir . -p "type generation" \
  --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'
```

검사 명령:

| 명령 | 실제 실행 | 하는 일 |
|---|---|---|
| `npm run typecheck` | `node scripts/check-types.mjs` | 생성 타입 존재 확인 후 `tsc -p tsconfig.json` |
| `npm test` | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .` | Mod 테스트 실행(API 비용 없음, mock 엔진) |
| `npm run validate` | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate .claude-plugin/marketplace.json && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate .claude-plugin/plugin.json` | 마켓플레이스·매니페스트·훅 검증 |
| `npm run check:package` | `node scripts/check-package.mjs` | 추적 파일에 생성 타입/참조/공식 선언이 없는지 확인 |

파일 구조:

```text
.claude-plugin/
  plugin.json          # 매니페스트: 이름·userConfig 12개 키
  marketplace.json     # 마켓플레이스 정의(이름·owner·plugins)
  types/               # CLI가 생성, gitignore, 커밋 금지
hooks/
  hooks.json           # {"modules":["./register.ts"]}
  register.ts          # 조립: 설정 해석, 이벤트 6개 + UI/명령 연결
  contracts.ts         # 공용 타입·상수(기본값·범위·상한)
  config.ts            # 옵션 정규화, systemPromptFile 읽기
  eligibility.ts       # 제출 분류 규칙
  context.ts           # 문맥 스냅샷 수집
  system-prompt.ts     # 내장 프롬프트 + 고정 계약
  model.ts             # 단일 완성 요청/응답 변환
  state.ts             # 순수 리듀서
  delivery.ts          # 입력창 복원(prompt.fill)과 명시적 전송(prompt.submit)
  controller.ts        # 개선 대화 제어기
  commands.ts          # /optimize 파싱·디스패치
  ui/
    register.tsx       # ui.render/press/input/close 훅
    present.ts         # composer 상태/로그 표시
    ui-ports.ts        # 패인 인자·UI 경계 타입
tests/                 # 모듈별 단위 테스트, UI 테스트, 스모크 테스트
scripts/
  check-types.mjs
  check-package.mjs
docs/
  DESIGN.md            # 설계 원문
  smoke.md             # 수동·검증자 스모크 절차
tsconfig.json          # .claude-plugin/types/tsconfig.json 확장
```

규칙:

- `.claude-plugin/types/`의 공식 타입 선언은 Anthropic 독점 라이선스라 저장소에 커밋하지 않는다(`.gitignore` + `scripts/check-package.mjs`가 강제).
- 레퍼런스 폴더·공식 예제·공식 `.d.ts`도 복사해 커밋하지 않는다.

## 9. 라이선스

이 저장소는 MIT 라이선스다. 전문은 [LICENSE](LICENSE).

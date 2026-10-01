# 스모크 테스트 절차 (docs/smoke.md)

이 문서는 `claude plugin test`(mock 엔진)가 보장하지 않는 **실제 터미널 동작**을 수동/검증자가 확인하기 위한 절차다.
`docs/DESIGN.md`의 "5. 통합 후 검증 기준" 표를 기준으로 하며, 옵티마이저 표식 P가 이 절차를 실행한다.

> **검증 상태: 미검증.** 이 저장소 이력에서는 패인 배치·포커스·복원·좁은 폭 폴백을 실제 터미널에서 아직 확인하지 못했다(`docs/DESIGN.md`의 남은 리스크 1). 아래를 통과하기 전까지 화면 동작을 "검증 완료"로 보고하지 않는다.

## 0. 검증 원칙

- 모델 호출 비용을 0에 가깝게 유지한다. 아래 준비 방법 A(권장)는 `model.complete`를 mock하고, 실제 Anthropic 엔드포인트에 닿지 않게 한다.
- 가능하면 실험 환경은 `/tmp` 아래에 두고 제품 디렉터리는 읽기 전용으로만 쓴다.
- 각 항목은 `pass` / `fail` / `blocked`와 함께 CLI 버전·터미널 폭·재현 명령을 기록한다.

## 1. 사전 준비

### 1.1 플러그인 로드

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 \
  claude --plugin-dir /path/to/prompt-optimizer
```

- Claude Code 2.1.285 이상. 플래그가 없으면 함수 훅이 켜지지 않는다.
- 세션에 한해 로드된다(세션 한정 `--plugin-dir` 로더). 마켓플레이스로 설치하는 경로는 `README.md` 3장을 참고한다.

### 1.2 과금 없는 방법 A — `model.complete` mock 훅 (권장, 설계 실험에서 검증)

별도의 mock Mod를 함께 로드해 옵티마이저의 완성만 가로챈다. 두 번째 `--plugin-dir`로 얹는다.

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 \
  claude --plugin-dir /path/to/prompt-optimizer \
         --plugin-dir /tmp/popt-smoke-mock
```

mock Mod의 `register.ts`는 `model.complete` 훅 하나로 고정 JSON을 돌려주면 된다. 반환형은 2.1.285의 `ModelCompleteResult`를 따른다(설계 실험 기록 기준):

```ts
on('model.complete', () => ({
  value: {
    isAnswered: true,
    text: JSON.stringify({ draft: '개선된 요청', message: '다듬었습니다', question: null }),
    usage: {
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
}))
```

- 지연을 흉내내려면 mock 안에서 `await $.process.run(['sleep', '12'])`처럼 실제 지연을 준다(설계 실험에서 12초 대기 후 재작성 텍스트가 `next`로 전달됨을 확인).
- 타임아웃 경로를 보려면 mock에서 `$.model.complete({...timeoutMs:1000})`를 직접 호출해 `reason: 'aborted'`를 관찰한다.

헤드리스로 한 줄 검증할 때(실험에서 사용한 형태):

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 \
  claude --plugin-dir /path/to/prompt-optimizer --plugin-dir /tmp/popt-smoke-mock \
  -p "model" --model haiku --no-session-persistence \
  --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'
```

### 1.3 과금 없는 방법 B — 더미 키 + 로컬 mock Anthropic API 서버 (개요, 이 워크스페이스에서 미검증)

실제 HTTP 경로 자체를 확인해야 할 때의 개요다. **이 방법은 이 저장소 코드가 아니라 Claude Code 외부 동작에 의존하므로, 환경 변수 이름과 요청/응답 스키마는 현재 설치된 CLI의 문서로 반드시 다시 확인한다.** 여기서는 방법의 개요만 적는다.

1. 로컬 mock 서버를 띄운다. Anthropic Messages API의 `POST /v1/messages`에 대해 최소한 `id`, `type: "message"`, `role: "assistant"`, `content`, `model`, `stop_reason`, `usage`를 갖춘 JSON을 돌려주고, 스트리밍(`stream`)이 필요하면 SSE로 같은 이벤트를 흘려보낸다.
2. 더미 키로 실제 결제 경로를 건드리지 않게 한다.
   ```bash
   export ANTHROPIC_API_KEY=dummy-smoke-key
   export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
   ```
3. 로드된 옵티마이저가 mock 서버의 응답을 개선안으로 표시하는지 확인한다.

주의: `ANTHROPIC_BASE_URL`·`ANTHROPIC_API_KEY`는 Claude Code의 환경 변수이지 이 플러그인의 설정 키가 아니다. 값·스키마가 맞지 않으면 모델 오류로 실패하며, 그 실패는 옵티마이저 자체의 버그와 구분해서 기록한다.

### 1.4 터미널 폭 실험(tmux)

패인 배치·폴백은 실제 터미널 폭에 좌우된다. tmux로 폭을 고정한다.

```bash
tmux new-session -s popt -x 80 -y 40
# 같은 세션 안에서 창 크기를 바꿔가며 반복
```

- 폭: **80 / 109 / 110 / 143 / 144 / 160** 컬럼(`docs/DESIGN.md` 5장 기준). 최소한 80 / 110 / 144 / 160은 반드시 본다.
- 2.1.285에서는 사용자의 입력·명령·버튼 동작 안에서 직접 연 패인은 폭과 무관하게 배치될 수 있다. 비요청 패인의 144/110컬럼 제한이 남아 있는지도 함께 본다.
- 각 폭에서 (a) 패인이 뜨는지, (b) 안 뜨면 입력창 대화로 폴백하는지, (c) 어느 쪽이든 모든 동작에 접근 가능한지 확인한다.

## 2. 시나리오 체크리스트

각 행은 `절차 → 기대 결과`다. 기대 결과는 `docs/DESIGN.md`의 통합 후 검증 기준을 옮긴 것이며, 실제 코드 동작(문구·순서)과 대조해 기록한다.

| # | 시나리오 | 절차 | 기대 결과 |
|---|---|---|---|
| 1 | 일반 composer Enter | 입력창에 요청을 쓰고 Enter | 원문이 메인 모델로 가지 않고 `프롬프트를 다듬는 중입니다.`와 함께 개선 UI가 뜬다. 메인 transcript에 해당 턴이 없다. |
| 2 | 보완 대화 2회 | 개선 UI에서 보완 내용을 두 번 보낸다 | 각 보완은 옵티마이저에만 전달되고 메인 제출은 0회. 총 라운드가 3이 되지만 `maxRounds`(기본 3) 이내다. |
| 3 | 입력창에 넣기 | `입력창에 넣기` 클릭 | 정확한 개선안이 입력창에 들어온다. 입력창에서 Enter를 눌러야 정확히 1회 메인으로 전송된다. |
| 4 | 복원 후 편집 | 3에서 입력창 내용을 고친 뒤 Enter | 다시 개선을 시작하지 않고, 편집된 최종본이 그대로 전송된다(bypass가 편집 텍스트를 따라감). |
| 5 | 개선안 바로 전송 | `개선안 바로 전송` 클릭 | 엔진 출처 `plugin`으로 정확히 1회 전송된다. composer 출처를 위조하지 않는다. `asUser: true`라 메인 모델은 "The prompt-optimizer plugin sent a message" 틀 없이 사용자 본인의 말로 받는다. |
| 6 | 원문 그대로 전송 | `원문 그대로 전송` 클릭 | 최초 원문이 보존되어 전송되고 개선안이 섞이지 않는다. |
| 7 | Esc 취소 / 패인 닫기 | Esc 또는 패인 닫기 | 진행 중 호출이 취소되고 자동 전송이 없다. 원문이 복원되고 새 초안을 덮어쓰지 않는다. 입력창으로 옮기는 중/전송 중에는 취소가 거부된다(각각 `입력창으로 옮기는 중이라 취소할 수 없습니다`, `전송 중이라 취소할 수 없습니다`). |
| 8 | 타임아웃·429·인증 오류 | mock에서 지연/오류를 주입 | 무한 대기나 자동 상위 모델 호출이 없다. 실패 후 원문을 복구할 수 있다. |
| 9 | 늦은 모델 응답 | 생성 중 취소하거나 새 작업을 시작한 뒤 이전 응답을 늦게 돌려준다 | 취소·새 작업의 상태를 바꾸지 않는다(stale 응답 무시). 사용량만 중복 없이 집계된다. |
| 10 | 승인 버튼 연타 | `입력창에 넣기`/`개선안 바로 전송`을 빠르게 두 번 | 중복 전송·중복 fill이 없다(첫 동작만 처리). |
| 11 | raw·off·prefix 모드 | `::raw ...`, `/optimize off` 후 일반 제출, `triggerMode=prefix`에서 `?? ` 유무 비교, `::raw ` 뒤를 비운 제출 | 정의된 제출만 가로챈다. raw는 접두어만 떼고 통과하되 뒤가 비었거나 공백뿐이면 `보낼 내용이 없습니다.`로 드롭, off는 아무 것도 가로채지 않음, prefix는 트리거 있는 제출만 개선. |
| 12 | SDK·plugin·peer·queue·mid-turn | 다른 출처 제출, `wait` 제출, 진행 중 턴 위 제출 | 개선 대화로 오인하지 않고 엔진 경로로 그대로 간다. |
| 13 | 이미지·문서 첨부 | 첨부를 붙여 제출 | 원래 경로로 그대로 전달된다(가로채지 않음). |
| 14 | 좁은 폭 composer 폴백 | 80/110 컬럼에서 제출 | 패인이 배치되거나, 배치되지 않으면 입력창 대화로 폴백한다. 어느 쪽이든 모든 동작(보완·accept·send·raw·cancel)에 접근 가능하다. |
| 15 | 폭 변경·다른 패인 | 개선 중 터미널 크기를 바꾸거나 다른 패인을 연다 | 입력 접근 불가 상태로 갇히지 않는다. |
| 16 | fill 실패·다이얼로그 점유 | 입력창을 다른 대화 상자가 점유한 상태에서 복원 시도 | bypass가 발급되지 않고 원문·개선안이 보존된다. |
| 17 | 다른 플러그인의 fill/submit | 다른 플러그인이 같은 입력창을 채우거나 제출 | bypass가 오소비되거나 무한 재진입하지 않는다. |
| 18 | `/clear`·세션 종료·재개 | 세션을 비우거나 종료 후 재개 | pending 작업·bypass가 다음 세션으로 누출되지 않는다. |
| 19 | 메인 격리 | 승인 전후로 transcript와 모델 턴을 관찰 | 승인 전 transcript 메시지·메인 모델 턴이 늘지 않고, `model.fork` 호출이 0회다. |
| 20 | 패키징 | `npm run check:package` | 공식 타입·레퍼런스·임시 파일·대화 내용이 추적 목록에 없다. |
| 21 | `/optimize on|off|model` 영구 저장 | `/optimize off`(또는 `model sonnet`) 실행 후 CLI 재시작 | 결과 줄에 `설정에 저장했습니다.`가 붙고, 재시작 후에도 값이 유지된다. 엔진이 거부/예외면 `이번 세션에만 적용됨(<사유>)`가 붙는다. |
| 22 | `uiMode` 폴백 | `auto`/`pane`에서 좁은 폭으로 제출, `composer`에서 제출 | `auto`·`pane`은 패인 배치를 시도하고 실패하면 입력창 대화로 폴백, `composer`는 항상 입력창에서 진행된다. |
| 23 | 표면별 패인 | `desktop`·`vscode` 표면과 버튼·입력이 없는 표면(예: 모바일)에서 개선 시작 | 표시 가능한 표면에서는 패인이 그려지고, 버튼·입력이 없으면 텍스트 요약 + `명령: /optimize accept · send · raw · cancel · retry <보완>` 안내가 보인다. |
| 24 | 시스템 프롬프트 파일 폴백 | `systemPromptFile`에 없는/읽을 수 없는 경로를 설정하고 개선 시작 | 그 작업에서 한 번 `시스템 프롬프트 파일을 읽지 못해 기본 프롬프트를 사용합니다: <사유>` 알림이 보이고 내장 프롬프트로 진행된다. |

### 2.1 추가로 볼 만한 동작(코드에서 확인된 것)

- 진행 중(수집/생성/전달/전송) 상태에서 입력창에 대한 추가 제출은 `프롬프트 옵티마이저가 작업 중입니다. /optimize cancel 로 취소할 수 있습니다.`로 드롭된다.
- composer 모드 상태 줄은 `옵티마이저 <단계> (n회) · ...` 형식으로 갱신된다.
- `/optimize status`가 설정·단계·세션 사용량을 한 블록으로 보여준다.
- 복원된 bypass는 10분 후 만료되고, 입력창을 비우면 무효화된다. 다른 플러그인이 fill하면 bypass가 그 새 텍스트를 따라간다(원래 개선안에는 효력이 없어짐).

## 3. 기록 양식

```text
CLI 버전: claude --version →
표면(surface): terminal / desktop / vscode / 기타, 폭(컬럼)
mock 방법: A(model.complete) 또는 B(HTTP + ANTHROPIC_BASE_URL) + 기동 명령
시나리오 #: pass | fail | blocked
재현 명령·키 입력:
관찰한 화면(요약):
기대와 다른 점:
```

실패 항목은 옵티마이저 자체 결함, mock 환경 문제, CLI/Mod early-access 차이를 구분해 적고, 수정은 원 소유자 모듈로 되돌린다.

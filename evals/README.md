# 평가 자산과 실행기 (evals/)

이 디렉터리는 프롬프트·검색·모델 설정 변경이 **요구사항 보존과 질문 품질**을 어떻게 바꾸는지 재현 가능하게 비교하기 위한 합성 평가 자산과 명시적 실행기를 보관합니다. 플러그인 런타임 동작에는 관여하지 않으며, `npm test`나 CI에 포함되지 않습니다.

- `cases/`: 개발 사례 14개. 프롬프트 조정에 사용할 수 있습니다.
- `holdout/`: 동결된 보류 사례 4개. 기본 개발 실행에서는 읽지 않습니다.
- `rubric/`: 사람 심사 기준과 심사 기록 형식.
- `runner/`: 무의존성 Node 실행기, 규칙 판정, 비교 보고서.
- `results/`: 로컬 실행 결과(커밋하지 않음, `.gitignore`).

## 요구 사항

- Node **>= 24.12** (네이티브 TypeScript 타입 스트리핑과 동기 `module.registerHooks` 사용). npm 의존성·빌드 단계·생성된 타입 선언은 필요하지 않습니다.
- 실제 모델 실행은 기본 경로가 아닙니다. `--live`와 신뢰하는 로컬 어댑터를 명시해야만 합니다.

## 명령

```bash
# 사례 로딩·형식 검증만 (훅·어댑터·자격 증명을 읽지 않음)
node evals/runner/run.mjs --validate --suite development
node evals/runner/run.mjs --validate --suite holdout

# mock 실행: 사례의 고정 응답만 사용, 어댑터 import 없음
node evals/runner/run.mjs --mock --suite development --repeats 1 --out /tmp/popt-eval-dev.json
node evals/runner/run.mjs --mock --suite holdout --repeats 1 --out /tmp/popt-eval-holdout.json

# 두 결과 비교 (Markdown 또는 .json)
node evals/runner/compare.mjs --baseline /tmp/base.json --candidate /tmp/change.json --out /tmp/comparison.md
```

`--out`은 **배타적 생성**입니다. 이미 있는 파일을 덮어쓰지 않으며, 결과 JSON은 상세 trace를 담습니다. `--out`이 없으면 표준출력에는 집계 요약만 나옵니다.

### 실제 모델 실행 (설계만, 이 저장소에서 실행하지 않음)

```bash
node evals/runner/run.mjs --live \
  --adapter /absolute/trusted/adapter.mjs \
  --model <explicit-model-id> \
  --max-calls 20 --max-rounds 2 --repeats 2 \
  --suite development --out /private/local/result.json
```

- `--adapter`는 절대 경로의 `.mjs`/`.js` 파일이어야 하며, `complete(request, {signal})`를 export해야 합니다.
- `--model`, `--max-calls`, `--max-rounds`가 모두 명시되어야 합니다.
- 비어 있지 않은 CI 환경 변수(`CI`, `GITHUB_ACTIONS` 등)가 있으면 어댑터를 import하기 전에 거부합니다.
- 최악 호출 수 `sum(min(사례 남은 라운드, --max-rounds)) × --repeats`가 `--max-calls`를 넘으면 첫 호출 전에 거부합니다. 유리한 일부만 조용히 실행하지 않습니다.
- 호출은 순차 실행이며 재시도·폴백·모델 심사가 없습니다. 시도 횟수는 실패한 호출도 포함해 호출 전에 증가합니다.

## 사례 형식 (schema v1)

사례 파일 하나에 JSON 객체 하나입니다. 알 수 없는 필드는 거부됩니다. 주요 필드:

```json
{
  "schemaVersion": 1,
  "id": "korean-login-investigation",
  "split": "development",
  "tags": ["ko", "investigation"],
  "provenance": { "kind": "synthetic-authored", "source": "..." },
  "original": "로그인 오류가 나는데 원인만 조사해줘. 코드는 수정하지 마.",
  "context": { "text": "# src/auth/login.ts\n..." },
  "initialDialogue": [],
  "initialDraft": "",
  "roundsCompleted": 0,
  "settings": {
    "guidanceProfile": "common",
    "maxRounds": 1,
    "maxTokens": 2048,
    "timeoutMs": 30000,
    "cache": false
  },
  "answers": [],
  "constraints": [
    { "id": "investigate-only", "kind": "mustPreserve", "description": "...", "severity": "critical" }
  ],
  "rules": [
    { "id": "keeps-login", "kind": "includes", "round": "final", "field": "draft", "value": "로그인" }
  ],
  "mockResponses": [
    { "draft": "...", "message": "...", "question": null, "options": [] }
  ]
}
```

- `context.text`는 사용자의 실제 저장소·세션이 아니라 **합성 근거**입니다. 실행기는 이 텍스트를 그대로 `buildModelRequest`에 넣습니다.
- `answers`는 모델이 `question`을 반환한 뒤에만 다음 라운드로 전달됩니다. `when.questionIncludes`/`when.option1Includes`가 맞지 않으면 `scenario-diverged`로 멈추고 사용자의 선택을 지어내지 않습니다.
- `rules`는 `includes`, `excludes`, `questionNull`, `questionPresent`, `maxOptions`, `jsonContract`만 지원합니다. 범위는 정수 라운드, `each`, `final`입니다. 정규식·eval·외부 URL은 없습니다.
- `constraints`는 사람 심사용이며 모델에 보내지 않습니다. 최소 하나는 `critical`/`major`여야 합니다.
- `mockResponses`는 해당 사례에서 새로 실행할 라운드 수보다 많을 수 없습니다. 질문이 `null`이면 에피소드가 일찍 끝납니다.

## mock·규칙·사람 심사·live의 구분

| 구분 | 의미 | 증명하는 것 |
|---|---|---|
| `--validate` | 사례 형식·상한·경로 안전성 검사 | 로딩 계약 |
| `--mock` | 사례의 고정 `mockResponses` 재생 | 파이프라인·규칙 리허설. **의미 품질 아님** |
| 규칙 판정 | 문자열 포함/제외·질문 유무·옵션 수 | 어휘·구조 신호 |
| 사람 심사 | `evals/rubric/` 기록 | 의미 품질(제약 누락·범위 추가·질문 적절성 등) |
| `--live` | 명시적 어댑터 1회 호출 | 실제 모델/provider 동작은 별도 검증 필요 |

mock 보고서에는 항상 **pipeline/rule rehearsal only — no semantic-quality conclusion**이 표시됩니다. 규칙 실패는 동의어 누락을 자동으로 의미 누락으로 판정하지 않습니다. 심사되지 않은 의미 비율은 `N/A`이며 0이 아닙니다.

## 결과·메타데이터

`{metadata, cases, aggregate}` 형식입니다. `metadata`에는 다음이 기록됩니다.

- 저장소 SHA·dirty 여부, 패키지 버전, Node 버전, 실행 시각(UTC ISO-8601)
- 모드·평가군·반복 수, 계획/시도/완료 호출 수
- 요청 모델과 실제 보고된 모델(없으면 `null`), `--allow-change`로 허용한 차원
- `guidance.profiles`: 실제 조립된 시스템 텍스트의 SHA-256과 길이, `sourceHashes`: 프로덕션 훅 소스 해시
- 어댑터 종류·경로·SHA-256(라이브)
- `corpusHash`, 사례별 `caseHash`, 사례별 trace(원문·근거·사전 대화·새 답변·조립된 요청·원시 응답·파싱 결과·판정·지연·사용량·종료 이유)

mock 사용량은 `{known:true, synthetic:true, counts:0}`입니다. live 응답에 사용량이 없으면 `{known:false, counts:null}`이며 0으로 꾸미지 않습니다. 가격은 하드코딩하지 않습니다. 호출·라운드 상한은 작업량을 제한하지만 달러 상한을 보장하지는 않습니다.

## 비교 정책

`compare.mjs`는 `(caseId, caseHash, repeat)`로 짝을 맞춥니다. 다음이 다르면 **거부**합니다.

- 코퍼스 해시, 평가군, 모드(mock/live), schema/rubric/runner 버전
- 어댑터 종류
- 모델 식별자·설정·지침 버전 — 단, `--allow-change guidance|model|settings`로 명시한 차원은 예외

허용된 변경은 `confounded: true`로 표시하고 어떤 설정 필드가 바뀌었는지 나열합니다. 인과적 프롬프트 개선으로 주장하지 않습니다. 실제 모델 ID가 없으면 미해결 조건으로 표시합니다. 누락된 사례를 통과로 계산하지 않으며, 완료 라운드 수 차이는 결과로 기록합니다.

비교 보고서는 규칙 개선/회귀, 제약 누락률·범위 추가율의 원시 분자/분모, 질문 수, 작업당 라운드·토큰, 중앙값·p90 지연, 실패·분기·시간 초과를 구분합니다. 모델 텍스트는 Markdown 표를 깨거나 HTML을 주입하지 못하도록 escape됩니다.

## 비밀값·출력 정책

- 사례는 체크인된 합성 데이터만 허용합니다. 실제 사용자 대화·세션 덤프·개인 코퍼스·환경 변수 보간은 받지 않습니다.
- 실행 전 공급 데이터에서 키·토큰·개인키 모양 문자열을 찾으면 위치와 종류만 남기고 실행을 거부합니다.
- live 원시 응답에서 같은 패턴이 발견되면 저장 전에 `[REDACTED:<kind>]`로 바꾸고, 결과를 `comparable:false`로 표시하며 비밀값을 출력하지 않습니다. 이는 위생 백스톱이며 임의 데이터의 안전을 증명하지 않습니다.
- `--out`은 파일 모드 0600(지원 시)으로 배타 생성합니다. 자동 커밋·업로드·전송은 없습니다.

## 보류 평가군 운영

`holdout/`은 공개·동결 코퍼스이며 비밀이나 통계적으로 독립된 표본이 아닙니다. 개발 실행은 `holdout/`을 읽지 않고, 릴리스 평가에서만 `--suite holdout`을 명시합니다. 보류 사례 실패를 이용해 프롬프트를 조정했다면 그 사례를 `cases/`로 승격하고, 같은 도메인의 새 사례를 별도 검토로 `holdout/`에 교체합니다. 기존 ID·이력은 보존하며 코퍼스 해시가 다른 실행을 개선으로 비교하지 않습니다. 사례 수가 작으므로 통계적 유의성을 주장하지 않습니다.

## 어댑터 계약과 지연된 범위

```js
// /absolute/trusted/adapter.mjs
export async function complete(request, { signal }) {
  return {
    text,                 // 모델 원시 텍스트
    usage,                // 없으면 {known:false}
    modelId,              // 실제 모델 ID(없으면 null)
    provider,             // 제공자 이름(없으면 null)
    settingsApplied,      // 적용한 설정. maxTokens/effort/cache가 요청과 다르면 실패
  }
}
```

- 어댑터는 `buildModelRequest`가 만든 요청을 **한 번** 전달받습니다. 자격 증명은 어댑터의 환경/인증 기구 안에만 두고 사례 JSON·인자·stdout·보고서에 넣지 않습니다.
- 기본 어댑터는 없습니다. `claude -p`나 유료 API를 호출하는 프로덕션 transport는 이 이슈에서 구현하지 않았습니다. 실제 인증·provider 동작·내부 재시도·의미 품질은 **검증되지 않은 별도 후속 범위**입니다.
- 실행기는 어댑터의 논리적 `complete` 호출 수를 제한합니다. provider 내부의 불투명한 재시도는 이 계층에서 제한할 수 없으며, 하드 HTTP 요청 상한은 재시도를 노출/비활성화하는 transport가 필요합니다.
- 타임아웃은 `AbortSignal.timeout`을 쓰며, 어댑터가 abort를 따르지 않으면 성공으로 간주하지 않고 `unsupported`/실패로 기록합니다.

## 기존 평가와 `npm test`의 관계

[docs/smoke.md](../docs/smoke.md)의 2026-10-06 수동 의미 평가 기록은 역사적 자료입니다. 이 디렉터리의 사례는 그 기록을 합성 재구성한 것이며, 기존 백분율을 새 실행의 baseline으로 재사용하지 않습니다. `npm test`는 프롬프트 조립·상한·파서·회차 제어의 mock 계약 테스트를 실행할 뿐 의미 품질을 입증하지 않으며, 유료 모델 호출이나 `evals/runner/run.mjs`를 시작하지 않습니다. CI에도 평가 실행 단계가 없습니다.

# 의미 평가 심사 기준 (rubric v1)

이 문서는 `evals/cases/`(개발 사례)와 `evals/holdout/`(보류 평가군)의 모델 응답을 사람이 판정할 때 쓰는 기준입니다. 실행기는 규칙 검사(`evals/runner/judge.mjs`)와 심사 기록 병합까지만 담당하며, v1에는 모델 심사가 없습니다. 규칙 통과는 의미 품질의 증거가 아닙니다.

## 원칙

- 판정은 응답 원문과 제공된 근거를 함께 읽고 내립니다. 실행한 적 없는 모델 run을 통과로 기록하지 않습니다.
- 모든 판정에는 **판정 근거가 된 모델 문장**(`quote`)과 이유(`reason`)를 적습니다. 인용은 결과 파일의 원문과 정확히 일치해야 합니다.
- 부재를 판정할 때는 “어떤 입력 조건이 요구되었는지”를 `requiredCondition`에 적고, `reason`에 “그 조건을 뒷받침하는 출력 문장을 찾지 못했다”고 명시합니다. 단순히 인용을 비워 두지 않습니다.
- 동의어·표현 차이는 의미 누락으로 자동 단정하지 않습니다. 규칙 검사 실패는 어휘·구조 신호이며, 의미 판정은 사람이 다시 봅니다.
- 심사자 간 불일치는 평균으로 덮지 않고 양쪽 판정과 조정(`adjudication`)을 모두 남깁니다.
- 심사자는 모델명을 가린 `blindLabel`로 기록합니다. 블라인드가 깨졌으면 `notes`에 적고 비교에서 한계로 표시합니다.

## 기준 ID

| criterionId | 무엇을 보는가 | 분모 |
|---|---|---|
| `constraint-omission` | 사례의 `constraints` 중 `mustPreserve`·`mustInclude`가 최종 초안에서 빠지지 않았는가 | 심사된 적용 제약 수 |
| `scope-addition` | 사례에 없던 파일·기능·검증·문서·리팩터링을 합의된 것처럼 추가하지 않았는가 | 심사된 에피소드 수 |
| `unnecessary-question` | 사용자가 정할 필요가 없는 것을 묻거나, 이미 답한 결정을 다시 묻지 않았는가 | 심사된 에피소드 수 |
| `evidence-grounding` | 확인된 사실·제안·미정을 구분하고, 근거에 없는 파일·원인·계약을 만들지 않았는가 | 심사된 에피소드 수 |
| `intent-preservation` | 진단·조사·글쓰기 요청을 변경·구현·테스트 요청으로 바꾸지 않았는가 | 심사된 에피소드 수 |
| `draft-usefulness` | 초안이 이전 대화 없이도 실행 가능하고, 요청에 필요한 목표·범위·완료 기준을 담았는가 | 심사된 에피소드 수 |
| `open-decisions` | 남은 미결정을 지우거나 추천안으로 확정하지 않고, `question`·초안에 유지했는가 | 심사된 에피소드 수 |
| `language-literal-fidelity` | `draft`는 원문 언어, `message`·`question`·`options`는 한국어이며, 코드·URL·버전·정확한 출력 문자열이 보존되었는가 | 심사된 에피소드 수 |
| `rounds-tokens-latency` | 라운드·토큰·지연을 별도 지표로 기록했는가(의미 통과율과 섞지 않음) | 해당 없음(집계 전용) |

`constraints[].kind`가 `mustNotInfer`이면 “그 추론을 하지 않았는가”를 `constraint-omission`과 함께 확인합니다. `literals`가 있으면 정확한 문자열을 인용해 대조합니다.

## 판정 값

- `pass`: 요구 조건을 충족하고, 그 근거 문장을 인용할 수 있음.
- `fail`: 조건을 위반했거나 필요한 내용이 없음. 부재 판정은 위 원칙대로 기록.
- `not-applicable`: 해당 기준이 이 사례에 적용되지 않음. 왜 적용되지 않는지 `reason`에 적음.

`fail`만 모아 단일 통과율로 합치지 않습니다. 제약 누락률·범위 추가율·불필요 질문 수·라운드/토큰/지연을 각각의 분자와 분모로 기록합니다. 심사되지 않은 의미 지표는 `null`/`N/A`이며 0이 아닙니다.

## 중대 실패(critical failure) 예시

아래 중 하나면 `constraint-omission` 또는 `intent-preservation`을 `fail`로 기록하고, 가능하면 비교 보고서에서 회귀 사례로 표시합니다.

1. 조사·진단 요청을 코드 수정·구현 요청으로 바꿈.
2. 사용자가 명시한 금지(“수정하지 마”, “건드리지 마”)를 위반하거나 그 금지를 삭제함.
3. 근거에 없는 파일·원인·엔드포인트·설정을 확인된 사실로 만듦.
4. 사용자의 최신 정정을 잃고 이전 결정을 유지함.
5. 제안·추천을 사용자 합의로 승격함.
6. 원래 요청한 산출물(문서·CSV·안내 문구 등)을 조용히 다른 산출물로 바꾸거나 뺌.
7. 코드·URL·버전·정확한 출력 문자열을 임의로 바꿈.

## 심사 기록 형식

`review-schema.json`은 기록 형식을 설명하는 JSON Schema입니다. 실행기는 이 파일로 일반 JSON Schema 검증을 수행하지 않고, `result.cases[].repeats[].humanReview`에 병합할 때(`evals/runner/judge.mjs`의 `mergeHumanReview`) `reviewVersion`·`caseId`·`caseHash`·`repeat`·`reviews[].criterionId`·`verdict`를 확인하고, 그 위에서 `quote`가 해당 반복의 라운드 `rawText`에 그대로 나타나는지, 같은 기준(`criterionId`와 `constraint-omission`의 `constraintId`) 항목이 중복되지 않는지, `constraintId`가 사례의 제약 id 중 하나인지를 검사합니다. 어긋나면 기록은 병합되지 않습니다. 병합 방법은 `evals/README.md`의 사람 심사 병합 절을 참고합니다.

```json
{
  "reviewVersion": 1,
  "caseId": "korean-login-investigation",
  "caseHash": "<sha256>",
  "repeat": 1,
  "reviewerId": "reviewer-a",
  "blindLabel": "run-7",
  "reviewedAt": "2026-10-02T12:00:00.000Z",
  "reviews": [
    {
      "criterionId": "constraint-omission",
      "verdict": "pass",
      "quote": "로그인 오류의 원인만 조사하고 코드는 수정하지 마.",
      "reason": "원문의 조사 전용 제약과 수정 금지를 그대로 유지했다."
    },
    {
      "criterionId": "scope-addition",
      "verdict": "not-applicable",
      "quote": "",
      "reason": "이 사례는 범위 추가를 판정할 추가 산출물이 없다."
    }
  ],
  "notes": ""
}
```

`reviewedAt`은 KST가 아니라 UTC ISO-8601로 저장하고, 사람에게 보여줄 때 KST로 표시합니다. 결과 비교는 `(caseId, caseHash, repeat)`로 짝을 맞춥니다.

## 보류 평가군 운영

- `holdout/`은 공개·동결된 평가군입니다. 개발 실행은 `holdout/`을 읽지 않으며, 릴리스 평가에서만 `--suite holdout`을 명시합니다.
- 보류 사례 실패를 보고 프롬프트를 조정했다면 그 사례는 `cases/`로 승격하고, 같은 도메인의 새 사례를 별도 검토로 `holdout/`에 교체합니다. 기존 ID·이력은 보존하며, 코퍼스 해시가 다른 실행을 개선으로 비교하지 않습니다.
- 사례 수와 반복 수가 작으므로 통계적 유의성을 주장하지 않습니다.

## 기존 평가와의 관계

`docs/smoke.md`의 2026-10-06 수동 의미 평가 기록은 역사적 자료입니다. 이 디렉터리의 사례는 그 기록을 **합성 재구성**한 것이며, 기존 백분율을 새 실행의 baseline으로 재사용하지 않습니다. `npm test`의 mock 계약 테스트는 프롬프트 조립·파서·상한의 회귀를 확인할 뿐 의미 품질을 입증하지 않습니다.

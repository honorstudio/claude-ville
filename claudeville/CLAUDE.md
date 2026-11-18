# ClaudeVille - 프로젝트 규칙

## 레이아웃 구조 (중요)

```
body (flex column, height 100vh)
  header.topbar            ← 48px 고정 높이, flex-shrink: 0
  div.main                 ← flex: 1, flex-direction: column
    div.main__body         ← flex: 1, display: flex (가로 배치)
      aside.sidebar        ← width: 240px, flex-shrink: 0
      div.content          ← flex: 1 (캐릭터/대시보드 모드)
      aside#activityPanel  ← width: 320px (에이전트 선택 시 표시, 기본 숨김)
```

### 주의사항
- UI 요소는 위 flex 구조 안에 둔다. `position: fixed`는 모달·토스트에만 쓴다 — 고정 배치는 사이드바·활동 패널 폭 계산에서 빠진다.
- 새 패널 추가 시 반드시 flex 레이아웃 안에서 배치해야 함
- activityPanel(320px)이 열리면 content 영역이 줄어드므로 반응형 고려 필요
- 대시보드 모드는 `overflow-y: auto`로 스크롤, 캐릭터 모드는 캔버스가 남은 영역을 채움

## 기술 스택
- 순수 HTML/CSS/JS (프레임워크 없음)
- ES Modules (import/export)
- Node.js 서버 (server.js) - HTTP + WebSocket (RFC 6455 직접 구현)
- Canvas 2D API로 아이소메트릭 렌더링
- 어댑터 패턴으로 멀티 프로바이더 지원 (adapters/ 디렉토리)
- 서버 포트는 4000이다(`server.js`, `PORT` 환경값으로만 바꾼다).

## 데이터 소스 (멀티 프로바이더)
- **Claude Code**: `~/.claude/` (history.jsonl, projects/, teams/, tasks/)
- **Codex CLI**: `~/.codex/sessions/` (rollout-*.jsonl)
- **Gemini CLI**: `~/.gemini/tmp/` (session-*.json)
- 각 어댑터는 `adapters/claude.js`, `adapters/codex.js`, `adapters/gemini.js`에 구현
- `adapters/index.js`가 레지스트리 역할, 설치된 CLI만 자동 감지

## 모드
- **WORLD**: 아이소메트릭 픽셀 월드에서 에이전트가 캐릭터로 돌아다님
- **DASHBOARD**: 에이전트별 카드 형태로 도구 사용/활동 실시간 모니터링

## 주요 기능
- **카메라 팔로우**: 에이전트 클릭 시 카메라가 lerp으로 부드럽게 따라감 (드래그 시 해제)
- **실시간 활동 패널**: 우측 320px 패널에서 도구 히스토리, 메시지, 토큰 사용량 2초 폴링
- **토큰 사용량**: 컨텍스트 프로그레스 바 + input/output/cache/turns + 예상 비용
- **대화 애니메이션**: SendMessage 사용 시 캐릭터가 상대에게 걸어가서 말풍선 표시
- **세션 감지**: history.jsonl + subagents/ + 프로젝트 디렉토리 직접 스캔 (고아 세션 포함)

## 이벤트 흐름
- `agent:selected` → ActivityPanel 열기 + 카메라 팔로우 시작
- `agent:deselected` → ActivityPanel 닫기 + 카메라 팔로우 해제
- `agent:updated` → 스프라이트/패널 실시간 갱신
- `agent:added` / `agent:removed` → 스프라이트 생성/제거

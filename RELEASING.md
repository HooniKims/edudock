# 릴리즈 절차

1. `package.json`의 `version`을 올립니다(예: 0.10.0 → 0.10.1).
2. `CHANGELOG.md` 맨 위에 `## 0.10.1 — 한 줄 요약`과 사용자에게 보일 변경 내용을 적습니다.
3. 커밋하고 push 합니다.
4. `npm run release` — 테스트 → 빌드 → GitHub 릴리즈 게시.
   먼저 페이지를 확인하고 싶으면 `npm run release -- --draft`로 초안을 만든 뒤 GitHub에서 게시합니다.
   (초안 상태에서는 자동 업데이트가 새 버전을 보지 못합니다.)

릴리즈에 올라가는 파일:

| 파일 | 용도 |
| --- | --- |
| `EduDock-Setup-<버전>.exe` | 설치형 |
| `EduDock-Setup-<버전>.exe.blockmap` | 자동 업데이트의 차등 다운로드 |
| `latest.yml` | 설치형이 새 버전을 알아보는 파일 — **빠지면 자동 업데이트가 멈춥니다** |
| `EduDock-Portable-<버전>.exe` | 포터블 |
| `SHA256SUMS.txt` | 내려받은 파일 확인용 해시 |

## 주의

- 한 번 게시한 버전 번호는 다시 쓰지 않습니다. 잘못 올렸으면 번호를 올려 새로 게시합니다.
- 코드 서명이 없어 Windows SmartScreen 경고가 뜹니다. 서명 인증서를 쓰게 되면
  `package.json`의 `build.win.signExecutable`을 켜고 인증서 경로를 환경 변수로 넘깁니다(저장소에 넣지 않음).
- 게시 전 실제 설치본 점검: `node scripts/qa-v2-full.cjs` (설치된 위젯을 먼저 종료).

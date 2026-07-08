# 🏫 학급 게시판

학생·학부모가 보는 우리 반 게시판입니다. [우리말샘 핀](https://woorimalsam-lab.github.io/woorimalsam/)(교사용 앱)과 같은 Firebase 프로젝트를 사용합니다.

**주소: https://woorimalsam-lab.github.io/classboard/**

## 메뉴 구성

| 메뉴 | 내용 | 데이터 출처 |
|---|---|---|
| 📢 공지사항 | 마감 일자·제출 서류 공지 (D-day 자동 표시) | Firestore `classboard_notices` — 교사가 게시판에서 직접 작성 |
| 📋 출결 | 날짜별 출결 특이사항 (기록 없으면 "전원 출석") | 우리말샘 핀 → 출결에서 **게시판 공유**를 켜면 자동 발행 |
| 📅 일정 | 학사일정 달력 + 다가오는 일정 D-day | 우리말샘 핀의 `academic-calendar.js`를 실시간으로 불러옴 |
| 🍽️ 급식 | 주간 급식 식단표 (알레르기 정보 포함) | NEIS 교육정보 개방 포털 API (심원고등학교) |
| 💌 익명 우체통 | 학생 → 교사 1:1 비밀 메시지 (완전 익명 가능) | Firestore `classboard_messages` — 교사만 열람 가능 |

## ⚙️ 최초 1회 설정 (필수)

**Firestore 보안 규칙 적용** — 이걸 해야 공지·출결·익명 메시지가 동작합니다.

1. [Firebase 콘솔 → Firestore 규칙](https://console.firebase.google.com/project/woorimalsam-7f454/firestore/rules) 접속 (woorimalsam@gmail.com 로그인)
2. 기존 규칙을 지우고 이 폴더의 **`firestore.rules`** 파일 내용을 통째로 붙여넣기
3. **[게시]** 버튼 클릭

## 👩‍🏫 교사 사용법

- **공지 쓰기**: 게시판 우측 상단 **교사 로그인**(구글) → 공지사항 탭에 **+ 공지 쓰기** 버튼이 나타남
- **출결 공유**: 우리말샘 핀에 구글 로그인 → 출결 탭 → **🌐 게시판 공유** 버튼을 켬 → 이후 출결을 입력할 때마다 자동으로 게시판에 반영 (비고는 공유되지 않음)
- **익명 메시지 확인**: 교사 로그인 상태에서 익명 우체통 탭 → 받은 메시지함 표시

## 🧑‍🎓 학생 사용법

로그인 없이 모든 메뉴 이용 가능. 익명 우체통에서 선생님께 비밀 메시지를 보낼 수 있고, 보낸 내용은 선생님만 볼 수 있습니다.

## 파일 구성

- `index.html` / `style.css` / `app.js` — 게시판 본체 (정적 사이트, GitHub Pages 배포)
- `config.js` — Firebase 설정, 교사 이메일, NEIS 학교 코드
- `firestore.rules` — Firebase 콘솔에 붙여넣는 보안 규칙 (배포 파일 아님)

## 참고

- 급식 API는 키 없이 동작합니다. 호출이 많아져 제한에 걸리면 [NEIS 개방 포털](https://open.neis.go.kr)에서 무료 키를 발급받아 `config.js`의 `NEIS.key`에 넣으세요.
- 학사일정이 바뀌면 우리말샘 핀 저장소의 `academic-calendar.js`만 교체하면 게시판에도 자동 반영됩니다.

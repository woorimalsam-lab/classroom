// ============================================================
//  학급 게시판 설정
//  - Firebase 설정은 '우리말샘 핀'과 같은 프로젝트를 사용합니다.
//  - 이 값들은 웹에 공개돼도 되는 값입니다(비밀번호 아님).
//    보안은 Firestore 규칙(firestore.rules 참고)으로 처리합니다.
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyDxCefa6kRAGkq5zWFKiX-Ikiy0eXqI-cs",
  authDomain: "woorimalsam-7f454.firebaseapp.com",
  projectId: "woorimalsam-7f454",
  storageBucket: "woorimalsam-7f454.firebasestorage.app",
  messagingSenderId: "488196268358",
  appId: "1:488196268358:web:fc8446a9c8c09c62e8c547",
  measurementId: "G-RN0PNKFEBC",
};

// 교사(관리자) 구글 계정 — 이 계정으로 로그인해야 공지 작성/익명 메시지 열람 가능
export const TEACHER_EMAIL = "woorimalsam@gmail.com";

// 학급 이름 (게시판 상단에 표시)
export const CLASS_NAME = "심원고등학교";

// NEIS 급식 API — 심원고등학교
export const NEIS = {
  office: "J10",       // 경기도교육청
  school: "7530095",   // 심원고등학교
  key: "",             // 비워두면 키 없이 호출(소규모 사용은 충분). 필요시 open.neis.go.kr에서 발급한 키 입력
};

// 학사일정 데이터 원본 — 우리말샘 핀의 학사일정 파일을 그대로 가져와 자동 동기화
export const ACADEMIC_CALENDAR_URL =
  "https://woorimalsam-lab.github.io/woorimalsam/academic-calendar.js";

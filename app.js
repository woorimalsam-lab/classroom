// ============================================================
//  학급 게시판
//  - 공지사항/익명 우체통: Firebase Firestore
//  - 출결: 우리말샘 핀에서 발행한 Firestore 문서(classboard/attendance)
//  - 일정: 우리말샘 핀의 학사일정 파일 자동 동기화
//  - 급식: NEIS 교육정보 개방 포털 API
// ============================================================
import {
  firebaseConfig, TEACHER_EMAIL, NEIS, ACADEMIC_CALENDAR_URL,
} from "./config.js";

const $ = (id) => document.getElementById(id);

// ---------- 공용 유틸 ----------
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayStr() { return ymd(new Date()); }
function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function daysDiff(dateStr) {
  return Math.round((parseYmd(dateStr) - parseYmd(todayStr())) / 86400000);
}
const DOW = "일월화수목금토";
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastTimer = null;
function toast(msg, ms = 3000) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

// ---------- 테마 ----------
function initTheme() {
  const saved = localStorage.getItem("classboard.theme");
  const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(dark);
  $("theme-btn").addEventListener("click", () => {
    const nowDark = document.documentElement.dataset.theme !== "dark";
    applyTheme(nowDark);
    localStorage.setItem("classboard.theme", nowDark ? "dark" : "light");
  });
}
function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("theme-btn").textContent = dark ? "☀️" : "🌙";
}

// ---------- 탭 ----------
function initTabs() {
  document.querySelectorAll(".navbtn").forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });
}
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $(`view-${name}`).classList.remove("hidden");
  document.querySelectorAll(".navbtn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  if (name === "meal" && !mealLoaded) loadMeals();
  if (name === "calendar" && !calLoaded) loadCalendar();
  if (name === "timetable" && !ttLoaded) loadTimetableIndex();
}

// ============================================================
//  Firebase 초기화 / 교사 인증
// ============================================================
let fb = null;
let isTeacher = false;

async function initFirebase() {
  const appMod = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
  const authMod = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  const fsMod = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  const app = appMod.initializeApp(firebaseConfig);
  fb = { auth: authMod.getAuth(app), db: fsMod.getFirestore(app), authMod, fs: fsMod };

  authMod.onAuthStateChanged(fb.auth, (user) => {
    isTeacher = !!user && user.email === TEACHER_EMAIL;
    if (user && !isTeacher) {
      toast("교사 계정이 아니어서 로그아웃합니다");
      authMod.signOut(fb.auth);
      return;
    }
    updateTeacherUI();
    if (isTeacher) {
      subscribeSecrets();
      subscribeSurveyResponses();
    } else {
      if (secretsUnsub) { secretsUnsub(); secretsUnsub = null; }
      if (surveyRespUnsub) { surveyRespUnsub(); surveyRespUnsub = null; surveyResponses = []; }
    }
  });

  subscribeNotices();
  subscribeAttendance();
  subscribeClassEvents();
  subscribeRoster();
  subscribeSurveys();
}

function updateTeacherUI() {
  $("teacher-badge").classList.toggle("hidden", !isTeacher);
  $("login-btn").classList.toggle("hidden", isTeacher);
  $("logout-btn").classList.toggle("hidden", !isTeacher);
  $("notice-add-btn").classList.toggle("hidden", !isTeacher);
  $("event-add-btn").classList.toggle("hidden", !isTeacher);
  $("roster-edit-btn").classList.toggle("hidden", !isTeacher);
  $("check-add-btn").classList.toggle("hidden", !isTeacher);
  $("survey-add-btn").classList.toggle("hidden", !isTeacher);
  $("secret-teacher").classList.toggle("hidden", !isTeacher);
  $("secret-student").classList.toggle("hidden", isTeacher);
  renderNotices();
  renderRoster();
  renderSurveys();
  if (calLoaded) renderCalendar();
}

async function login() {
  if (!fb) return;
  const { GoogleAuthProvider, signInWithPopup, signInWithRedirect } = fb.authMod;
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(fb.auth, provider);
  } catch (e) {
    if (["auth/popup-blocked", "auth/popup-closed-by-user",
         "auth/operation-not-supported-in-this-environment"].includes(e?.code)) {
      await signInWithRedirect(fb.auth, provider);
    } else {
      console.error(e);
      toast("로그인에 실패했습니다");
    }
  }
}

// ============================================================
//  공지사항
// ============================================================
let notices = [];
let noticesLoadFailed = false;
let editingNoticeId = null;

function subscribeNotices() {
  const { collection, onSnapshot } = fb.fs;
  onSnapshot(collection(fb.db, "classboard_notices"),
    (snap) => {
      notices = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      noticesLoadFailed = false;
      renderNotices();
    },
    (err) => {
      console.error("공지 불러오기 실패", err);
      noticesLoadFailed = true;
      renderNotices();
    });
}

function ddayChip(deadline) {
  if (!deadline) return "";
  const diff = daysDiff(deadline);
  const [, m, d] = deadline.split("-").map(Number);
  const dateTxt = `${m}/${d}(${DOW[parseYmd(deadline).getDay()]})`;
  if (diff < 0) return `<span class="dday past">마감 · ${dateTxt}</span>`;
  if (diff === 0) return `<span class="dday today">오늘 마감! · ${dateTxt}</span>`;
  if (diff <= 3) return `<span class="dday soon">D-${diff} · ${dateTxt}</span>`;
  return `<span class="dday">D-${diff} · ${dateTxt}</span>`;
}

// 정렬: 고정 → 마감 임박 → 마감 없음(최신순) → 마감 지난 공지
function noticeOrder(a, b) {
  if (!!b.pinned - !!a.pinned) return !!b.pinned - !!a.pinned;
  const da = a.deadline ? daysDiff(a.deadline) : null;
  const db = b.deadline ? daysDiff(b.deadline) : null;
  const rank = (x) => (x === null ? 1 : x < 0 ? 2 : 0);
  if (rank(da) !== rank(db)) return rank(da) - rank(db);
  if (rank(da) === 0) return da - db;
  return (b.createdAt || 0) - (a.createdAt || 0);
}

function renderNotices() {
  const list = $("notice-list");
  if (noticesLoadFailed) {
    list.innerHTML = `<div class="empty-state">⚠️ 공지를 불러올 수 없습니다.<br/>
      <b>Firestore 보안 규칙</b>이 아직 설정되지 않았을 수 있어요. (README 참고)</div>`;
    return;
  }
  if (!notices.length) {
    list.innerHTML = `<div class="empty-state">아직 등록된 공지가 없습니다.</div>`;
    return;
  }
  list.innerHTML = [...notices].sort(noticeOrder).map((n) => {
    const items = (n.items || []).length
      ? `<div class="notice-items">📎 ${n.items.map((i) => `<span class="notice-item-chip">${escapeHtml(i)}</span>`).join("")}</div>`
      : "";
    const created = n.createdAt ? new Date(n.createdAt).toLocaleDateString("ko-KR") : "";
    const editBtn = isTeacher
      ? `<button class="btn btn-ghost btn-sm" data-edit="${n.id}">✏️ 수정</button>` : "";
    return `<div class="notice-card ${n.pinned ? "pinned" : ""}">
      <div class="notice-top">
        <span class="notice-title">${n.pinned ? "📌 " : ""}${escapeHtml(n.title)}</span>
        ${ddayChip(n.deadline)}
      </div>
      <div class="notice-body">${escapeHtml(n.body)}</div>
      ${items}
      <div class="notice-foot">
        <span class="notice-date">${created} 등록</span>
        <span class="spacer"></span>${editBtn}
      </div>
    </div>`;
  }).join("");
  list.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openNoticeModal(b.dataset.edit)));
}

function openNoticeModal(id = null) {
  editingNoticeId = id;
  const n = id ? notices.find((x) => x.id === id) : null;
  $("notice-modal-title").textContent = n ? "공지 수정" : "공지 쓰기";
  $("nt-title").value = n?.title || "";
  $("nt-body").value = n?.body || "";
  $("nt-deadline").value = n?.deadline || "";
  $("nt-items").value = (n?.items || []).join(", ");
  $("nt-pinned").checked = !!n?.pinned;
  $("nt-delete").classList.toggle("hidden", !n);
  $("nt-save").textContent = n ? "저장" : "등록";
  $("notice-modal").classList.remove("hidden");
}

async function saveNotice() {
  const title = $("nt-title").value.trim();
  const body = $("nt-body").value.trim();
  if (!title) { toast("제목을 입력해 주세요"); return; }
  const data = {
    title, body,
    deadline: $("nt-deadline").value || null,
    items: $("nt-items").value.split(",").map((s) => s.trim()).filter(Boolean),
    pinned: $("nt-pinned").checked,
  };
  const { doc, collection, addDoc, updateDoc } = fb.fs;
  try {
    if (editingNoticeId) {
      await updateDoc(doc(fb.db, "classboard_notices", editingNoticeId), data);
    } else {
      await addDoc(collection(fb.db, "classboard_notices"), { ...data, createdAt: Date.now() });
    }
    $("notice-modal").classList.add("hidden");
    toast("공지가 저장되었습니다 📢");
  } catch (e) {
    console.error(e);
    toast("저장 실패 — Firestore 규칙과 로그인 상태를 확인해 주세요", 5000);
  }
}

async function deleteNotice() {
  if (!editingNoticeId || !confirm("이 공지를 삭제할까요?")) return;
  const { doc, deleteDoc } = fb.fs;
  try {
    await deleteDoc(doc(fb.db, "classboard_notices", editingNoticeId));
    $("notice-modal").classList.add("hidden");
    toast("삭제되었습니다");
  } catch (e) { console.error(e); toast("삭제 실패"); }
}

// ============================================================
//  출결 — 우리말샘 핀이 발행한 classboard/attendance 문서 구독
//  구조: { updatedAt, days: { "YYYY-MM-DD": { "학년-반": [{no, name, label, s}] } } }
// ============================================================
let attData = null;
let attLoadFailed = false;
let attDate = todayStr();

function subscribeAttendance() {
  const { doc, onSnapshot } = fb.fs;
  onSnapshot(doc(fb.db, "classboard", "attendance"),
    (snap) => {
      attData = snap.exists() ? snap.data() : null;
      attLoadFailed = false;
      renderAttendance();
    },
    (err) => {
      console.error("출결 불러오기 실패", err);
      attLoadFailed = true;
      renderAttendance();
    });
}

function attClassKeys() {
  const keys = new Set();
  Object.values(attData?.days || {}).forEach((day) => Object.keys(day).forEach((k) => keys.add(k)));
  return [...keys].sort();
}

function renderAttendance() {
  const content = $("att-content");
  $("att-date").value = attDate;

  const d = parseYmd(attDate);
  const dayTxt = `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
  const evs = allEvents().filter((a) => a.date === attDate);
  const isWeekend = d.getDay() === 0 || d.getDay() === 6;
  const isHoliday = evs.some((a) => a.holiday);
  let info = dayTxt;
  if (evs.length) info += ` · 📌 ${evs.map((a) => a.title).join(" · ")}`;
  $("att-dayinfo").innerHTML = (isWeekend || isHoliday)
    ? `<span class="att-off">${info} — ${isWeekend ? "주말" : "휴일"}입니다</span>` : info;

  if (attLoadFailed) {
    content.innerHTML = `<div class="empty-state">⚠️ 출결 정보를 불러올 수 없습니다.<br/>
      <b>Firestore 보안 규칙</b>이 아직 설정되지 않았을 수 있어요. (README 참고)</div>`;
    return;
  }
  if (!attData) {
    content.innerHTML = `<div class="empty-state">아직 공유된 출결 데이터가 없습니다.<br/>
      선생님이 <b>우리말샘 핀 → 출결</b>에서 <b>게시판 공유</b>를 켜면 자동으로 표시됩니다.</div>`;
    $("att-updated").textContent = "";
    return;
  }

  if (attData.updatedAt) {
    $("att-updated").textContent =
      `마지막 업데이트: ${new Date(attData.updatedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  }

  // 학급 선택
  const keys = attClassKeys();
  const sel = $("att-class");
  const prev = sel.value;
  sel.innerHTML = keys.map((k) => `<option value="${k}">${k.split("-").join("학년 ")}반</option>`).join("")
    || `<option value="">학급 없음</option>`;
  if (keys.includes(prev)) sel.value = prev;

  const records = attData.days?.[attDate]?.[sel.value] || [];
  if (!records.length) {
    content.innerHTML = `<div class="att-allpresent">🎉 특이사항 없음 — 전원 출석!</div>
      <p class="muted small" style="margin-top:8px;text-align:center;">(선생님이 아직 입력 전일 수도 있어요)</p>`;
    return;
  }

  // 요약 칩
  const counts = {};
  records.forEach((r) => { counts[r.label] = (counts[r.label] || 0) + 1; });
  const summary = Object.entries(counts)
    .map(([k, v]) => `<span class="att-sum-chip">${escapeHtml(k)} ${v}명</span>`).join("");

  const rows = [...records].sort((a, b) => (a.no || 0) - (b.no || 0)).map((r) => `
    <tr>
      <td>${escapeHtml(String(r.no ?? ""))}</td>
      <td>${escapeHtml(r.name)}</td>
      <td><span class="att-label ${r.s === "결석" ? "absent" : ""}">${escapeHtml(r.label)}</span></td>
    </tr>`).join("");

  content.innerHTML = `
    <div class="att-summary">${summary}</div>
    <div class="table-wrap">
      <table class="att-table">
        <thead><tr><th>번호</th><th>이름</th><th>구분</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function shiftAttDate(delta) {
  const d = parseYmd(attDate);
  d.setDate(d.getDate() + delta);
  attDate = ymd(d);
  renderAttendance();
}

// ============================================================
//  학사일정 — 우리말샘 핀의 academic-calendar.js 자동 동기화
//  + 학급 일정 — 교사가 게시판에서 직접 추가 (classboard/events 문서)
// ============================================================
let academicEvents = [];
let academicMeta = null;
let classEvents = [];
let editingEventId = null;
let calLoaded = false;
let calYear, calMonth; // month: 0-11

// 학교 학사일정 + 학급 일정 통합 목록 (학급 일정은 cls: true)
function allEvents() {
  return [
    ...academicEvents,
    ...classEvents.map((e) => ({ ...e, cls: true })),
  ];
}

function subscribeClassEvents() {
  const { doc, onSnapshot } = fb.fs;
  onSnapshot(doc(fb.db, "classboard", "events"),
    (snap) => {
      classEvents = (snap.exists() && Array.isArray(snap.data().events)) ? snap.data().events : [];
      if (calLoaded) renderCalendar();
      renderAttendance();
    },
    (err) => console.error("학급 일정 불러오기 실패", err));
}

function openEventModal(id = null, presetDate = null) {
  editingEventId = id;
  const ev = id ? classEvents.find((e) => e.id === id) : null;
  $("event-modal-title").textContent = ev ? "학급 일정 수정" : "학급 일정 추가";
  $("ev-title").value = ev?.title || "";
  $("ev-date").value = ev?.date || presetDate || todayStr();
  $("ev-delete").classList.toggle("hidden", !ev);
  $("event-modal").classList.remove("hidden");
  $("ev-title").focus();
}

async function saveClassEvents(next, doneMsg) {
  const { doc, setDoc } = fb.fs;
  try {
    await setDoc(doc(fb.db, "classboard", "events"), {
      events: next,
      updatedAt: new Date().toISOString(),
    });
    $("event-modal").classList.add("hidden");
    toast(doneMsg);
  } catch (e) {
    console.error(e);
    toast("저장 실패 — 교사 로그인 상태를 확인해 주세요", 5000);
  }
}

function saveClassEvent() {
  const title = $("ev-title").value.trim();
  const date = $("ev-date").value;
  if (!title) { toast("제목을 입력해 주세요"); return; }
  if (!date) { toast("날짜를 선택해 주세요"); return; }
  const next = [...classEvents];
  if (editingEventId) {
    const ev = next.find((e) => e.id === editingEventId);
    if (ev) { ev.title = title; ev.date = date; }
  } else {
    next.push({ id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, date, title });
  }
  saveClassEvents(next, "학급 일정이 저장되었습니다 🏫");
}

function deleteClassEvent() {
  if (!editingEventId || !confirm("이 학급 일정을 삭제할까요?")) return;
  saveClassEvents(classEvents.filter((e) => e.id !== editingEventId), "삭제되었습니다");
}

async function loadCalendarData() {
  try {
    const mod = await import(ACADEMIC_CALENDAR_URL);
    academicEvents = mod.academicEvents || [];
    academicMeta = mod.academicMeta || null;
  } catch (e) {
    console.error("학사일정 로딩 실패", e);
  }
}

function loadCalendar() {
  calLoaded = true;
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  renderCalendar();
}

function renderCalendar() {
  $("cal-meta").textContent = academicMeta
    ? `${academicMeta.label} · ${academicMeta.note || ""}` : "";
  $("cal-month-label").textContent = `${calYear}년 ${calMonth + 1}월`;

  const first = new Date(calYear, calMonth, 1);
  const start = new Date(calYear, calMonth, 1 - first.getDay());
  const today = todayStr();
  let html = DOW.split("").map((d, i) =>
    `<div class="cal-dow ${i === 0 ? "sun" : ""}">${d}</div>`).join("");

  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const ds = ymd(d);
    const inMonth = d.getMonth() === calMonth;
    const evs = allEvents().filter((a) => a.date === ds);
    const cls = [
      "cal-cell",
      inMonth ? "" : "other",
      ds === today ? "today" : "",
      d.getDay() === 0 ? "sun" : "",
    ].join(" ");
    html += `<div class="${cls}">
      <span class="cal-daynum">${d.getDate()}</span>
      ${evs.map((e) => e.cls
        ? `<span class="cal-ev cls ${isTeacher ? "editable" : ""}" data-evid="${e.id}" title="${escapeHtml(e.title)}${isTeacher ? " (클릭하여 수정)" : ""}">🏫 ${escapeHtml(e.title)}</span>`
        : `<span class="cal-ev ${e.holiday ? "holiday" : ""}" title="${escapeHtml(e.title)}">${escapeHtml(e.title)}</span>`).join("")}
    </div>`;
  }
  $("cal-grid").innerHTML = html;

  // 다가오는 일정 (오늘부터 8건, 학교+학급 일정 통합)
  const upcoming = allEvents()
    .filter((a) => daysDiff(a.date) >= 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8);
  $("cal-upcoming").innerHTML = upcoming.length
    ? upcoming.map((e) => {
        const diff = daysDiff(e.date);
        const d = parseYmd(e.date);
        return `<div class="upcoming-item">
          <span class="upcoming-dday">${diff === 0 ? "오늘" : `D-${diff}`}</span>
          <span>${e.cls ? "🏫 " : e.holiday ? "🔴 " : ""}${escapeHtml(e.title)}</span>
          <span class="spacer"></span>
          <span class="upcoming-date">${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})</span>
        </div>`;
      }).join("")
    : `<div class="empty-state">예정된 일정이 없습니다.</div>`;
}

function shiftCalMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}

// ============================================================
//  시간표 — 컴시간 뷰어(timetable) 데이터 직접 연동
//  같은 도메인(woorimalsam-lab.github.io)이라 data/*.json을 그대로 사용
// ============================================================
const TT_BASE = "https://woorimalsam-lab.github.io/timetable/";
const TT_DAYS = ["월", "화", "수", "목", "금"];
let ttLoaded = false;
let ttIndex = null;       // {school, current, weeks:[{start,label}]}
let ttWeekData = null;    // 선택된 주차의 시간표 데이터
let ttWeekCache = {};     // weekStart -> data

async function loadTimetableIndex() {
  ttLoaded = true;
  try {
    ttIndex = await (await fetch(`${TT_BASE}data/index.json?t=${Date.now()}`)).json();
  } catch (e) {
    console.error("시간표 목록 로딩 실패", e);
    $("tt-grid").innerHTML = `<div class="empty-state">⚠️ 시간표를 불러오지 못했습니다.<br/>잠시 후 다시 시도해 주세요.</div>`;
    return;
  }
  // 주차 선택 채우기 (기본: 오늘이 포함된 주 → current → 첫 번째)
  const weekSel = $("tt-week");
  weekSel.innerHTML = ttIndex.weeks.map((w) => `<option value="${w.start}">${w.label}</option>`).join("");

  // 학년 채우기
  $("tt-grade").innerHTML = [1, 2, 3].map((g) => `<option value="${g}">${g}학년</option>`).join("");

  // 오늘 날짜가 속한 주(월~일) 우선 선택, 없으면 index.current, 없으면 첫 번째
  const today = todayStr();
  const inWeek = ttIndex.weeks.find((w) => {
    const end = ymd(new Date(parseYmd(w.start).getTime() + 6 * 86400000));
    return today >= w.start && today <= end;
  });
  const defWeek = inWeek?.start
    || ttIndex.weeks.find((w) => w.start === ttIndex.current)?.start
    || ttIndex.weeks[0]?.start;
  if (defWeek) weekSel.value = defWeek;
  await loadTimetableWeek(defWeek);
}

async function loadTimetableWeek(weekStart) {
  if (!weekStart) return;
  const code = ttIndex.school.code;
  try {
    if (!ttWeekCache[weekStart]) {
      ttWeekCache[weekStart] = await (await fetch(`${TT_BASE}data/${code}_${weekStart}.json?t=${Date.now()}`)).json();
    }
    ttWeekData = ttWeekCache[weekStart];
  } catch (e) {
    console.error("시간표 주차 로딩 실패", e);
    $("tt-grid").innerHTML = `<div class="empty-state">⚠️ 이 주차의 시간표가 아직 없습니다.</div>`;
    return;
  }
  fillTtClasses();
  renderTimetable();
}

// 선택된 학년에 해당하는 반 목록 채우기
function ttClassList() {
  const set = new Set();
  for (const occ of Object.values(ttWeekData.per_teacher)) {
    for (const e of occ) { if (e.cls) set.add(e.cls); }
  }
  return [...set].sort((a, b) => {
    const [ag, ac] = a.split("-").map(Number), [bg, bc] = b.split("-").map(Number);
    return ag - bg || ac - bc;
  });
}
function fillTtClasses() {
  const grade = $("tt-grade").value;
  const classes = ttClassList().filter((c) => c.startsWith(grade + "-"));
  const prev = $("tt-class").value;
  $("tt-class").innerHTML = classes.map((c) => `<option value="${c}">${c.split("-")[1]}반</option>`).join("")
    || `<option value="">반 없음</option>`;
  if (classes.includes(prev)) $("tt-class").value = prev;
}

function renderTimetable() {
  const grid = $("tt-grid");
  if (!ttWeekData) return;
  const cls = $("tt-class").value;
  const times = ttWeekData.period_times || [];
  const maxP = ttWeekData.max_period ?? 6;

  // 오늘 요일 열 강조 (이번 주에 한해)
  const todayDow = new Date().getDay() - 1; // 월=0

  // 반별 시간표 맵 구성: map["day_period"] = {sub, teacher, changed}
  const map = {};
  if (cls) {
    for (const t of ttWeekData.teachers) {
      for (const e of (ttWeekData.per_teacher[t.idx] || [])) {
        if (e.cls === cls) map[`${e.day}_${e.period}`] = { sub: e.sub, teacher: t.name, changed: e.changed };
      }
    }
  }

  let head = `<tr><th class="tt-period-th">교시</th>`;
  TT_DAYS.forEach((d, i) => {
    head += `<th class="${i === todayDow ? "today-col" : ""}">${d}</th>`;
  });
  head += `</tr>`;

  let body = "";
  for (let p = 0; p <= maxP; p++) {
    const start = times[p] || "";
    body += `<tr><td class="tt-period-th">${p + 1}<small>${start}</small></td>`;
    for (let d = 0; d < 5; d++) {
      const cell = map[`${d}_${p}`];
      const todayCls = d === todayDow ? "today-col" : "";
      if (cell && cell.sub) {
        body += `<td class="tt-cell ${cell.changed ? "changed" : ""} ${todayCls}">
          <div class="tt-sub">${escapeHtml(cell.sub)}</div>
          <div class="tt-teacher">${escapeHtml(cell.teacher || "")}</div>
        </td>`;
      } else {
        body += `<td class="tt-cell ${todayCls}"><span class="tt-empty-cell">·</span></td>`;
      }
    }
    body += `</tr>`;
  }

  grid.innerHTML = `<table class="tt-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  const total = Object.values(map).filter((c) => c.sub).length;
  $("tt-meta").textContent = cls
    ? `${ttWeekData.school?.name || ttIndex.school.name} · ${ttWeekData.week_label || ""} · ${cls.split("-")[0]}학년 ${cls.split("-")[1]}반 · 주당 ${total}시간`
    : "";
}

// ============================================================
//  급식 — NEIS 교육정보 개방 포털
// ============================================================
let mealLoaded = false;
let mealWeekOffset = 0;

function weekRange(offset) {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + offset * 7);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  return [monday, friday];
}

async function loadMeals() {
  mealLoaded = true;
  const [mon, fri] = weekRange(mealWeekOffset);
  $("meal-week-label").textContent =
    `${mon.getMonth() + 1}/${mon.getDate()} ~ ${fri.getMonth() + 1}/${fri.getDate()}`;
  const list = $("meal-list");
  list.innerHTML = `<div class="empty-state">급식 정보를 불러오는 중…</div>`;

  const fmt = (d) => ymd(d).replaceAll("-", "");
  const url = `https://open.neis.go.kr/hub/mealServiceDietInfo?Type=json` +
    (NEIS.key ? `&KEY=${NEIS.key}` : "") +
    `&ATPT_OFCDC_SC_CODE=${NEIS.office}&SD_SCHUL_CODE=${NEIS.school}` +
    `&MLSV_FROM_YMD=${fmt(mon)}&MLSV_TO_YMD=${fmt(fri)}`;

  try {
    const res = await fetch(url);
    const json = await res.json();
    const rows = json.mealServiceDietInfo?.[1]?.row || [];
    renderMeals(mon, rows);
  } catch (e) {
    console.error("급식 로딩 실패", e);
    list.innerHTML = `<div class="empty-state">⚠️ 급식 정보를 불러오지 못했습니다.<br/>잠시 후 다시 시도해 주세요.</div>`;
  }
}

function formatDishes(ddish) {
  return (ddish || "").split(/<br\s*\/?>/i).map((line) => {
    const m = line.trim().match(/^(.*?)\s*(\([\d.]+\))?$/);
    const name = escapeHtml(m?.[1] || line.trim());
    const allergen = m?.[2] ? ` <span class="allergen">${escapeHtml(m[2])}</span>` : "";
    return name ? `<div>${name}${allergen}</div>` : "";
  }).join("");
}

function renderMeals(monday, rows) {
  const today = todayStr();
  const byDate = {};
  rows.forEach((r) => {
    const ds = `${r.MLSV_YMD.slice(0, 4)}-${r.MLSV_YMD.slice(4, 6)}-${r.MLSV_YMD.slice(6, 8)}`;
    (byDate[ds] ||= []).push(r);
  });

  let html = "";
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const ds = ymd(d);
    const meals = byDate[ds];
    const isToday = ds === today;
    const head = `<div class="meal-day">${d.getMonth() + 1}/${d.getDate()} (${DOW[d.getDay()]})
      ${isToday ? '<span class="meal-today-chip">오늘</span>' : ""}</div>`;
    if (!meals) {
      html += `<div class="meal-card ${isToday ? "today" : ""}">${head}
        <span class="muted small">급식 정보 없음 (휴일·방학 등)</span></div>`;
      continue;
    }
    const body = meals.map((r) => `
      ${meals.length > 1 ? `<div class="meal-kind">${escapeHtml(r.MMEAL_SC_NM)}</div>` : ""}
      <div class="meal-dishes">${formatDishes(r.DDISH_NM)}</div>
      ${r.CAL_INFO ? `<div class="meal-cal">🔥 ${escapeHtml(r.CAL_INFO)}</div>` : ""}
    `).join("");
    html += `<div class="meal-card ${isToday ? "today" : ""}">${head}${body}</div>`;
  }
  $("meal-list").innerHTML = html;
}

// ============================================================
//  명렬표 — 제출 항목별 체크리스트
//  roster: classboard/roster { students: [{no, name}] }
//  checklists: classboard/checklists { items: [{id, title, createdAt, checks: {no: {c, m}}}] }
// ============================================================
let roster = [];
let checklists = [];
let activeChecklistId = null;
let editingChecklistId = null;
let checklistSaveTimer = null;

function subscribeRoster() {
  const { doc, onSnapshot } = fb.fs;
  onSnapshot(doc(fb.db, "classboard", "roster"),
    (snap) => {
      roster = (snap.exists() && Array.isArray(snap.data().students)) ? snap.data().students : [];
      renderRoster();
    },
    (err) => console.error("명단 불러오기 실패", err));
  onSnapshot(doc(fb.db, "classboard", "checklists"),
    (snap) => {
      checklists = (snap.exists() && Array.isArray(snap.data().items)) ? snap.data().items : [];
      if (!checklists.some((i) => i.id === activeChecklistId)) activeChecklistId = checklists[0]?.id || null;
      renderRoster();
    },
    (err) => console.error("제출 항목 불러오기 실패", err));
}

function renderRoster() {
  const itemsEl = $("check-items");
  const tableEl = $("check-table");
  if (!itemsEl) return;

  if (!checklists.length) {
    itemsEl.innerHTML = "";
    tableEl.innerHTML = `<div class="empty-state">아직 제출 항목이 없습니다.${isTeacher ? "<br/><b>+ 제출 항목</b> 버튼으로 추가해 보세요." : ""}</div>`;
    return;
  }

  itemsEl.innerHTML = checklists.map((i) =>
    `<button class="check-item-chip ${i.id === activeChecklistId ? "active" : ""}" data-cid="${i.id}">📋 ${escapeHtml(i.title)}</button>`).join("");
  itemsEl.querySelectorAll("[data-cid]").forEach((b) =>
    b.addEventListener("click", () => { activeChecklistId = b.dataset.cid; renderRoster(); }));

  const item = checklists.find((i) => i.id === activeChecklistId);
  if (!item) { tableEl.innerHTML = ""; return; }

  if (!roster.length) {
    tableEl.innerHTML = `<div class="empty-state">등록된 명단이 없습니다.${isTeacher ? "<br/><b>👥 명단 등록</b> 버튼으로 학생 명단을 올려 주세요." : "<br/>선생님이 명단을 등록하면 표시됩니다."}</div>`;
    return;
  }

  const checks = item.checks || {};
  const doneCount = roster.filter((s) => checks[String(s.no)]?.c).length;
  const editBtn = isTeacher
    ? `<button class="btn btn-ghost btn-sm" id="check-item-edit">✏️ 항목 수정</button>` : "";

  const rows = roster.map((s) => {
    const rec = checks[String(s.no)] || {};
    const checkCell = isTeacher
      ? `<button class="check-btn ${rec.c ? "done" : ""}" data-no="${s.no}">${rec.c ? "✓" : "·"}</button>`
      : `<button class="check-btn ${rec.c ? "done" : ""}" disabled>${rec.c ? "✓" : "·"}</button>`;
    const memoCell = isTeacher
      ? `<input class="check-memo" data-no="${s.no}" value="${escapeHtml(rec.m || "")}" placeholder="비고" maxlength="50" />`
      : `<span class="check-memo-view">${escapeHtml(rec.m || "")}</span>`;
    return `<tr><td>${s.no}</td><td>${escapeHtml(s.name)}</td><td>${checkCell}</td><td>${memoCell}</td></tr>`;
  }).join("");

  tableEl.innerHTML = `
    <div class="check-head">
      <h3>📋 ${escapeHtml(item.title)}</h3>
      <span class="check-progress">제출 ${doneCount} / ${roster.length}</span>
      <span class="spacer"></span>${editBtn}
    </div>
    <div class="check-table-wrap">
      <table class="att-table">
        <thead><tr><th>번호</th><th>이름</th><th>제출</th><th>비고</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  $("check-item-edit")?.addEventListener("click", () => openChecklistModal(item.id));
  if (isTeacher) {
    tableEl.querySelectorAll(".check-btn[data-no]").forEach((b) =>
      b.addEventListener("click", () => {
        const rec = (item.checks ||= {})[String(b.dataset.no)] ||= {};
        rec.c = !rec.c;
        renderRoster();
        scheduleChecklistSave();
      }));
    tableEl.querySelectorAll(".check-memo[data-no]").forEach((inp) =>
      inp.addEventListener("change", () => {
        const rec = (item.checks ||= {})[String(inp.dataset.no)] ||= {};
        rec.m = inp.value.trim();
        scheduleChecklistSave();
      }));
  }
}

function scheduleChecklistSave() {
  clearTimeout(checklistSaveTimer);
  checklistSaveTimer = setTimeout(saveChecklists, 600);
}
async function saveChecklists() {
  const { doc, setDoc } = fb.fs;
  try {
    await setDoc(doc(fb.db, "classboard", "checklists"), {
      items: checklists,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error(e);
    toast("저장 실패 — 교사 로그인 상태를 확인해 주세요", 5000);
  }
}

function openChecklistModal(id = null) {
  editingChecklistId = id;
  const item = id ? checklists.find((i) => i.id === id) : null;
  $("checkitem-modal-title").textContent = item ? "제출 항목 수정" : "제출 항목 추가";
  $("ci-title").value = item?.title || "";
  $("ci-delete").classList.toggle("hidden", !item);
  $("checkitem-modal").classList.remove("hidden");
  $("ci-title").focus();
}
function saveChecklistItem() {
  const title = $("ci-title").value.trim();
  if (!title) { toast("항목 이름을 입력해 주세요"); return; }
  if (editingChecklistId) {
    const item = checklists.find((i) => i.id === editingChecklistId);
    if (item) item.title = title;
  } else {
    const id = `ci_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    checklists.push({ id, title, createdAt: Date.now(), checks: {} });
    activeChecklistId = id;
  }
  $("checkitem-modal").classList.add("hidden");
  renderRoster();
  saveChecklists().then(() => toast("제출 항목이 저장되었습니다 📋"));
}
function deleteChecklistItem() {
  if (!editingChecklistId || !confirm("이 제출 항목과 체크 기록을 삭제할까요?")) return;
  checklists = checklists.filter((i) => i.id !== editingChecklistId);
  if (activeChecklistId === editingChecklistId) activeChecklistId = checklists[0]?.id || null;
  $("checkitem-modal").classList.add("hidden");
  renderRoster();
  saveChecklists().then(() => toast("삭제되었습니다"));
}

function openRosterModal() {
  $("roster-text").value = roster.map((s) => `${s.no} ${s.name}`).join("\n");
  $("roster-file").value = "";
  $("roster-file-result").classList.add("hidden");
  $("roster-modal").classList.remove("hidden");
  $("roster-text").focus();
}

// ---- 나이스 명렬표 파일 업로드 → 자동 인식 ----------------------
// 엑셀 처리 라이브러리는 파일을 올릴 때만 로드 (CDN 실패 시 2차 소스 폴백)
function ensureXLSX() {
  if (typeof XLSX !== "undefined") return Promise.resolve();
  const load = (src) => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return load("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js")
    .catch(() => load("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"))
    .catch(() => { throw new Error("엑셀 처리 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요."); });
}

const cellStr = (v) => String(v ?? "").trim();

// 나이스 명렬표(여러 형식)에서 [{no, name}] 추출
function parseNeisRoster(data) {
  if (!Array.isArray(data) || !data.length) return { error: "파일이 비어있습니다" };

  // 1) 헤더 행 탐색: 위에서 30행 안에 '성명'/'이름' 칸이 있는 행
  let headerRow = -1, numberIdx = -1, nameIdx = -1;
  for (let r = 0; r < Math.min(data.length, 30); r++) {
    const row = data[r] || [];
    let nI = -1, nmI = -1;
    for (let i = 0; i < row.length; i++) {
      const h = cellStr(row[i]).replace(/\s+/g, "").toLowerCase();
      if (h === "번호" || h === "번" || h === "no" || h === "number") nI = i;
      if (h === "성명" || h === "이름" || h === "name") nmI = i;
    }
    if (nmI !== -1) { headerRow = r; numberIdx = nI; nameIdx = nmI; break; }
  }

  const students = [];
  const push = (no, name) => {
    name = cellStr(name);
    if (!name || /^\d+$/.test(name)) return;
    const n = parseInt(cellStr(no).replace(/번$/, ""), 10);
    students.push({ no: Number.isFinite(n) ? n : students.length + 1, name });
  };

  if (headerRow !== -1) {
    // 표 형식: 헤더 아래 행들에서 번호·성명 열 추출
    for (let i = headerRow + 1; i < data.length; i++) {
      const row = (data[i] || []).map(cellStr);
      if (!row.some(Boolean)) continue;
      push(numberIdx !== -1 ? row[numberIdx] : "", row[nameIdx]);
    }
  } else {
    // 사진명렬표 형식: "1번 강건" 같은 셀이 흩어져 있음
    for (const row of data) {
      for (const cell of row || []) {
        const m = /^(\d{1,3})\s*번?\s+(.+)$/.exec(cellStr(cell));
        if (m && m[2].trim() && !/^\d+$/.test(m[2].trim())) push(m[1], m[2]);
      }
    }
  }

  if (!students.length) return { error: "학생을 찾지 못했습니다. '번호/성명' 열이 있는 명렬표인지 확인해 주세요." };
  // 번호 중복 제거(같은 번호는 첫 항목만) 후 정렬
  const seen = new Set();
  const unique = students.filter((s) => !seen.has(s.no) && seen.add(s.no));
  return { students: unique.sort((a, b) => a.no - b.no) };
}

async function importRosterFile(file) {
  const resultEl = $("roster-file-result");
  const show = (ok, msg) => {
    resultEl.classList.remove("hidden", "success", "error");
    resultEl.classList.add(ok ? "success" : "error");
    resultEl.textContent = `${ok ? "✅" : "❌"} ${msg}`;
  };
  try {
    await ensureXLSX();
    const isExcel = /\.xlsx?$|\.xls$/i.test(file.name);
    const content = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다"));
      if (isExcel) reader.readAsArrayBuffer(file);
      else reader.readAsText(file);
    });
    const wb = isExcel
      ? XLSX.read(new Uint8Array(content), { type: "array" })
      : XLSX.read(content, { type: "string" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
    const result = parseNeisRoster(rows);
    if (result.error) { show(false, result.error); return; }
    $("roster-text").value = result.students.map((s) => `${s.no} ${s.name}`).join("\n");
    show(true, `${result.students.length}명을 인식했습니다. 아래 명단을 확인하고 [저장]을 눌러 주세요.`);
  } catch (e) {
    console.error("명렬표 파일 처리 실패", e);
    show(false, e.message || "파일 처리 중 오류가 발생했습니다");
  }
}
async function saveRoster() {
  const lines = $("roster-text").value.split("\n").map((l) => l.trim()).filter(Boolean);
  const students = lines.map((line, idx) => {
    const m = line.match(/^(\d+)[.)]?\s+(.+)$/);
    return m ? { no: Number(m[1]), name: m[2].trim() } : { no: idx + 1, name: line };
  }).sort((a, b) => a.no - b.no);
  const { doc, setDoc } = fb.fs;
  try {
    await setDoc(doc(fb.db, "classboard", "roster"), {
      students,
      updatedAt: new Date().toISOString(),
    });
    $("roster-modal").classList.add("hidden");
    toast(`명단 ${students.length}명이 저장되었습니다 👥`);
  } catch (e) {
    console.error(e);
    toast("저장 실패 — 교사 로그인 상태를 확인해 주세요", 5000);
  }
}

// ============================================================
//  설문조사
//  정의: classboard/surveys { items: [{id, title, open, createdAt, questions:[{q, type, options}]}] }
//  응답: classboard_survey_responses/{id} {surveyId, no, name, answers:[], createdAt}
//  → 응답 제출은 누구나, 열람·삭제·엑셀은 교사만 (Firestore 규칙)
// ============================================================
let surveys = [];
let surveyResponses = [];
let activeSurveyId = null;
let surveyRespUnsub = null;
let svDraft = [];   // 설문 만들기 모달의 질문 목록

function subscribeSurveys() {
  const { doc, onSnapshot } = fb.fs;
  onSnapshot(doc(fb.db, "classboard", "surveys"),
    (snap) => {
      surveys = (snap.exists() && Array.isArray(snap.data().items)) ? snap.data().items : [];
      if (!surveys.some((s) => s.id === activeSurveyId)) activeSurveyId = null;
      renderSurveys();
    },
    (err) => console.error("설문 불러오기 실패", err));
}
function subscribeSurveyResponses() {
  if (surveyRespUnsub) return;
  const { collection, onSnapshot, query, orderBy } = fb.fs;
  const q = query(collection(fb.db, "classboard_survey_responses"), orderBy("createdAt", "asc"));
  surveyRespUnsub = onSnapshot(q, (snap) => {
    surveyResponses = snap.docs.map((d) => ({ rid: d.id, ...d.data() }));
    renderSurveys();
  }, (err) => console.error("설문 응답 불러오기 실패", err));
}

const surveyAnsweredKey = (id) => `classboard.survey.${id}`;

function renderSurveys() {
  const listEl = $("survey-list");
  if (!listEl) return;
  const detailEl = $("survey-detail");
  const visible = isTeacher ? surveys : surveys.filter((s) => s.open);

  if (!visible.length) {
    listEl.innerHTML = `<div class="empty-state">진행 중인 설문이 없습니다.${isTeacher ? "<br/><b>+ 설문 만들기</b>로 시작해 보세요." : ""}</div>`;
    detailEl.innerHTML = "";
    return;
  }

  listEl.innerHTML = visible.map((s) => {
    const count = surveyResponses.filter((r) => r.surveyId === s.id).length;
    const answered = localStorage.getItem(surveyAnsweredKey(s.id));
    const status = s.open
      ? `<span class="survey-status">진행 중</span>`
      : `<span class="survey-status closed">마감</span>`;
    const meta = isTeacher
      ? `질문 ${s.questions.length}개 · 응답 ${count}명`
      : `질문 ${s.questions.length}개${answered ? " · ✅ 참여 완료" : ""}`;
    const actions = isTeacher ? `
      <div class="survey-actions">
        <button class="btn btn-ghost btn-sm" data-sv-excel="${s.id}">📥 엑셀</button>
        <button class="btn btn-ghost btn-sm" data-sv-toggle="${s.id}">${s.open ? "마감하기" : "다시 열기"}</button>
        <button class="btn btn-ghost btn-sm" data-sv-del="${s.id}">삭제</button>
      </div>` : "";
    return `<div class="survey-card ${s.id === activeSurveyId ? "active" : ""}" data-sv="${s.id}">
      <div class="survey-card-top"><span class="survey-title">📊 ${escapeHtml(s.title)}</span>${status}</div>
      <div class="survey-meta">${meta}</div>
      ${actions}
    </div>`;
  }).join("");

  listEl.querySelectorAll("[data-sv]").forEach((card) =>
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-sv-excel],[data-sv-toggle],[data-sv-del]")) return;
      activeSurveyId = activeSurveyId === card.dataset.sv ? null : card.dataset.sv;
      renderSurveys();
    }));
  listEl.querySelectorAll("[data-sv-excel]").forEach((b) =>
    b.addEventListener("click", () => exportSurveyExcel(b.dataset.svExcel)));
  listEl.querySelectorAll("[data-sv-toggle]").forEach((b) =>
    b.addEventListener("click", () => toggleSurveyOpen(b.dataset.svToggle)));
  listEl.querySelectorAll("[data-sv-del]").forEach((b) =>
    b.addEventListener("click", () => deleteSurvey(b.dataset.svDel)));

  const sv = visible.find((s) => s.id === activeSurveyId);
  if (!sv) { detailEl.innerHTML = ""; return; }
  detailEl.innerHTML = isTeacher ? surveyResultHtml(sv) : surveyFormHtml(sv);
  if (!isTeacher) bindSurveyForm(sv);
}

// ---- 학생: 설문 참여 폼 ----
function surveyFormHtml(sv) {
  if (!sv.open) return `<div class="empty-state">마감된 설문입니다.</div>`;
  if (localStorage.getItem(surveyAnsweredKey(sv.id))) {
    return `<div class="sv-done">✅ 이미 참여한 설문입니다. 고마워요!</div>`;
  }
  const who = roster.length
    ? `<label>나는 누구인가요?
        <select id="sv-who">
          <option value="">— 번호·이름 선택 —</option>
          ${roster.map((s) => `<option value="${s.no}|${escapeHtml(s.name)}">${s.no}번 ${escapeHtml(s.name)}</option>`).join("")}
        </select>
      </label>`
    : `<label>이름 <input id="sv-who-name" type="text" placeholder="이름을 입력하세요" maxlength="20" /></label>`;
  const qs = sv.questions.map((q, i) => {
    const body = q.type === "choice"
      ? `<div class="sv-choices">${q.options.map((op) =>
          `<label class="sv-choice"><input type="radio" name="svq${i}" value="${escapeHtml(op)}" /> ${escapeHtml(op)}</label>`).join("")}</div>`
      : `<textarea class="sv-text" data-qi="${i}" rows="2" maxlength="300" placeholder="답변을 입력하세요"></textarea>`;
    return `<div class="sv-q"><div class="sv-q-title">Q${i + 1}. ${escapeHtml(q.q)}</div>${body}</div>`;
  }).join("");
  return `<div class="sv-form">
    <h3>📊 ${escapeHtml(sv.title)}</h3>
    ${who}${qs}
    <div class="sv-submit-row"><button id="sv-submit" class="btn btn-primary">제출하기</button></div>
  </div>`;
}

function bindSurveyForm(sv) {
  $("sv-submit")?.addEventListener("click", async () => {
    let no = 0, name = "";
    if (roster.length) {
      const v = $("sv-who").value;
      if (!v) { toast("번호·이름을 선택해 주세요"); return; }
      const [n, nm] = v.split("|");
      no = Number(n); name = nm;
    } else {
      name = $("sv-who-name").value.trim();
      if (!name) { toast("이름을 입력해 주세요"); return; }
    }
    const answers = sv.questions.map((q, i) => {
      if (q.type === "choice") {
        return document.querySelector(`input[name="svq${i}"]:checked`)?.value || "";
      }
      return document.querySelector(`.sv-text[data-qi="${i}"]`)?.value.trim() || "";
    });
    if (answers.some((a) => !a)) { toast("모든 질문에 답해 주세요"); return; }
    const btn = $("sv-submit");
    btn.disabled = true;
    try {
      const { collection, addDoc, serverTimestamp } = fb.fs;
      await addDoc(collection(fb.db, "classboard_survey_responses"), {
        surveyId: sv.id, no, name, answers, createdAt: serverTimestamp(),
      });
      localStorage.setItem(surveyAnsweredKey(sv.id), "1");
      renderSurveys();
      toast("설문이 제출되었습니다. 고마워요! 📊");
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      toast("제출에 실패했습니다. 잠시 후 다시 시도해 주세요.", 5000);
    }
  });
}

// ---- 교사: 결과 보기 ----
function surveyResultHtml(sv) {
  const resps = surveyResponses.filter((r) => r.surveyId === sv.id)
    .sort((a, b) => (a.no || 0) - (b.no || 0));
  if (!resps.length) return `<div class="empty-state">아직 응답이 없습니다.</div>`;

  const qHtml = sv.questions.map((q, i) => {
    if (q.type === "choice") {
      const counts = {};
      q.options.forEach((op) => { counts[op] = 0; });
      resps.forEach((r) => { const a = r.answers?.[i]; if (a in counts) counts[a]++; });
      const max = Math.max(...Object.values(counts), 1);
      const bars = q.options.map((op) => {
        const c = counts[op];
        const pct = Math.round((c / resps.length) * 100);
        return `<div class="sv-bar-row">
          <span class="sv-bar-label">${escapeHtml(op)}</span>
          <div class="sv-bar-track"><div class="sv-bar-fill" style="width:${(c / max) * 100}%"></div></div>
          <span class="sv-bar-count">${c}명 (${pct}%)</span>
        </div>`;
      }).join("");
      return `<div class="sv-result-q"><div class="sv-q-title">Q${i + 1}. ${escapeHtml(q.q)}</div>${bars}</div>`;
    }
    const items = resps.map((r) =>
      `<li><b>${r.no ? r.no + "번 " : ""}${escapeHtml(r.name)}</b> — ${escapeHtml(r.answers?.[i] || "")}</li>`).join("");
    return `<div class="sv-result-q"><div class="sv-q-title">Q${i + 1}. ${escapeHtml(q.q)}</div><ul class="sv-text-answers">${items}</ul></div>`;
  }).join("");

  const names = resps.map((r) => `${r.no ? r.no + " " : ""}${escapeHtml(r.name)}`).join(", ");
  return `<div class="sv-form">
    <h3>📊 ${escapeHtml(sv.title)} — 결과 (${resps.length}명 응답)</h3>
    ${qHtml}
    <p class="muted small" style="margin-top:14px;">참여: ${names}</p>
  </div>`;
}

async function exportSurveyExcel(id) {
  const sv = surveys.find((s) => s.id === id);
  if (!sv) return;
  const resps = surveyResponses.filter((r) => r.surveyId === id)
    .sort((a, b) => (a.no || 0) - (b.no || 0));
  if (!resps.length) { toast("아직 응답이 없습니다"); return; }
  try { await ensureXLSX(); } catch (e) { toast(e.message); return; }
  const header = ["번호", "이름", "제출 시각", ...sv.questions.map((q, i) => `Q${i + 1}. ${q.q}`)];
  const rows = resps.map((r) => [
    r.no || "", r.name,
    r.createdAt?.toDate ? r.createdAt.toDate().toLocaleString("ko-KR") : "",
    ...sv.questions.map((_, i) => r.answers?.[i] ?? ""),
  ]);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = header.map((h, i) => ({ wch: i < 2 ? 8 : Math.min(Math.max(h.length * 2, 14), 40) }));
  XLSX.utils.book_append_sheet(wb, ws, "설문 결과");
  XLSX.writeFile(wb, `설문_${sv.title.slice(0, 20)}_${todayStr()}.xlsx`);
  toast("엑셀 파일이 다운로드되었습니다 📥");
}

async function toggleSurveyOpen(id) {
  const sv = surveys.find((s) => s.id === id);
  if (!sv) return;
  sv.open = !sv.open;
  await saveSurveys();
  toast(sv.open ? "설문을 다시 열었습니다" : "설문을 마감했습니다");
}
async function deleteSurvey(id) {
  if (!confirm("이 설문과 모든 응답을 삭제할까요?")) return;
  surveys = surveys.filter((s) => s.id !== id);
  if (activeSurveyId === id) activeSurveyId = null;
  await saveSurveys();
  // 응답도 함께 삭제 (교사 권한)
  const { doc, deleteDoc } = fb.fs;
  const targets = surveyResponses.filter((r) => r.surveyId === id);
  for (const r of targets) {
    try { await deleteDoc(doc(fb.db, "classboard_survey_responses", r.rid)); } catch (e) { console.error(e); }
  }
  toast("삭제되었습니다");
}
async function saveSurveys() {
  const { doc, setDoc } = fb.fs;
  try {
    await setDoc(doc(fb.db, "classboard", "surveys"), {
      items: surveys,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error(e);
    toast("저장 실패 — 교사 로그인 상태를 확인해 주세요", 5000);
  }
}

// ---- 교사: 설문 만들기 모달 ----
function renderSvDraft() {
  $("sv-questions").innerHTML = svDraft.map((q, i) => `
    <div class="sv-q-edit">
      <div class="sv-q-edit-top">
        <b>Q${i + 1}</b>
        <input type="text" data-dq="${i}" value="${escapeHtml(q.q)}" placeholder="질문 내용" maxlength="100" />
        <select data-dt="${i}">
          <option value="choice" ${q.type === "choice" ? "selected" : ""}>객관식</option>
          <option value="text" ${q.type === "text" ? "selected" : ""}>주관식</option>
        </select>
        <button class="btn btn-ghost btn-sm" data-dx="${i}" title="질문 삭제">✕</button>
      </div>
      ${q.type === "choice"
        ? `<input type="text" data-do="${i}" value="${escapeHtml(q.optionsRaw || "")}" placeholder="보기를 쉼표로 구분 (예: 놀이공원, 박물관, 영화관)" />`
        : ""}
    </div>`).join("");
  const box = $("sv-questions");
  box.querySelectorAll("[data-dq]").forEach((el) =>
    el.addEventListener("input", () => { svDraft[el.dataset.dq].q = el.value; }));
  box.querySelectorAll("[data-do]").forEach((el) =>
    el.addEventListener("input", () => { svDraft[el.dataset.do].optionsRaw = el.value; }));
  box.querySelectorAll("[data-dt]").forEach((el) =>
    el.addEventListener("change", () => { svDraft[el.dataset.dt].type = el.value; renderSvDraft(); }));
  box.querySelectorAll("[data-dx]").forEach((el) =>
    el.addEventListener("click", () => { svDraft.splice(el.dataset.dx, 1); renderSvDraft(); }));
}
function openSurveyModal() {
  $("sv-title").value = "";
  svDraft = [{ q: "", type: "choice", optionsRaw: "" }];
  renderSvDraft();
  $("survey-modal").classList.remove("hidden");
  $("sv-title").focus();
}
async function saveSurvey() {
  const title = $("sv-title").value.trim();
  if (!title) { toast("설문 제목을 입력해 주세요"); return; }
  const questions = [];
  for (const [i, d] of svDraft.entries()) {
    const q = d.q.trim();
    if (!q) { toast(`Q${i + 1} 질문 내용을 입력해 주세요`); return; }
    if (d.type === "choice") {
      const options = (d.optionsRaw || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (options.length < 2) { toast(`Q${i + 1} 보기를 2개 이상 입력해 주세요`); return; }
      questions.push({ q, type: "choice", options });
    } else {
      questions.push({ q, type: "text", options: [] });
    }
  }
  if (!questions.length) { toast("질문을 1개 이상 추가해 주세요"); return; }
  const id = `sv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  surveys.push({ id, title, open: true, createdAt: Date.now(), questions });
  activeSurveyId = id;
  await saveSurveys();
  $("survey-modal").classList.add("hidden");
  toast("설문이 시작되었습니다 📊");
}

// ============================================================
//  도구 — 계산기 · 스톱워치 · 타이머 · 디데이
// ============================================================
// ---- 계산기 ----
let calcExpr = "";
function calcPress(key) {
  const disp = $("calc-display");
  if (key === "C") { calcExpr = ""; disp.value = "0"; return; }
  if (key === "back") { calcExpr = calcExpr.slice(0, -1); disp.value = calcExpr || "0"; return; }
  if (key === "=") {
    if (!calcExpr) return;
    try {
      const expr = calcExpr.replace(/%/g, "/100");
      if (!/^[\d+\-*/. ()]+$/.test(expr)) throw new Error("invalid");
      const result = Function(`"use strict"; return (${expr})`)();
      if (!isFinite(result)) throw new Error("infinity");
      calcExpr = String(Math.round(result * 1e10) / 1e10);
      disp.value = calcExpr;
    } catch {
      disp.value = "오류";
      calcExpr = "";
    }
    return;
  }
  // 연산자 연속 입력 방지
  if ("+-*/%".includes(key) && (!calcExpr || "+-*/.".includes(calcExpr.slice(-1)))) {
    if (!(key === "-" && !calcExpr)) return;
  }
  calcExpr += key;
  disp.value = calcExpr.replace(/\*/g, "×").replace(/\//g, "÷");
}

// ---- 스톱워치 ----
let swTimer = null, swStart = 0, swElapsed = 0, swLapCount = 0;
function swFormat(ms) {
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, ds = Math.floor(ms / 100) % 10;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ds}`;
}
function swTick() { $("sw-display").textContent = swFormat(swElapsed + (Date.now() - swStart)); }
function swToggle() {
  if (swTimer) {
    swElapsed += Date.now() - swStart;
    clearInterval(swTimer); swTimer = null;
    $("sw-start").textContent = "▶ 시작";
  } else {
    swStart = Date.now();
    swTimer = setInterval(swTick, 100);
    $("sw-start").textContent = "⏸ 정지";
  }
}
function swLap() {
  if (!swTimer && !swElapsed) return;
  const now = swTimer ? swElapsed + (Date.now() - swStart) : swElapsed;
  swLapCount++;
  $("sw-laps").insertAdjacentHTML("afterbegin",
    `<li><span>랩 ${swLapCount}</span><span>${swFormat(now)}</span></li>`);
}
function swReset() {
  clearInterval(swTimer); swTimer = null;
  swElapsed = 0; swLapCount = 0;
  $("sw-display").textContent = "00:00.0";
  $("sw-start").textContent = "▶ 시작";
  $("sw-laps").innerHTML = "";
}

// ---- 타이머 ----
let tmTimer = null, tmRemain = 0;
function tmFormat(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}
function tmBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((t) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
      osc.start(ctx.currentTime + t); osc.stop(ctx.currentTime + t + 0.22);
    });
  } catch { /* 소리 재생 불가 환경 */ }
}
function tmToggle() {
  if (tmTimer) {   // 일시정지
    clearInterval(tmTimer); tmTimer = null;
    $("timer-start").textContent = "▶ 계속";
    return;
  }
  if (tmRemain <= 0) {
    tmRemain = (Number($("timer-min").value) || 0) * 60 + (Number($("timer-sec").value) || 0);
    if (tmRemain <= 0) { toast("시간을 설정해 주세요"); return; }
  }
  $("timer-display").classList.remove("timeup");
  $("timer-display").textContent = tmFormat(tmRemain);
  $("timer-start").textContent = "⏸ 일시정지";
  tmTimer = setInterval(() => {
    tmRemain--;
    $("timer-display").textContent = tmFormat(Math.max(tmRemain, 0));
    if (tmRemain <= 0) {
      clearInterval(tmTimer); tmTimer = null;
      $("timer-start").textContent = "▶ 시작";
      $("timer-display").classList.add("timeup");
      tmBeep();
      toast("⏲️ 타이머 종료!", 5000);
    }
  }, 1000);
}
function tmReset() {
  clearInterval(tmTimer); tmTimer = null; tmRemain = 0;
  $("timer-display").classList.remove("timeup");
  $("timer-display").textContent = tmFormat((Number($("timer-min").value) || 0) * 60 + (Number($("timer-sec").value) || 0));
  $("timer-start").textContent = "▶ 시작";
}

// ---- 디데이 (이 기기에만 저장) ----
const DDAY_KEY = "classboard.ddays";
function loadDdays() {
  try { return JSON.parse(localStorage.getItem(DDAY_KEY)) || []; } catch { return []; }
}
function renderDdays() {
  const list = loadDdays().sort((a, b) => a.date.localeCompare(b.date));
  $("dday-list").innerHTML = list.length
    ? list.map((d) => {
        const diff = daysDiff(d.date);
        const label = diff === 0 ? "D-Day!" : diff > 0 ? `D-${diff}` : `D+${-diff}`;
        const dt = parseYmd(d.date);
        return `<div class="upcoming-item">
          <span class="upcoming-dday">${label}</span>
          <span>${escapeHtml(d.title)}</span>
          <span class="spacer"></span>
          <span class="upcoming-date">${dt.getFullYear()}.${dt.getMonth() + 1}.${dt.getDate()}</span>
          <button class="btn btn-ghost btn-sm" data-ddel="${d.id}">✕</button>
        </div>`;
      }).join("")
    : `<div class="empty-state">등록된 디데이가 없습니다.<br/>시험, 방학 등 기다리는 날을 추가해 보세요!</div>`;
  $("dday-list").querySelectorAll("[data-ddel]").forEach((b) =>
    b.addEventListener("click", () => {
      localStorage.setItem(DDAY_KEY, JSON.stringify(loadDdays().filter((d) => d.id !== b.dataset.ddel)));
      renderDdays();
    }));
}
function addDday() {
  const title = $("dday-title").value.trim();
  const date = $("dday-date").value;
  if (!title || !date) { toast("이름과 날짜를 입력해 주세요"); return; }
  const list = loadDdays();
  list.push({ id: `dd_${Date.now()}`, title, date });
  localStorage.setItem(DDAY_KEY, JSON.stringify(list));
  $("dday-title").value = "";
  renderDdays();
}

function showTool(name) {
  document.querySelectorAll(".tool-panel").forEach((p) => p.classList.add("hidden"));
  $(`tool-${name}`).classList.remove("hidden");
  document.querySelectorAll(".tool-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tool === name));
  if (name === "dday") renderDdays();
}

// ============================================================
//  익명 우체통
// ============================================================
let secretsUnsub = null;

async function sendSecret() {
  const text = $("secret-text").value.trim();
  if (!text) { toast("내용을 입력해 주세요"); return; }
  if (text.length > 1000) { toast("1,000자 이내로 줄여 주세요"); return; }
  const btn = $("secret-send-btn");
  btn.disabled = true;
  try {
    const { collection, addDoc, serverTimestamp } = fb.fs;
    await addDoc(collection(fb.db, "classboard_messages"), {
      text, createdAt: serverTimestamp(),
    });
    $("secret-text").value = "";
    $("secret-count").textContent = "0 / 1000";
    $("secret-done").classList.remove("hidden");
  } catch (e) {
    console.error(e);
    toast("전송에 실패했습니다. 잠시 후 다시 시도해 주세요.", 5000);
  } finally {
    btn.disabled = false;
  }
}

function subscribeSecrets() {
  if (secretsUnsub) return;
  const { collection, onSnapshot, query, orderBy } = fb.fs;
  const q = query(collection(fb.db, "classboard_messages"), orderBy("createdAt", "desc"));
  secretsUnsub = onSnapshot(q, (snap) => {
    const list = $("secret-list");
    if (snap.empty) {
      list.innerHTML = `<div class="empty-state">아직 받은 메시지가 없습니다.</div>`;
      return;
    }
    list.innerHTML = snap.docs.map((d) => {
      const m = d.data();
      const when = m.createdAt?.toDate
        ? m.createdAt.toDate().toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "";
      return `<div class="secret-msg">${escapeHtml(m.text)}
        <div class="secret-msg-foot">
          <span class="secret-msg-date">💌 ${when}</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm" data-del="${d.id}">삭제</button>
        </div></div>`;
    }).join("");
    list.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("이 메시지를 삭제할까요?")) return;
        const { doc, deleteDoc } = fb.fs;
        await deleteDoc(doc(fb.db, "classboard_messages", b.dataset.del));
      }));
  }, (err) => {
    console.error("메시지 불러오기 실패", err);
    $("secret-list").innerHTML = `<div class="empty-state">⚠️ 메시지를 불러올 수 없습니다. Firestore 규칙을 확인해 주세요.</div>`;
  });
}

// ============================================================
//  시작
// ============================================================
function bindEvents() {
  $("login-btn").addEventListener("click", login);
  $("logout-btn").addEventListener("click", () => fb?.authMod.signOut(fb.auth));

  // 공지
  $("notice-add-btn").addEventListener("click", () => openNoticeModal());
  $("nt-save").addEventListener("click", saveNotice);
  $("nt-cancel").addEventListener("click", () => $("notice-modal").classList.add("hidden"));
  $("nt-delete").addEventListener("click", deleteNotice);
  $("notice-modal").addEventListener("click", (e) => {
    if (e.target === $("notice-modal")) $("notice-modal").classList.add("hidden");
  });

  // 출결
  $("att-prev").addEventListener("click", () => shiftAttDate(-1));
  $("att-next").addEventListener("click", () => shiftAttDate(1));
  $("att-today").addEventListener("click", () => { attDate = todayStr(); renderAttendance(); });
  $("att-date").addEventListener("change", (e) => { if (e.target.value) { attDate = e.target.value; renderAttendance(); } });
  $("att-class").addEventListener("change", renderAttendance);

  // 시간표
  $("tt-grade").addEventListener("change", () => { fillTtClasses(); renderTimetable(); });
  $("tt-class").addEventListener("change", renderTimetable);
  $("tt-week").addEventListener("change", (e) => loadTimetableWeek(e.target.value));

  // 일정
  $("cal-prev").addEventListener("click", () => shiftCalMonth(-1));
  $("cal-next").addEventListener("click", () => shiftCalMonth(1));
  $("cal-today").addEventListener("click", loadCalendar);

  // 학급 일정 (교사 전용)
  $("event-add-btn").addEventListener("click", () => openEventModal());
  $("cal-grid").addEventListener("click", (e) => {
    const chip = e.target.closest(".cal-ev.cls");
    if (chip && isTeacher) openEventModal(chip.dataset.evid);
  });
  $("ev-save").addEventListener("click", saveClassEvent);
  $("ev-cancel").addEventListener("click", () => $("event-modal").classList.add("hidden"));
  $("ev-delete").addEventListener("click", deleteClassEvent);
  $("event-modal").addEventListener("click", (e) => {
    if (e.target === $("event-modal")) $("event-modal").classList.add("hidden");
  });

  // 급식
  $("meal-prev").addEventListener("click", () => { mealWeekOffset--; loadMeals(); });
  $("meal-next").addEventListener("click", () => { mealWeekOffset++; loadMeals(); });
  $("meal-today").addEventListener("click", () => { mealWeekOffset = 0; loadMeals(); });

  // 명렬표
  $("roster-edit-btn").addEventListener("click", openRosterModal);
  $("roster-file").addEventListener("change", (e) => {
    if (e.target.files?.[0]) importRosterFile(e.target.files[0]);
  });
  $("roster-save").addEventListener("click", saveRoster);
  $("roster-cancel").addEventListener("click", () => $("roster-modal").classList.add("hidden"));
  $("roster-modal").addEventListener("click", (e) => {
    if (e.target === $("roster-modal")) $("roster-modal").classList.add("hidden");
  });
  $("check-add-btn").addEventListener("click", () => openChecklistModal());
  $("ci-save").addEventListener("click", saveChecklistItem);
  $("ci-cancel").addEventListener("click", () => $("checkitem-modal").classList.add("hidden"));
  $("ci-delete").addEventListener("click", deleteChecklistItem);
  $("checkitem-modal").addEventListener("click", (e) => {
    if (e.target === $("checkitem-modal")) $("checkitem-modal").classList.add("hidden");
  });

  // 설문조사
  $("survey-add-btn").addEventListener("click", openSurveyModal);
  $("sv-add-q").addEventListener("click", () => {
    svDraft.push({ q: "", type: "choice", optionsRaw: "" });
    renderSvDraft();
  });
  $("sv-save").addEventListener("click", saveSurvey);
  $("sv-cancel").addEventListener("click", () => $("survey-modal").classList.add("hidden"));
  $("survey-modal").addEventListener("click", (e) => {
    if (e.target === $("survey-modal")) $("survey-modal").classList.add("hidden");
  });

  // 도구
  document.querySelectorAll(".tool-tab").forEach((t) =>
    t.addEventListener("click", () => showTool(t.dataset.tool)));
  document.querySelectorAll(".calc-btn").forEach((b) =>
    b.addEventListener("click", () => calcPress(b.dataset.key)));
  $("sw-start").addEventListener("click", swToggle);
  $("sw-lap").addEventListener("click", swLap);
  $("sw-reset").addEventListener("click", swReset);
  $("timer-start").addEventListener("click", tmToggle);
  $("timer-reset").addEventListener("click", tmReset);
  $("timer-min").addEventListener("change", () => { if (!tmTimer) tmReset(); });
  $("timer-sec").addEventListener("change", () => { if (!tmTimer) tmReset(); });
  $("dday-add").addEventListener("click", addDday);
  $("dday-title").addEventListener("keydown", (e) => { if (e.key === "Enter") addDday(); });

  // 익명 우체통
  $("secret-text").addEventListener("input", (e) => {
    $("secret-count").textContent = `${e.target.value.length} / 1000`;
    $("secret-done").classList.add("hidden");
  });
  $("secret-send-btn").addEventListener("click", sendSecret);
  $("secret-again-btn").addEventListener("click", () => {
    $("secret-done").classList.add("hidden");
    $("secret-text").focus();
  });
}

async function main() {
  $("brand-name").textContent = "학급 게시판";
  $("mail-link").href = `mailto:${TEACHER_EMAIL}`;
  $("mail-text").textContent = TEACHER_EMAIL;
  initTheme();
  initTabs();
  bindEvents();
  await loadCalendarData();   // 출결 화면의 휴일 표시에도 사용
  renderAttendance();
  try {
    await initFirebase();
  } catch (e) {
    console.error("Firebase 초기화 실패", e);
    toast("서버 연결에 실패했습니다", 5000);
  }
}
main();

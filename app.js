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
    if (isTeacher) subscribeSecrets();
    else if (secretsUnsub) { secretsUnsub(); secretsUnsub = null; }
  });

  subscribeNotices();
  subscribeAttendance();
  subscribeClassEvents();
  subscribeRoster();
}

function updateTeacherUI() {
  $("teacher-badge").classList.toggle("hidden", !isTeacher);
  $("login-btn").classList.toggle("hidden", isTeacher);
  $("logout-btn").classList.toggle("hidden", !isTeacher);
  $("notice-add-btn").classList.toggle("hidden", !isTeacher);
  $("event-add-btn").classList.toggle("hidden", !isTeacher);
  $("roster-edit-btn").classList.toggle("hidden", !isTeacher);
  $("check-add-btn").classList.toggle("hidden", !isTeacher);
  $("secret-teacher").classList.toggle("hidden", !isTeacher);
  $("secret-student").classList.toggle("hidden", isTeacher);
  renderNotices();
  renderRoster();
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
    <table class="att-table">
      <thead><tr><th>번호</th><th>이름</th><th>구분</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
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
  $("roster-modal").classList.remove("hidden");
  $("roster-text").focus();
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

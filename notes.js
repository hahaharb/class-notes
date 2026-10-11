/* 수업 필기 탭. 서버 없이 이 파일만으로 동작한다.
   저장은 항상 브라우저(IndexedDB)에 먼저 하고, 서버 동기화(sync.js)가 있으면 그쪽에서 이어서 올린다. */

const $ = id => document.getElementById(id);
pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const COLORS = {1: "#FFE066", 2: "#8FE3B0", 3: "#9CC6FF"};
const SUBJECTS = ["약리학", "병리학", "고정성치과보철학", "치주과학", "치과재료학",
                  "생화학", "미생물학", "구강진단과연조직질환", "치과용CAD/CAM", "예방치과학"];

let pdfDoc = null, page = 1, pageCount = 0, color = 1, rectMode = false, renderToken = 0;
let session = null;        // 지금 열려 있는 강의: {id, subject, lecture, pdfName, slideCount, startedAt, t0, lastPage, slides:{n:{note,highlights,viewed,updated}}, updatedAt}
let currentEnter = null;   // 현재 슬라이드를 보기 시작한 시각(수업 시작 후 초)
let pendingPdfFor = null;  // 파일 선택창이 어떤 목적으로 열렸는지 ("new" | "reopen")
let dialogPdf = null;      // 새 강의 대화상자에서 고른 PDF 파일

/* ================= 저장소 (IndexedDB) ================= */
let dbPromise = null;
function idb() {
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open("classnotes", 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");           // 1단계 프로토타입 호환
      if (!d.objectStoreNames.contains("lectures")) d.createObjectStore("lectures"); // 강의별 필기
      if (!d.objectStoreNames.contains("pdfs")) d.createObjectStore("pdfs");         // 강의별 슬라이드 PDF
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbPromise;
}
async function dbPut(store, key, val) {
  try {
    const d = await idb();
    await new Promise((res, rej) => {
      const t = d.transaction(store, "readwrite");
      t.objectStore(store).put(val, key);
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
    return true;
  } catch (e) { return false; }
}
async function dbGet(store, key) {
  try {
    const d = await idb();
    return await new Promise((res, rej) => {
      const q = d.transaction(store, "readonly").objectStore(store).get(key);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  } catch (e) { return undefined; }
}
async function dbAll(store) {
  try {
    const d = await idb();
    return await new Promise((res, rej) => {
      const q = d.transaction(store, "readonly").objectStore(store).getAll();
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  } catch (e) { return []; }
}
async function dbDelete(store, key) {
  try {
    const d = await idb();
    await new Promise((res, rej) => {
      const t = d.transaction(store, "readwrite");
      t.objectStore(store).delete(key);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  } catch (e) { /* 무시 */ }
}

/* ================= 저장 상태 · 자동 저장 ================= */
let saveTimer = null;
function setStatus(txt, cls) { const s = $("status"); s.textContent = txt; s.className = "status " + (cls || ""); }
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1800);
}
function touch(n) {
  const now = Date.now();
  session.updatedAt = now;
  if (n) slideData(n).updated = now;
}
function scheduleSave() {
  setStatus("저장 중", "saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!session) return;
  const ok = await dbPut("lectures", session.id, session);
  setStatus(ok ? "저장됨" : "저장 실패", ok ? "saved" : "error");
  if (ok && window.notesSync) window.notesSync.push(session);   // 서버 동기화(있을 때만)
}

/* ================= 세션 · 시간 ================= */
function sanitize(s) { return s.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " "); }
function blankSession(subject, lecture, name, count) {
  return {
    id: subject + "/" + lecture, subject, lecture, pdfName: name, slideCount: count,
    startedAt: localIso(new Date()), t0: Date.now(), lastPage: 1, slides: {}, updatedAt: Date.now(),
  };
}
function slideData(n) {
  if (!session.slides[n]) session.slides[n] = {note: "", highlights: [], viewed: [], updated: 0};
  return session.slides[n];
}
function localIso(d) {   // 2026-09-23T10:00:00 (내 시계 기준, 시간대 표시 없음)
  const p = x => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function elapsed() { return Math.max(0, Math.round((Date.now() - session.t0) / 1000)); }
function mmss(sec) {   // 녹음 스크립트와 같은 형식: 05:19
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
function markEnter() { currentEnter = elapsed(); }
function markLeave(n) {
  if (currentEnter === null || !session) return;
  const end = elapsed();
  if (end - currentEnter >= 3) { slideData(n).viewed.push({start: mmss(currentEnter), end: mmss(end)}); touch(n); }
  currentEnter = null;
}

/* ================= 화면 전환 · 강의 목록 ================= */
function showList() { $("view-list").hidden = false; $("view-note").hidden = true; }
function showNote() { $("view-list").hidden = true; $("view-note").hidden = false; }

async function renderList() {
  const lectures = (await dbAll("lectures")).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const box = $("lecList");
  if (!lectures.length) {
    box.innerHTML = '<div class="lec empty-msg">아직 강의가 없어요. “새 강의 필기”로 시작하세요.</div>';
    return;
  }
  box.innerHTML = "";
  for (const s of lectures) {
    const notes = Object.values(s.slides || {}).filter(d => d.note || (d.highlights || []).length).length;
    const row = document.createElement("div"); row.className = "lec";
    row.innerHTML = '<div class="info"><div class="name"></div><div class="meta"></div></div>' +
      '<button class="btn primary" data-act="open">열기</button>' +
      '<button class="btn danger" data-act="del">삭제</button>';
    row.querySelector(".name").textContent = s.subject + " · " + s.lecture;
    row.querySelector(".meta").textContent = "슬라이드 " + (s.slideCount || "?") + "장 · 필기 있는 슬라이드 " + notes +
      "장 · " + new Date(s.updatedAt || 0).toLocaleString("ko-KR", {month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"});
    row.querySelector('[data-act="open"]').onclick = () => openLecture(s.id);
    row.querySelector('[data-act="del"]').onclick = () => {
      showSheet('<h3>삭제할까요?</h3><p style="font-size:14px">' + esc(s.subject + " · " + s.lecture) +
        '의 필기와 PDF가 이 기기에서 지워져요. 내보내기를 안 했다면 되돌릴 수 없어요.</p>' +
        '<div class="row"><button class="btn danger" id="okDel">삭제</button><button class="btn" id="closeBtn">취소</button></div>',
        () => { $("okDel").onclick = async () => {
          await dbDelete("lectures", s.id); await dbDelete("pdfs", s.id);
          document.querySelector(".sheet").remove(); renderList(); } });
    };
    box.appendChild(row);
  }
}
function esc(s) { return String(s).replace(/[<>&"]/g, c => ({"<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;"}[c])); }

function newLectureDialog() {
  showSheet('<h3>새 강의 필기</h3>' +
    '<div class="field"><label>과목</label><input id="nSubject" list="subjList" placeholder="예: 약리학" autocomplete="off"></div>' +
    '<datalist id="subjList"></datalist>' +
    '<div class="field"><label>강의 이름</label><input id="nLecture" placeholder="예: 28장 이뇨제2" autocomplete="off"></div>' +
    '<div class="field"><label>슬라이드 PDF</label><button class="btn" id="nPick">PDF 고르기</button><span id="nPicked" style="font-size:13px;color:var(--muted)"></span></div>' +
    '<div class="row"><button class="btn primary" id="nGo">시작</button><button class="btn" id="closeBtn">취소</button></div>' +
    '<div id="srvBox" hidden style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px">' +
    '<div style="font-size:13px;color:var(--muted);margin-bottom:6px">또는 노트북 서버에 이미 올라간 강의에서 고르기</div><div id="srvList"></div></div>',
    async () => {
      if (window.notesSync) window.notesSync.fillList($("srvBox"), $("srvList"), pickServerLecture);
      const known = new Set(SUBJECTS);
      (await dbAll("lectures")).forEach(l => known.add(l.subject));
      $("subjList").innerHTML = [...known].map(s => '<option value="' + esc(s) + '">').join("");
      dialogPdf = null;
      $("nPick").onclick = () => { pendingPdfFor = "dialog"; $("file").click(); };
      $("nGo").onclick = async () => {
        const chosen = dialogPdf;
        const subject = sanitize($("nSubject").value), lecture = sanitize($("nLecture").value);
        if (!subject || !lecture) { toast("과목과 강의 이름을 적어 주세요"); return; }
        if (!chosen) { toast("슬라이드 PDF를 골라 주세요"); return; }
        if (await dbGet("lectures", subject + "/" + lecture)) { toast("같은 이름의 강의가 이미 있어요"); return; }
        document.querySelector(".sheet").remove();
        setStatus("여는 중", "saving"); showNote();
        const bytes = new Uint8Array(await chosen.arrayBuffer());
        await startNew(subject, lecture, chosen.name, bytes);
      };
    });
}

async function pickServerLecture(item) {
  const id = item.subject + "/" + item.lecture;
  if (await dbGet("lectures", id)) { document.querySelector(".sheet").remove(); openLecture(id); return; }
  toast("서버에서 PDF를 받는 중…");
  const bytes = await window.notesSync.fetchPdf(item.subject, item.lecture);
  if (!bytes) { toast("PDF를 받지 못했어요"); return; }
  document.querySelector(".sheet").remove();
  setStatus("여는 중", "saving"); showNote();
  await startNew(item.subject, item.lecture, item.pdf_name || "slides.pdf", bytes);
  session.pdfUploaded = true;           // 서버에 이미 있는 PDF라 다시 올릴 필요 없음
  window.notesSync.pull(session);
}

/* ================= 강의 열기 ================= */
async function startNew(subject, lecture, name, bytes) {
  const doc = await pdfjsLib.getDocument({data: bytes.slice(0)}).promise;
  session = blankSession(subject, lecture, name, doc.numPages);
  await dbPut("pdfs", session.id, bytes);
  await dbPut("lectures", session.id, session);
  await attachPdf(doc);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
async function openLecture(id) {
  const s = await dbGet("lectures", id);
  if (!s) { toast("강의를 찾지 못했어요"); return; }
  session = s; if (!session.t0) session.t0 = Date.now();
  showNote();
  const bytes = await dbGet("pdfs", id);
  if (!bytes) { await noPdfState(); return; }
  try { await attachPdf(await pdfjsLib.getDocument({data: bytes.slice(0)}).promise); }
  catch (e) { await noPdfState(); return; }
  if (window.notesSync) window.notesSync.pull(session);   // 다른 기기에서 쓴 필기가 서버에 있으면 합친다
}
async function noPdfState() {
  pdfDoc = null; $("title").textContent = session.subject + " · " + session.lecture;
  $("slidebox").hidden = true; $("empty").hidden = false; $("thumbs").innerHTML = "";
  setStatus("PDF 필요", "saving");
}
async function reopenWith(f) {
  document.querySelector(".sheet") && document.querySelector(".sheet").remove();
  const bytes = new Uint8Array(await f.arrayBuffer());
  const doc = await pdfjsLib.getDocument({data: bytes.slice(0)}).promise;
  session.slideCount = doc.numPages; session.pdfName = f.name;
  await dbPut("pdfs", session.id, bytes);
  await attachPdf(doc); scheduleSave();
}
async function attachPdf(doc) {
  pdfDoc = doc; pageCount = doc.numPages;
  $("title").textContent = session.subject + " · " + session.lecture;
  $("empty").hidden = true; $("slidebox").hidden = false;
  page = Math.min(pageCount, Math.max(1, session.lastPage || 1));
  markEnter(); buildThumbs();
  await render();
  setStatus("저장됨", "saved");
}
async function closeLecture() {
  if (session) { markLeave(page); await flushSave(); }
  session = null; pdfDoc = null; currentEnter = null;
  showList(); renderList();
}

/* ================= 슬라이드 그리기 ================= */
async function render() {
  const token = ++renderToken;
  const pg = await pdfDoc.getPage(page);
  const box = $("slidebox"), canvas = $("canvas"), ctx = canvas.getContext("2d");
  const avail = Math.max(240, $("stage").clientWidth - 24);
  const base = pg.getViewport({scale: 1});
  const scale = Math.min(avail / base.width, (($("stage").clientHeight - 24) / base.height) || 99);
  const viewport = pg.getViewport({scale: scale});
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  box.style.width = Math.floor(viewport.width) + "px";
  box.style.height = Math.floor(viewport.height) + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  await pg.render({canvasContext: ctx, viewport: viewport}).promise;
  if (token !== renderToken) return;

  // 텍스트 레이어: 워드처럼 문장을 드래그해 선택할 수 있게 투명한 글자를 얹는다
  const layer = $("textLayer"); layer.innerHTML = "";
  const tc = await pg.getTextContent();
  if (token !== renderToken) return;
  const frag = document.createDocumentFragment(), spans = [];
  tc.items.forEach(item => {
    if (!item.str || !item.str.trim()) return;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const h = Math.hypot(tx[2], tx[3]); if (!h) return;
    const s = document.createElement("span");
    s.textContent = item.str;
    s.style.left = tx[4] + "px"; s.style.top = (tx[5] - h) + "px";
    s.style.fontSize = h + "px"; s.style.fontFamily = "sans-serif";
    frag.appendChild(s); spans.push({el: s, w: item.width * scale});
  });
  layer.appendChild(frag);
  spans.forEach(o => {
    const w = o.el.getBoundingClientRect().width;
    if (w > 0 && o.w > 0) o.el.style.transform = "scaleX(" + (o.w / w) + ")";
  });

  drawHighlights();
  $("num").textContent = page + " / " + pageCount;
  $("noteLabel").textContent = "슬라이드 " + page + " 필기";
  $("note").value = slideData(page).note || "";
  renderHlList(); updateThumbs();
}
function drawHighlights() {
  const layer = $("hlLayer"); layer.innerHTML = "";
  const box = $("slidebox"), W = box.clientWidth, H = box.clientHeight;
  slideData(page).highlights.forEach(h => h.rects.forEach(r => {
    const d = document.createElement("div"); d.className = "hl";
    d.style.left = (r.x * W) + "px"; d.style.top = (r.y * H) + "px";
    d.style.width = (r.w * W) + "px"; d.style.height = (r.h * H) + "px";
    d.style.background = COLORS[h.color] || COLORS[1];
    layer.appendChild(d);
  }));
}
function renderHlList() {
  const list = $("hllist"), hs = slideData(page).highlights.filter(h => h.text);
  if (!hs.length) { list.hidden = true; list.innerHTML = ""; return; }
  list.hidden = false;
  list.innerHTML = "<h4>형광펜</h4>" + hs.map(h =>
    '<div style="border-left-color:' + (COLORS[h.color] || COLORS[1]) + '">' + esc(h.text) + "</div>").join("");
}

/* ---------- 썸네일 줄 ---------- */
let thumbObserver = null, thumbQueue = Promise.resolve();
function buildThumbs() {
  const strip = $("thumbs"); strip.innerHTML = "";
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(entries => entries.forEach(en => {
    if (en.isIntersecting) { thumbObserver.unobserve(en.target); drawThumb(en.target); }
  }), {root: strip, rootMargin: "300px"});
  const doc = pdfDoc;
  for (let n = 1; n <= pageCount; n++) {
    const b = document.createElement("button");
    b.className = "thumb"; b.dataset.n = n;
    b.innerHTML = '<canvas></canvas><span class="tn">' + n + '</span><span class="dot"></span>';
    b.onclick = () => go(n);
    strip.appendChild(b); thumbObserver.observe(b);
  }
  strip._doc = doc;
}
function drawThumb(el) {
  const doc = pdfDoc, n = +el.dataset.n;
  thumbQueue = thumbQueue.then(async () => {
    if (doc !== pdfDoc) return;
    try {
      const pg = await doc.getPage(n), v0 = pg.getViewport({scale: 1}), sc = 160 / v0.width, v = pg.getViewport({scale: sc});
      const c = el.querySelector("canvas"); c.width = Math.floor(v.width); c.height = Math.floor(v.height);
      await pg.render({canvasContext: c.getContext("2d"), viewport: v}).promise;
    } catch (e) { /* 썸네일 실패는 무시 */ }
  });
}
function updateThumbs() {
  document.querySelectorAll(".thumb").forEach(el => {
    const n = +el.dataset.n, d = session.slides[n];
    el.classList.toggle("active", n === page);
    el.classList.toggle("has", !!(d && (d.note || (d.highlights || []).length)));
  });
  const a = document.querySelector(".thumb.active");
  if (a) a.scrollIntoView({block: "nearest", inline: "center"});
}

/* ================= 형광펜 ================= */
function applyHighlight() {
  if (!pdfDoc) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { toast("먼저 슬라이드에서 글자를 드래그하세요"); return; }
  const box = $("slidebox").getBoundingClientRect();
  const rects = [...sel.getRangeAt(0).getClientRects()]
    .filter(r => r.width > 1 && r.height > 1)
    .map(r => ({x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height}))
    .filter(r => r.x >= -0.05 && r.x <= 1.05 && r.y >= -0.05 && r.y <= 1.05);
  if (!rects.length) { toast("슬라이드 안에서 선택해 주세요"); return; }
  slideData(page).highlights.push({text: sel.toString().replace(/\s+/g, " ").trim(), color: color, rects: rects});
  sel.removeAllRanges();
  touch(page); drawHighlights(); renderHlList(); updateThumbs(); scheduleSave();
}
function undoHighlight() {
  if (!pdfDoc) return;
  const hs = slideData(page).highlights;
  if (!hs.length) { toast("되돌릴 형광펜이 없어요"); return; }
  hs.pop(); touch(page); drawHighlights(); renderHlList(); updateThumbs(); scheduleSave();
}
/* 영역 표시: 그림처럼 글자가 없는 슬라이드용 */
(function rectDrag() {
  const box = $("slidebox"); let start = null, ghost = null;
  const rel = e => { const r = box.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top, r}; };
  box.addEventListener("pointerdown", e => {
    if (!rectMode || !pdfDoc) return;
    const p = rel(e); start = {x: p.x, y: p.y};
    ghost = document.createElement("div"); ghost.className = "dragbox"; box.appendChild(ghost);
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener("pointermove", e => {
    if (!start) return;
    const p = rel(e);
    Object.assign(ghost.style, {left: Math.min(start.x, p.x) + "px", top: Math.min(start.y, p.y) + "px",
      width: Math.abs(p.x - start.x) + "px", height: Math.abs(p.y - start.y) + "px"});
  });
  box.addEventListener("pointerup", e => {
    if (!start) return;
    const p = rel(e), x = Math.min(start.x, p.x), y = Math.min(start.y, p.y);
    const w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
    ghost.remove(); ghost = null; start = null;
    if (w > 6 && h > 6) {
      slideData(page).highlights.push({text: "", color: color, rects: [{x: x / p.r.width, y: y / p.r.height, w: w / p.r.width, h: h / p.r.height}]});
      touch(page); drawHighlights(); updateThumbs(); scheduleSave();
    }
  });
})();

/* ================= 이동 ================= */
async function go(n) {
  if (!pdfDoc) return;
  n = Math.min(pageCount, Math.max(1, n));
  if (n === page) return;
  markLeave(page); page = n; session.lastPage = n; markEnter();
  await render(); scheduleSave();
}
function setColor(c) {
  color = c;
  document.querySelectorAll(".swatch").forEach(x => x.setAttribute("aria-pressed", String(+x.dataset.color === color)));
}

/* ================= 단축키 (설정에서 바꿀 수 있음) ================= */
const ACTIONS = {
  prev:      {label: "이전 슬라이드", run: () => go(page - 1), def: ["Alt+ArrowLeft", "Ctrl+ArrowLeft", "PageUp"]},
  next:      {label: "다음 슬라이드", run: () => go(page + 1), def: ["Alt+ArrowRight", "Ctrl+ArrowRight", "PageDown"]},
  highlight: {label: "선택한 글자에 형광펜", run: applyHighlight, def: ["h"]},
  color1:    {label: "형광펜 노랑", run: () => setColor(1), def: ["1"]},
  color2:    {label: "형광펜 초록", run: () => setColor(2), def: ["2"]},
  color3:    {label: "형광펜 파랑", run: () => setColor(3), def: ["3"]},
};
let keymap = {};
function loadKeys() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("notes.keys") || "{}"); } catch (e) { /* 저장소를 못 쓰면 기본값 */ }
  const all = {};
  for (const [k, a] of Object.entries(ACTIONS)) all[k] = saved[k] && saved[k].length ? saved[k] : a.def;
  keymap = {};
  for (const [k, combos] of Object.entries(all)) combos.forEach(c => keymap[c] = k);
  return all;
}
function saveKeys(all) { try { localStorage.setItem("notes.keys", JSON.stringify(all)); } catch (e) { /* 무시 */ } loadKeys(); }
function comboOf(e) {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(k)) return null;
  return (e.ctrlKey ? "Ctrl+" : "") + (e.altKey ? "Alt+" : "") + (e.metaKey ? "Meta+" : "") + (e.shiftKey ? "Shift+" : "") + k;
}
function prettyCombo(c) { return c.replace("ArrowLeft", "←").replace("ArrowRight", "→").replace("Meta", "Cmd"); }

let listening = null;   // 단축키 바꾸는 중이면 그 동작 이름
document.addEventListener("keydown", e => {
  if (listening) {
    e.preventDefault(); e.stopPropagation();
    if (e.key === "Escape") { listening.cancel(); return; }
    const c = comboOf(e); if (c) listening.set(c);
    return;
  }
  if (!session || $("view-note").hidden) return;
  const typing = ["TEXTAREA", "INPUT"].includes(document.activeElement && document.activeElement.tagName);
  const hasMod = e.ctrlKey || e.altKey || e.metaKey;
  // Ctrl/Cmd+Z: 글자를 쓰는 중이면 글자 되돌리기(브라우저 기본), 아니면 형광펜 되돌리기
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
    if (!typing) { e.preventDefault(); undoHighlight(); }
    return;
  }
  const c = comboOf(e), action = c && keymap[c];
  if (!action) return;
  if (typing && !hasMod) return;     // 글자 입력 중에는 H, 1, 2, 3이 그냥 글자로 입력돼야 한다
  e.preventDefault(); ACTIONS[action].run();
}, true);
document.addEventListener("keydown", e => {   // 화살표만으로도 이동 (글자 입력 중이 아닐 때)
  if (!session || $("view-note").hidden || listening) return;
  if (["TEXTAREA", "INPUT"].includes(document.activeElement && document.activeElement.tagName)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === "ArrowRight") go(page + 1);
  if (e.key === "ArrowLeft") go(page - 1);
});

function settingsSheet() {
  const all = loadKeys();
  const rows = Object.entries(ACTIONS).map(([k, a]) =>
    '<tr><td>' + a.label + '</td><td data-k="' + k + '"></td><td><button class="btn" data-set="' + k + '">바꾸기</button></td></tr>').join("");
  showSheet('<h3>단축키</h3><table>' + rows + '</table>' +
    '<p style="font-size:13.5px;color:var(--muted)">“바꾸기”를 누르고 원하는 키(조합)를 누르세요. Esc로 취소. ' +
    '사파리에서 Cmd+← →는 뒤로가기라서 슬라이드 이동은 Option(Alt)을 기본으로 했어요. ' +
    '글자를 쓰는 중에는 Option/Ctrl을 함께 누르는 조합만 동작해요.</p>' +
    '<p style="font-size:13.5px;color:var(--muted)">Ctrl/Cmd+Z: 필기 칸에서는 글자 되돌리기, 슬라이드를 만지고 있을 때는 형광펜 되돌리기.<br>' +
    '영역 버튼: 그림 슬라이드에 사각형으로 표시.</p>' +
    '<div class="row"><button class="btn" id="resetKeys">기본값으로</button><button class="btn" id="closeBtn">닫기</button></div>',
    () => {
      const paint = () => Object.keys(ACTIONS).forEach(k => {
        const td = document.querySelector('td[data-k="' + k + '"]');
        td.innerHTML = all[k].map(c => '<span class="keycap">' + esc(prettyCombo(c)) + "</span>").join("");
      });
      paint();
      document.querySelectorAll("[data-set]").forEach(btn => btn.onclick = () => {
        const k = btn.dataset.set, td = document.querySelector('td[data-k="' + k + '"]');
        td.innerHTML = '<span class="keycap listening">키를 누르세요…</span>';
        listening = {
          set: c => { all[k] = [c]; saveKeys(all); listening = null; paint(); },
          cancel: () => { listening = null; paint(); },
        };
      });
      $("resetKeys").onclick = () => { try { localStorage.removeItem("notes.keys"); } catch (e) { /* 무시 */ } Object.assign(all, loadKeys()); paint(); };
    });
}

/* ================= 내보내기 ================= */
function bbox(rects) {
  const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y));
  const x1 = Math.max(...rects.map(r => r.x + r.w)), y1 = Math.max(...rects.map(r => r.y + r.h));
  const r4 = v => Math.round(v * 10000) / 10000;
  return {x: r4(x0), y: r4(y0), w: r4(x1 - x0), h: r4(y1 - y0)};
}
/* 저장 형식(live-notes.json). forSync=true면 지워서 비운 슬라이드도 포함한다(서버의 옛 필기를 덮어써야 하므로). */
function exportDoc(s, forSync) {
  const slides = Object.keys(s.slides).map(Number).sort((a, b) => a - b).map(n => {
    const d = s.slides[n];
    return {
      n, note: d.note || "", updated: d.updated || 0,
      highlights: d.highlights.map(h => ({...bbox(h.rects), color: h.color, text: h.text, rects: h.rects})),
      viewed: d.viewed,
    };
  }).filter(x => forSync ? x.updated > 0 : (x.note || x.highlights.length || x.viewed.length));
  return {
    subject: s.subject, lecture: s.lecture, pdf: s.pdfName, slide_count: s.slideCount,
    started_at: s.startedAt, exported_at: localIso(new Date()), slides,
  };
}
function buildExport() {
  markLeave(page); markEnter();
  return JSON.stringify(exportDoc(session, false), null, 2);
}
/* 서버에서 받은 필기를 합친다: 슬라이드마다 더 최근에 고친 쪽이 이긴다. 바뀐 게 있으면 true */
function applyRemote(s, doc) {
  let changed = false;
  (doc.slides || []).forEach(r => {
    const cur = s.slides[r.n];
    if (cur && (cur.updated || 0) >= (r.updated || 0)) return;
    s.slides[r.n] = {
      note: r.note || "", updated: r.updated || 0, viewed: r.viewed || [],
      highlights: (r.highlights || []).map(h => ({
        text: h.text || "", color: h.color || 1,
        rects: h.rects && h.rects.length ? h.rects : [{x: h.x, y: h.y, w: h.w, h: h.h}],
      })),
    };
    changed = true;
  });
  return changed;
}
function exportNotes() {
  if (!session) return;
  const json = buildExport();
  const name = "live-notes_" + sanitize(session.subject + "_" + session.lecture).replace(/ /g, "_") + ".json";
  showSheet('<h3>내보내기</h3><p style="font-size:14px;color:var(--muted);margin:0 0 8px">' +
    '파일 <b>' + esc(name) + '</b>을(를) 저장하세요. 노트북에서는 이 파일을 <b>live-notes.json</b>으로 해당 강의 폴더에 넣으면 돼요.</p>' +
    '<textarea id="expText" readonly></textarea>' +
    '<div class="row"><button class="btn primary" id="saveBtn">파일로 저장</button><button class="btn" id="copyBtn">복사</button>' +
    '<button class="btn" id="closeBtn">닫기</button></div>',
    () => {
      $("expText").value = json;
      $("saveBtn").onclick = () => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([json], {type: "application/json"}));
        a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast("저장했어요");
      };
      $("copyBtn").onclick = async () => {
        try { await navigator.clipboard.writeText(json); toast("복사했어요"); }
        catch (e) { $("expText").select(); toast("길게 눌러 복사하세요"); }
      };
    });
}

function showSheet(html, after) {
  const wrap = document.createElement("div"); wrap.className = "sheet";
  wrap.innerHTML = '<div class="card">' + html + "</div>";
  wrap.addEventListener("click", e => { if (e.target === wrap || e.target.id === "closeBtn") wrap.remove(); });
  document.body.appendChild(wrap); if (after) after();
}

/* ================= 이벤트 연결 ================= */
$("btn-new").onclick = newLectureDialog;
$("btn-back").onclick = closeLecture;
$("btn-reopen").onclick = () => { pendingPdfFor = "reopen"; $("file").click(); };
$("file").onchange = e => {   // 파일 선택창은 하나를 두 용도로 쓴다: 새 강의 대화상자 / PDF 다시 열기
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  if (pendingPdfFor === "reopen") { reopenWith(f); return; }
  dialogPdf = f;
  const label = $("nPicked"), lec = $("nLecture");
  if (label) label.textContent = " " + f.name;
  if (lec && !lec.value) lec.value = sanitize(f.name.replace(/\.pdf$/i, ""));
};
$("note").addEventListener("input", () => { slideData(page).note = $("note").value; touch(page); updateThumbs(); scheduleSave(); });
$("prev").onclick = () => go(page - 1);
$("next").onclick = () => go(page + 1);
$("btn-hl").onclick = applyHighlight;
$("btn-undo").onclick = undoHighlight;
$("btn-help").onclick = settingsSheet;
$("btn-export").onclick = exportNotes;
$("btn-rect").onclick = () => {
  rectMode = !rectMode;
  $("btn-rect").classList.toggle("on", rectMode);
  document.body.classList.toggle("rect-mode", rectMode);
  toast(rectMode ? "영역 표시 모드" : "텍스트 선택 모드");
};
document.querySelectorAll(".swatch").forEach(b => b.onclick = () => setColor(+b.dataset.color));
$("btn-zero").onclick = () => {
  if (!session) return;
  const hasViewed = Object.values(session.slides).some(d => d.viewed.length);
  const apply = () => {
    Object.values(session.slides).forEach(d => d.viewed = []);
    session.t0 = Date.now(); session.startedAt = localIso(new Date()); currentEnter = 0;
    touch(); scheduleSave(); toast("지금을 00:00으로 맞췄어요");
  };
  if (!hasViewed) { apply(); return; }
  showSheet('<h3>시작 시각을 다시 맞출까요?</h3><p style="font-size:14px">지금까지의 슬라이드 보기 기록이 지워져요.</p>' +
    '<div class="row"><button class="btn primary" id="okZero">맞추기</button><button class="btn" id="closeBtn">취소</button></div>',
    () => { $("okZero").onclick = () => { document.querySelector(".sheet").remove(); apply(); }; });
};
let rt;
window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (pdfDoc && session) render(); }, 200); });
setInterval(() => { if (session && !$("view-note").hidden) $("clock").textContent = mmss(elapsed()); }, 1000);

// 화면이 꺼지거나 앱을 벗어나면 보던 시간 기록을 끊고 저장한다
document.addEventListener("visibilitychange", () => {
  if (!session || !pdfDoc) return;
  if (document.visibilityState === "hidden") { markLeave(page); flushSave(); }
  else markEnter();
});
window.addEventListener("pagehide", () => { if (session) { markLeave(page); dbPut("lectures", session.id, session); } });

/* ================= 시작 ================= */
loadKeys();
renderList();
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* 오프라인 캐시 없이도 동작 */ });
}

/* 노트북 서버 동기화 (선택 기능). 서버가 없어도 notes.js는 그대로 동작한다.
   - 필기는 항상 브라우저에 먼저 저장된다. 여기서는 "서버에 아직 안 올라간 강의"를 찾아 올린다.
   - 올리다 실패하면 15초마다 다시 시도하고, 다음에 접속했을 때도 밀린 것을 올린다.
   서버 주소: 이 페이지를 서버(python server/app.py)에서 열었으면 자동. 아니면(예: 정적 호스팅) 목록 화면에서 직접 입력. */
(function () {
  const KEY = "notes.server";
  const RETRY_MS = 15000, DEBOUNCE_MS = 2000;
  let state = "off";            // off: 서버 없음 | ok: 연결됨 | syncing: 올리는 중 | offline: 연결 끊김
  let pending = new Set();      // 서버에 올려야 하는 강의 id
  let timer = null, busy = false;

  /* ---------- 주소 ---------- */
  function getBase() { try { return (localStorage.getItem(KEY) || "").replace(/\/+$/, ""); } catch (e) { return ""; } }
  function setBase(v) { try { v ? localStorage.setItem(KEY, v.trim()) : localStorage.removeItem(KEY); } catch (e) { /* 무시 */ } }
  function api(path) { const b = getBase(); return (b ? b + "/" : "") + "api/" + path; }
  const enc = encodeURIComponent;
  const lecPath = s => enc(s.subject) + "/" + enc(s.lecture);

  async function fetchJson(url, opts, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 8000);
    try {
      const r = await fetch(url, {...opts, signal: ctl.signal});
      return r;
    } finally { clearTimeout(t); }
  }

  /* ---------- 상태 표시 ---------- */
  function paint() {
    const el = document.getElementById("syncStatus"), line = document.getElementById("syncLine");
    const vl = document.getElementById("viewerLink");
    const hl = document.getElementById("homeLink");
    if (vl) vl.hidden = state === "off" || !!getBase();   // 정리본·과목 화면은 이 페이지를 서버에서 열었을 때만 연결된다
    if (hl) hl.hidden = vl ? vl.hidden : true;
    document.querySelectorAll(".js-home").forEach(a => { a.hidden = vl ? vl.hidden : true; });   // 홈도 서버에서 연 경우에만
    const txt = {off: "", ok: "서버 ✓", syncing: "서버에 올리는 중", offline: "서버 연결 끊김 · 이 기기엔 저장됨"}[state];
    if (el) { el.textContent = txt; el.className = "status " + (state === "ok" ? "saved" : state === "offline" ? "error" : state === "syncing" ? "saving" : ""); el.hidden = state === "off"; }
    if (line) {
      const base = getBase();
      line.innerHTML = "";
      const span = document.createElement("span");
      span.textContent = state === "off" ? "노트북 서버: 연결 안 됨 (서버 없이도 필기는 이 기기에 저장돼요)" :
        state === "offline" ? "노트북 서버: 연결이 끊겼어요. 필기는 이 기기에 저장돼 있고, 연결되면 자동으로 올라가요." :
        "노트북 서버: 연결됨" + (base ? " (" + base + ")" : "") + (pending.size ? " · 올릴 강의 " + pending.size + "개" : "");
      const btn = document.createElement("button");
      btn.className = "btn"; btn.style.marginLeft = "8px"; btn.textContent = "서버 주소";
      btn.onclick = addressSheet;
      line.append(span, btn);
    }
  }
  function setState(s) { state = s; paint(); }

  function addressSheet() {
    showSheet('<h3>노트북 서버 주소</h3>' +
      '<p style="font-size:13.5px;color:var(--muted);margin:0 0 6px">이 페이지를 노트북 서버(python server/app.py)에서 열었다면 비워 두세요. ' +
      '정적 호스팅(GitHub Pages 등)에서 열었다면 노트북 주소를 적습니다. 예: <b>http://192.168.0.5:8000</b><br>' +
      '※ https 페이지에서는 http 주소로 보낼 수 없어요(브라우저가 막음). 그럴 땐 노트북 서버에서 페이지를 여세요.</p>' +
      '<div class="field"><input id="srvAddr" placeholder="비워 두면 이 페이지가 열린 서버" autocomplete="off"></div>' +
      '<div class="row"><button class="btn primary" id="srvSave">저장하고 연결 확인</button><button class="btn" id="closeBtn">닫기</button></div>',
      () => {
        document.getElementById("srvAddr").value = getBase();
        document.getElementById("srvSave").onclick = async () => {
          setBase(document.getElementById("srvAddr").value);
          document.querySelector(".sheet").remove();
          await connect(); toast(state === "off" ? "서버를 찾지 못했어요" : "연결됐어요");
        };
      });
  }

  /* ---------- 연결 확인 ---------- */
  async function connect() {
    try {
      const r = await fetchJson(api("health"), {}, 4000);
      const j = r.ok ? await r.json() : null;
      if (j && j.ok) { setState(pending.size ? "syncing" : "ok"); scheduleRun(300); return true; }
    } catch (e) { /* 아래에서 처리 */ }
    // 이전에 연결된 적이 있으면 "끊김", 처음부터 없으면 "없음"
    setState(getBase() || state === "ok" || state === "syncing" || state === "offline" ? "offline" : "off");
    return false;
  }

  /* ---------- 올리기 ---------- */
  function isDirty(s) { return (s.updatedAt || 0) > (s.syncedAt || 0); }

  function push(s) {
    if (!s || !isDirty(s) || state === "off") return;   // 서버가 없는 환경에서는 시도하지 않는다
    pending.add(s.id);
    if (state === "ok") setState("syncing"); else paint();
    scheduleRun(DEBOUNCE_MS);
  }
  function scheduleRun(ms) { clearTimeout(timer); timer = setTimeout(run, ms); }

  async function run() {
    if (state === "off") return;
    if (busy) { scheduleRun(1000); return; }
    busy = true;
    try {
      for (const id of [...pending]) {
        const cur = (typeof session !== "undefined" && session && session.id === id) ? session : await dbGet("lectures", id);
        if (!cur || !isDirty(cur)) { pending.delete(id); continue; }
        const sentAt = cur.updatedAt;
        const r = await fetchJson(api("live-notes/" + lecPath(cur)), {
          method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify(exportDoc(cur, true)),
        }, 15000);
        if (!r.ok) throw new Error("서버 응답 " + r.status);
        const res = await r.json();
        if (applyRemote(cur, res.notes)) { if (cur === session) renderAfterRemote(); }
        cur.syncedAt = Math.max(cur.syncedAt || 0, sentAt);
        await dbPut("lectures", cur.id, cur);
        if (!res.has_pdf && !cur.pdfUploaded) await uploadPdf(cur);
        if (!isDirty(cur)) pending.delete(id);
      }
      setState(pending.size ? "syncing" : "ok");
      if (pending.size) scheduleRun(DEBOUNCE_MS);
    } catch (e) {
      setState("offline"); scheduleRun(RETRY_MS);
    } finally { busy = false; }
  }

  async function uploadPdf(s) {
    const bytes = await dbGet("pdfs", s.id);
    if (!bytes) return;
    const r = await fetchJson(api("slides-pdf/" + lecPath(s) + "?name=" + enc(s.pdfName || "slides.pdf")), {
      method: "PUT", headers: {"Content-Type": "application/pdf"}, body: bytes,
    }, 120000);
    if (r.ok || r.status === 409) { s.pdfUploaded = true; await dbPut("lectures", s.id, s); }
  }

  function renderAfterRemote() { if (typeof pdfDoc !== "undefined" && pdfDoc) render(); }

  /* ---------- 받기 ---------- */
  async function pull(s) {
    if (state === "off" || !s) return;
    try {
      const r = await fetchJson(api("live-notes/" + lecPath(s)), {}, 8000);
      if (r.status === 404) { push(s); return; }
      if (!r.ok) return;
      const doc = await r.json();
      if (applyRemote(s, doc)) {
        await dbPut("lectures", s.id, s);
        if (s === session) renderAfterRemote();
        toast("서버의 필기를 합쳤어요");
      }
      push(s);
    } catch (e) { setState("offline"); scheduleRun(RETRY_MS); }
  }

  /* ---------- 서버의 강의 목록 · PDF ---------- */
  async function fillList(box, listEl, onPick) {
    if (state === "off") return;
    try {
      const r = await fetchJson(api("lectures"), {}, 6000);
      const items = (await r.json()).filter(x => x.has_pdf);
      if (!items.length) return;
      box.hidden = false; listEl.innerHTML = "";
      items.forEach(it => {
        const b = document.createElement("button");
        b.className = "btn"; b.style.cssText = "display:block;width:100%;text-align:left;margin:4px 0";
        b.textContent = it.subject + " · " + it.lecture.replace(/_/g, " ") + (it.has_live_notes ? "  (필기 있음)" : "");
        b.onclick = () => onPick(it);
        listEl.appendChild(b);
      });
    } catch (e) { /* 목록을 못 받으면 그냥 안 보인다 */ }
  }
  async function fetchPdf(subject, lecture) {
    try {
      const r = await fetchJson(api("slides-pdf/" + enc(subject) + "/" + enc(lecture)), {}, 120000);
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    } catch (e) { return null; }
  }

  /* ---------- 시작 ---------- */
  async function syncAll() {
    for (const s of await dbAll("lectures")) if (isDirty(s)) pending.add(s.id);
    if (pending.size) scheduleRun(300);
  }
  window.notesSync = {push, pull, fillList, fetchPdf, connect};
  window.addEventListener("online", async () => { if (await connect()) syncAll(); });
  setInterval(() => { if (state === "offline") connect().then(ok => ok && syncAll()); }, RETRY_MS);
  paint();
  connect().then(ok => ok && syncAll());
})();

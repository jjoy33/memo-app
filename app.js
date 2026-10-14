/* 수진쌤 메모 — 앱 로직
   저장: Supabase (memos 테이블 + memo-files 저장소), 오프라인일 때는 이 기기에 임시 보관 후 자동 전송 */
(function () {
"use strict";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BUCKET = "memo-files";
const MAX_FILE = 50 * 1024 * 1024;          // Supabase 무료 요금제 파일 1개 최대 크기
const STORAGE_CAP = 1024 * 1024 * 1024;     // 무료 요금제 저장 공간 (표시용)
const ICON = {
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4-1-6z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>'
};

/* ---------------- 설정 확인 ---------------- */
const cfg = window.MEMO_CONFIG || {};
const configured = /^https:\/\//.test(cfg.SUPABASE_URL || "") && (cfg.SUPABASE_ANON_KEY || "").length > 30;
if (!configured || !window.supabase) { $("#setupView").hidden = false; return; }
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

/* ---------------- 상태 ---------------- */
let uid = null, memos = [], outbox = [], flushing = false, channel = null;
let editingId = null, editDraft = null, confirmId = null, pendingRender = false;
let query = "", fileTarget = "composer";
const urlCache = new Map();   // path -> {url, dl, exp}

const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const saveCache = () => lsSet("memo-cache-" + uid, memos);
const saveOutbox = () => lsSet("memo-outbox-" + uid, outbox);
const newId = () => (crypto.randomUUID ? crypto.randomUUID() :
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >> (c / 4)).toString(16)));

/* ---------------- 테마 ---------------- */
const root = document.documentElement;
const isDark = () => { const t = root.getAttribute("data-theme"); return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; };
const syncThemeLbl = () => { $("#themeLbl").textContent = isDark() ? "라이트" : "다크"; };
syncThemeLbl();
$("#themeBtn").onclick = () => {
  const next = isDark() ? "light" : "dark";
  root.setAttribute("data-theme", next); try { localStorage.setItem("memo-theme", next); } catch (e) {}
  syncThemeLbl();
};

/* ---------------- 날짜 ---------------- */
const pad = (n) => String(n).padStart(2, "0");
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const ms = (iso) => new Date(iso).getTime();
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
const timeStr = (t) => { const d = new Date(t), h = d.getHours(); return (h < 12 ? "오전 " : "오후 ") + ((h % 12) || 12) + ":" + pad(d.getMinutes()); };
const dateStr = (t, y) => { const d = new Date(t); return (y ? d.getFullYear() + "년 " : "") + (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + DOW[d.getDay()] + ")"; };
const fullStamp = (t) => { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number), t = new Date(y, m - 1, d).getTime();
  const base = esc(dateStr(t, y !== new Date().getFullYear()));
  if (key === dayKey(Date.now())) return "<b>오늘</b> " + base;
  if (key === dayKey(Date.now() - 864e5)) return "<b>어제</b> " + base;
  return "<b>" + base + "</b>";
}
const fmtSize = (b) => b < 1024 ? b + "B" : b < 1048576 ? (b / 1024).toFixed(0) + "KB" : b < 1073741824 ? (b / 1048576).toFixed(1) + "MB" : (b / 1073741824).toFixed(2) + "GB";

/* ---------------- 알림 ---------------- */
let tt;
function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("show"), 2200); }
function notice(t) { const n = $("#notice"); n.textContent = t || ""; n.hidden = !t; }
function syncDot() {
  const el = $("#sync");
  el.className = "sync " + (!navigator.onLine ? "off" : outbox.length || flushing ? "busy" : "ok");
  el.title = !navigator.onLine ? "오프라인 — 연결되면 자동으로 보냅니다" : outbox.length ? "보내는 중 " + outbox.length + "건" : "동기화됨";
  notice(!navigator.onLine ? "오프라인 상태입니다. 글 메모는 이 기기에 보관했다가 연결되면 자동으로 보냅니다. 파일 첨부는 연결 후에 할 수 있습니다." : "");
}

/* ---------------- 로그인 ---------------- */
let signUpMode = false;
$("#authToggle").onclick = () => {
  signUpMode = !signUpMode;
  $("#aSubmit").textContent = signUpMode ? "계정 만들기" : "로그인";
  $("#authToggle").textContent = signUpMode ? "이미 계정이 있으신가요? 로그인" : "처음이신가요? 계정 만들기";
  $("#aPw").autocomplete = signUpMode ? "new-password" : "current-password";
  setAuthMsg("");
};
function setAuthMsg(t, ok) { const m = $("#authMsg"); m.textContent = t; m.classList.toggle("ok", !!ok); }
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#aEmail").value.trim(), password = $("#aPw").value;
  $("#aSubmit").disabled = true; setAuthMsg("");
  try {
    if (signUpMode) {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) setAuthMsg("인증 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인해 주세요.", true);
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    const m = String(err.message || "");
    setAuthMsg(/Invalid login/i.test(m) ? "이메일 또는 비밀번호가 맞지 않습니다." :
      /already registered/i.test(m) ? "이미 가입된 이메일입니다. 로그인해 주세요." :
      /Email not confirmed/i.test(m) ? "메일 인증이 아직 안 됐습니다. 메일함을 확인해 주세요." :
      !navigator.onLine ? "인터넷 연결을 확인해 주세요." : "로그인하지 못했습니다: " + m);
  } finally { $("#aSubmit").disabled = false; }
});
$("#menuBtn").onclick = () => { $("#accountBox").hidden = !$("#accountBox").hidden; };
$("#logoutBtn").onclick = async () => {
  if (outbox.length && !confirmLogout) { confirmLogout = true; toast("아직 보내지 못한 메모가 있습니다. 한 번 더 누르면 로그아웃합니다."); return; }
  await sb.auth.signOut();
};
let confirmLogout = false;

sb.auth.onAuthStateChange((event, session) => {
  const u = session && session.user;
  if (u && u.id !== uid) start(u);
  else if (!u && uid) stop();
  else if (!u) showAuth();
});

function showAuth() { $("#authView").hidden = false; $("#appView").hidden = true; }
function stop() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  uid = null; memos = []; outbox = []; urlCache.clear(); confirmLogout = false;
  showAuth();
}
function start(user) {
  uid = user.id;
  $("#accEmail").textContent = user.email || "";
  $("#authView").hidden = true; $("#appView").hidden = false;
  memos = lsGet("memo-cache-" + uid, []);
  outbox = lsGet("memo-outbox-" + uid, []);
  render(); syncDot();
  load(); subscribe(); flush();
}

/* ---------------- 서버 동기화 ---------------- */
function applyOutbox(list) {
  let out = list.slice();
  for (const op of outbox) {
    if (op.op === "upsert") { out = out.filter((m) => m.id !== op.row.id); out.push({ ...op.row, _local: true }); }
    if (op.op === "delete") out = out.filter((m) => m.id !== op.id);
  }
  return out.sort((a, b) => ms(b.created_at) - ms(a.created_at));
}
async function load() {
  if (!navigator.onLine) return;
  const { data, error } = await sb.from("memos").select("*").order("created_at", { ascending: false }).limit(3000);
  if (error) { if (/relation|does not exist/i.test(error.message)) notice("Supabase에 memos 테이블이 없습니다. README의 SQL을 먼저 실행해 주세요."); return; }
  memos = applyOutbox(data || []);
  saveCache(); requestRender();
}
function subscribe() {
  if (channel) sb.removeChannel(channel);
  const upsertRow = (row) => {
    if (outbox.some((o) => (o.row && o.row.id === row.id) || o.id === row.id)) return;   // 내가 보낸 변경 대기 중
    memos = memos.filter((m) => m.id !== row.id); memos.push(row);
    memos.sort((a, b) => ms(b.created_at) - ms(a.created_at));
    saveCache(); requestRender();
  };
  channel = sb.channel("memos-" + uid)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "memos", filter: "user_id=eq." + uid }, (p) => upsertRow(p.new))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "memos", filter: "user_id=eq." + uid }, (p) => upsertRow(p.new))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "memos" }, (p) => {
      const id = p.old && p.old.id; if (!id || !memos.some((m) => m.id === id)) return;
      memos = memos.filter((m) => m.id !== id); saveCache(); requestRender();
    })
    .subscribe();
}
function queue(op) {
  // 같은 메모의 이전 대기 작업은 합칩니다
  if (op.op === "upsert") outbox = outbox.filter((o) => !(o.op === "upsert" && o.row.id === op.row.id));
  if (op.op === "delete") {
    const wasNew = outbox.some((o) => o.op === "upsert" && o.row.id === op.id && o.isNew);
    outbox = outbox.filter((o) => !(o.op === "upsert" && o.row.id === op.id));
    if (wasNew && !op.paths.length) { saveOutbox(); syncDot(); return; }
  }
  outbox.push(op); saveOutbox(); syncDot(); flush();
}
const isNetErr = (e) => !navigator.onLine || /fetch|network|Failed to fetch|Load failed/i.test(String((e && e.message) || e));
async function flush() {
  if (flushing || !navigator.onLine || !uid) return;
  flushing = true; syncDot();
  try {
    while (outbox.length) {
      const op = outbox[0];
      try {
        if (op.op === "upsert") {
          const { error } = await sb.from("memos").upsert(op.row);
          if (error) throw error;
        } else if (op.op === "delete") {
          const { error } = await sb.from("memos").delete().eq("id", op.id);
          if (error) throw error;
          if (op.paths && op.paths.length) await sb.storage.from(BUCKET).remove(op.paths);
        }
      } catch (e) {
        if (isNetErr(e)) break;
        toast("저장하지 못한 변경이 있습니다: " + (e.message || e));
      }
      outbox.shift(); saveOutbox();
      const m = op.row && memos.find((x) => x.id === op.row.id);
      if (m) delete m._local;
    }
  } finally { flushing = false; saveCache(); syncDot(); requestRender(); }
}
window.addEventListener("online", () => { syncDot(); flush(); load(); subscribe(); });
window.addEventListener("offline", syncDot);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && uid) { flush(); load(); } });

/* ---------------- 첨부 URL ---------------- */
async function ensureUrls(list) {
  const now = Date.now(), need = [], dlNeed = [];
  for (const m of list) for (const a of (m.attachments || [])) {
    const c = urlCache.get(a.path);
    if (!c || c.exp < now + 60000) { need.push(a.path); if (kind(a) === "file") dlNeed.push(a); }
  }
  if (!need.length || !navigator.onLine) return;
  const uniq = [...new Set(need)];
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(uniq, 6 * 3600);
  if (error || !data) return;
  const exp = now + 6 * 3600 * 1000;
  data.forEach((d) => { if (d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, exp }); });
  await Promise.all(dlNeed.map(async (a) => {
    const { data: d } = await sb.storage.from(BUCKET).createSignedUrl(a.path, 6 * 3600, { download: a.name });
    const c = urlCache.get(a.path); if (d && c) c.dl = d.signedUrl;
  }));
  requestRender();
}
function kind(a) {
  const t = a.type || "";
  if (t.startsWith("image/") && !/heic|heif|tiff/.test(t)) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  return "file";
}
const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,6})$/.exec(name || ""); return m ? m[1].toLowerCase() : ""; };

/* ---------------- 파일 준비 (이미지 용량 줄이기) ---------------- */
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const max = 2000, big = Math.max(bmp.width, bmp.height);
    if (big <= max && file.size < 1.5 * 1048576) { bmp.close && bmp.close(); return file; }
    const s = Math.min(1, max / big), w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const cx = cv.getContext("2d");
    const keepPng = file.type === "image/png" && file.size < 3 * 1048576;
    if (!keepPng) { cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h); }
    cx.drawImage(bmp, 0, 0, w, h); bmp.close && bmp.close();
    const type = keepPng ? "image/png" : "image/jpeg";
    const blob = await new Promise((r) => cv.toBlob(r, type, 0.85));
    if (!blob || blob.size >= file.size) return file;
    const name = (file.name || "image").replace(/\.[^.]+$/, "") + (keepPng ? ".png" : ".jpg");
    return new File([blob], name, { type });
  } catch (e) { return file; }
}
function nameFor(file) {
  if (file.name && file.name !== "image.png") return file.name;
  const d = new Date(), ext = (file.type.split("/")[1] || "bin").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
  return "붙여넣기_" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "_" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + "." + ext;
}
async function uploadFiles(memoId, items, onEach) {
  const out = [];
  for (const it of items) {
    const file = await shrinkImage(it.file);
    const ext = extOf(it.name) || extOf(file.name) || "bin";
    const path = uid + "/" + memoId + "/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + "." + ext;
    onEach && onEach(it, "up");
    const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
    if (error) { onEach && onEach(it, "fail"); throw new Error(/exceed|size/i.test(error.message) ? it.name + " 파일이 너무 큽니다" : error.message); }
    onEach && onEach(it, "done");
    out.push({ path, name: it.name, size: file.size, type: file.type || "application/octet-stream" });
  }
  return out;
}

/* ---------------- 입력창 ---------------- */
const cBody = $("#cBody"), cTitle = $("#cTitle"), form = $("#composer");
const fine = matchMedia("(pointer:fine)").matches;
let cTodo = false, cPin = false, expanded = false, saving = false;
let pending = [];   // {key, file, name, url}
function autosize() { cBody.style.height = "auto"; cBody.style.height = Math.min(cBody.scrollHeight, innerHeight * 0.4) + "px"; }
function syncSave() { $("#cSave").disabled = saving || !(cBody.value.trim() || cTitle.value.trim() || pending.length); }
function syncHint() { $("#cHint").textContent = !fine ? "" : expanded ? "Ctrl+Enter 저장" : "Enter 저장 · Shift+Enter 줄바꿈"; }
syncHint();
{ const d = lsGet("memo-draft", ""); if (d) { cBody.value = d; autosize(); syncSave(); } }
cBody.addEventListener("input", () => { autosize(); syncSave(); lsSet("memo-draft", cBody.value); });
cTitle.addEventListener("input", syncSave);
$("#cExpand").onclick = function () { expanded = !expanded; this.setAttribute("aria-pressed", expanded); form.classList.toggle("expanded", expanded); cTitle.hidden = !expanded; syncHint(); (expanded ? cTitle : cBody).focus(); };
$("#cTodo").onclick = function () { cTodo = !cTodo; this.setAttribute("aria-pressed", cTodo); };
$("#cPin").onclick = function () { cPin = !cPin; this.setAttribute("aria-pressed", cPin); };
cBody.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229 || e.key !== "Enter") return;   // 한글 조합 중 Enter 무시
  if (expanded ? (e.metaKey || e.ctrlKey) : (fine && !e.shiftKey)) { e.preventDefault(); form.requestSubmit(); }
});

function addFiles(files, target) {
  for (const f of files) {
    if (!f || !f.size) continue;
    if (f.size > MAX_FILE) { toast((f.name || "파일") + "은 50MB를 넘어 첨부할 수 없습니다. 영상은 링크로 붙여주세요."); continue; }
    const it = { key: Math.random().toString(36).slice(2), file: f, name: nameFor(f), url: /^(image|video)\//.test(f.type) ? URL.createObjectURL(f) : null };
    if (target === "edit" && editDraft) editDraft.newFiles.push(it); else pending.push(it);
  }
  if (target === "edit") { const b = $("#eBody"); if (b) editDraft.body = b.value; const t = $("#eTitle"); if (t) editDraft.title = t.value; render(true); }
  else { renderPending(); syncSave(); }
}
function renderPending() {
  const box = $("#cPending");
  box.hidden = !pending.length;
  box.innerHTML = pending.map((it) => `<div class="pend" data-key="${it.key}">
    ${it.url && it.file.type.startsWith("image/") ? `<img src="${it.url}" alt="">` : it.url ? `<video src="${it.url}" muted playsinline></video>` :
      `<span class="pname">${esc(it.name)}<br>${fmtSize(it.file.size)}</span>`}
    <button type="button" class="x" aria-label="첨부 빼기">✕</button><span class="bar"></span></div>`).join("");
}
$("#cPending").addEventListener("click", (e) => {
  if (!e.target.classList.contains("x") || saving) return;
  const key = e.target.closest(".pend").dataset.key, it = pending.find((p) => p.key === key);
  if (it && it.url) URL.revokeObjectURL(it.url);
  pending = pending.filter((p) => p.key !== key); renderPending(); syncSave();
});
$("#cAttach").onclick = () => { fileTarget = "composer"; $("#fileInput").click(); };
$("#fileInput").addEventListener("change", (e) => { addFiles([...e.target.files], fileTarget); e.target.value = ""; });

// 붙여넣기: 이미지·파일은 첨부로, 글과 링크는 그대로
function handlePaste(e, target) {
  const dt = e.clipboardData; if (!dt) return;
  const files = [...dt.files];
  if (!files.length) return;
  e.preventDefault();
  const text = dt.getData("text/plain");
  if (text) document.execCommand("insertText", false, text);
  addFiles(files, target);
}
form.addEventListener("paste", (e) => handlePaste(e, "composer"));
document.addEventListener("paste", (e) => {
  if (e.defaultPrevented || $("#appView").hidden) return;
  const tgt = e.target;
  if (tgt.closest && (tgt.closest("#composer") || tgt.closest(".memo"))) return;
  if (tgt.matches && tgt.matches("input,textarea")) return;
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
  if (!files.length && !text) return;
  e.preventDefault();
  if (text) { cBody.value += (cBody.value ? "\n" : "") + text; autosize(); lsSet("memo-draft", cBody.value); }
  addFiles(files, "composer"); syncSave(); cBody.focus();
});
// 끌어다 놓기
let dragDepth = 0;
document.addEventListener("dragenter", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { dragDepth++; form.classList.add("dragging"); } });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; form.classList.remove("dragging"); } });
document.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault(); dragDepth = 0; form.classList.remove("dragging");
  const inEdit = e.target.closest && e.target.closest(".memo") && editDraft;
  addFiles([...e.dataTransfer.files], inEdit ? "edit" : "composer");
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (saving) return;
  const body = cBody.value.trim(), title = expanded ? cTitle.value.trim() : "";
  if (!body && !title && !pending.length) return;
  if (pending.length && !navigator.onLine) { toast("파일 첨부는 인터넷 연결이 필요합니다."); return; }
  const id = newId(), now = new Date().toISOString();
  let attachments = [];
  if (pending.length) {
    saving = true; syncSave(); $("#cSave").textContent = "올리는 중";
    try {
      attachments = await uploadFiles(id, pending, (it, st) => {
        const bar = document.querySelector(`.pend[data-key="${it.key}"] .bar`);
        if (bar) bar.style.width = st === "up" ? "60%" : st === "done" ? "100%" : "0";
      });
    } catch (err) {
      toast("올리지 못했습니다: " + err.message);
      if (attachments.length) sb.storage.from(BUCKET).remove(attachments.map((a) => a.path));
      saving = false; $("#cSave").textContent = "저장"; syncSave(); return;
    }
    saving = false; $("#cSave").textContent = "저장";
  }
  const row = { id, user_id: uid, title, body, todo: cTodo, done: false, pinned: cPin, attachments, created_at: now, updated_at: now };
  memos.unshift({ ...row, _local: true }); saveCache();
  queue({ op: "upsert", row, isNew: true });
  pending.forEach((p) => p.url && URL.revokeObjectURL(p.url)); pending = []; renderPending();
  cBody.value = ""; cTitle.value = ""; autosize(); syncSave(); lsSet("memo-draft", "");
  render(); toast("저장했습니다 · " + timeStr(Date.now()));
  if (fine) cBody.focus();
});

/* ---------------- 목록 그리기 ---------------- */
function requestRender() { if (editingId) { pendingRender = true; return; } render(); }
function hl(raw) {
  raw = String(raw ?? "");
  if (!query) return esc(raw);
  const re = new RegExp("(" + query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
  return raw.split(re).map((p, i) => i % 2 ? "<mark>" + esc(p) + "</mark>" : esc(p)).join("");
}
function richText(raw) {
  const re = /(https?:\/\/[^\s<>"']+)/g, parts = String(raw ?? "").split(re);
  return parts.map((p, i) => {
    if (i % 2 === 0) return hl(p);
    let url = p, tail = "";
    while (/[.,)\]!?;:]$/.test(url)) { tail = url.slice(-1) + tail; url = url.slice(0, -1); }
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${hl(url)}</a>` + hl(tail);
  }).join("");
}
function attsHTML(m) {
  const atts = m.attachments || []; if (!atts.length) return "";
  return '<div class="atts">' + atts.map((a, i) => {
    const c = urlCache.get(a.path), k = kind(a);
    if (k === "image") return c ? `<button type="button" class="att-img" data-act="view" data-i="${i}" aria-label="${esc(a.name)} 크게 보기"><img src="${esc(c.url)}" alt="${esc(a.name)}" loading="lazy"></button>`
      : `<div class="att-ph">${navigator.onLine ? "불러오는 중" : "오프라인"}</div>`;
    if (k === "video" && c) return `<video class="att-video" src="${esc(c.url)}" controls playsinline preload="metadata"></video>`;
    if (k === "audio" && c) return `<audio class="att-audio" src="${esc(c.url)}" controls preload="metadata"></audio>`;
    const href = c ? esc(c.dl || c.url) : "#";
    return `<a class="att-file" href="${href}" target="_blank" rel="noopener"${c ? "" : ' aria-disabled="true"'}>
      <span class="ext">${esc(extOf(a.name) || "file")}</span><span class="fname">${hl(a.name)}</span><span class="fsize">${fmtSize(a.size || 0)}</span></a>`;
  }).join("") + "</div>";
}
function memoHTML(m) {
  if (m.id === editingId) {
    const d = editDraft;
    return `<article class="memo" data-id="${m.id}"><div class="m-main">
      <input class="edit-title" id="eTitle" type="text" maxlength="120" placeholder="제목 (선택)" value="${esc(d.title)}">
      <textarea class="edit-body" id="eBody">${esc(d.body)}</textarea>
      ${(d.attachments.length || d.newFiles.length) ? `<div class="edit-att">
        ${d.attachments.map((a) => `<button type="button" class="chip${d.removed.has(a.path) ? " removed" : ""}" data-act="e-rm" data-path="${esc(a.path)}" title="누르면 첨부 빼기/되살리기"><span>${esc(a.name)}</span>✕</button>`).join("")}
        ${d.newFiles.map((it) => `<button type="button" class="chip" aria-pressed="true" data-act="e-rmnew" data-key="${it.key}"><span>+ ${esc(it.name)}</span>✕</button>`).join("")}
      </div>` : ""}
      <div class="confirm">
        <button type="button" class="chip" data-act="e-add">파일 추가</button>
        <button type="button" class="chip" data-act="e-todo" aria-pressed="${d.todo}">할 일</button>
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="e-cancel">취소</button>
        <button type="button" class="btn primary" data-act="e-save">${d.saving ? "올리는 중" : "수정 저장"}</button>
      </div></div></article>`;
  }
  const c = ms(m.created_at), u = ms(m.updated_at), edited = u - c > 60000;
  return `<article class="memo${m.pinned ? " pinned" : ""}${m.todo && m.done ? " done" : ""}${m._local ? " unsynced" : ""}" data-id="${m.id}">
    ${m.todo ? `<button type="button" class="check" role="checkbox" aria-checked="${!!m.done}" aria-label="완료 표시" data-act="done">${m.done ? ICON.check : ""}</button>` : ""}
    <div class="m-main">
      ${m.title ? `<h3 class="m-title">${hl(m.title)}</h3>` : ""}
      ${m.body ? `<p class="m-body">${richText(m.body)}</p>` : ""}
      ${attsHTML(m)}
      <div class="m-meta">
        ${m.pinned ? '<span class="tag">고정</span>' : ""}
        <time datetime="${esc(m.created_at)}" title="${fullStamp(c)}">${dateStr(c)} ${timeStr(c)}</time>
        ${edited ? `<span title="${fullStamp(u)}">· 수정 ${dayKey(u) === dayKey(c) ? "" : dateStr(u) + " "}${timeStr(u)}</span>` : ""}
        ${m._local ? "<span>· 전송 대기</span>" : ""}
      </div>
      ${confirmId === m.id ? `<div class="confirm"><span>이 메모${(m.attachments || []).length ? "와 첨부파일" : ""}을 삭제할까요?</span>
        <button type="button" class="btn danger" data-act="del-yes">삭제</button>
        <button type="button" class="btn" data-act="del-no">취소</button></div>` : ""}
    </div>
    <div class="m-actions">
      <button type="button" data-act="pin" class="${m.pinned ? "on" : ""}" aria-label="${m.pinned ? "고정 해제" : "고정"}" title="${m.pinned ? "고정 해제" : "고정"}">${ICON.pin}</button>
      <button type="button" data-act="edit" aria-label="수정" title="수정">${ICON.edit}</button>
      <button type="button" data-act="del" aria-label="삭제" title="삭제">${ICON.del}</button>
    </div></article>`;
}
function matches(m, q) {
  if (!q) return true;
  return (m.title || "").toLowerCase().includes(q) || (m.body || "").toLowerCase().includes(q) ||
    (m.attachments || []).some((a) => (a.name || "").toLowerCase().includes(q));
}
function render(keepFocus) {
  if (!uid) return;
  const q = query.toLowerCase(), list = memos.filter((m) => matches(m, q));
  $("#count").textContent = q ? list.length + "/" + memos.length : memos.length ? memos.length + "개" : "";
  const used = memos.reduce((s, m) => s + (m.attachments || []).reduce((t, a) => t + (a.size || 0), 0), 0);
  $("#accUsage").textContent = "첨부 " + fmtSize(used) + " / " + fmtSize(STORAGE_CAP);
  const el = $("#list");
  if (!memos.length) el.innerHTML = '<div class="empty"><strong>아직 메모가 없습니다</strong>위 입력창에 적거나 이미지·파일을 붙여넣으면 날짜와 시간이 함께 기록됩니다.</div>';
  else if (!list.length) el.innerHTML = '<div class="empty"><strong>검색 결과가 없습니다</strong>다른 단어로 찾아보세요.</div>';
  else {
    const pinned = list.filter((m) => m.pinned), rest = list.filter((m) => !m.pinned);
    let html = "";
    if (pinned.length) html += `<section class="group"><div class="group-h"><b>고정한 메모</b><span class="n">${pinned.length}</span></div>${pinned.map(memoHTML).join("")}</section>`;
    const groups = new Map();
    rest.forEach((m) => { const k = dayKey(ms(m.created_at)); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); });
    groups.forEach((arr, k) => { html += `<section class="group"><div class="group-h">${dayLabel(k)}<span class="n">${arr.length}</span></div>${arr.map(memoHTML).join("")}</section>`; });
    el.innerHTML = html;
  }
  if (editingId && !keepFocus) { const b = $("#eBody"); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }
  ensureUrls(list);
}

/* ---------------- 목록 동작 ---------------- */
$("#list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  const fileLink = e.target.closest('.att-file[aria-disabled="true"]');
  if (fileLink) { e.preventDefault(); toast(navigator.onLine ? "링크를 준비하고 있습니다" : "오프라인에서는 파일을 열 수 없습니다"); return; }
  if (!btn) return;
  const art = btn.closest("[data-id]"); if (!art) return;
  const id = art.dataset.id, m = memos.find((x) => x.id === id); if (!m) return;
  const act = btn.dataset.act;
  const touch = (patch) => {
    const row = { ...stripLocal(m), ...patch };
    Object.assign(m, patch, { _local: true }); saveCache(); render();
    queue({ op: "upsert", row });
  };
  if (act === "view") { const a = m.attachments[+btn.dataset.i], c = urlCache.get(a.path); if (c) { $("#viewerImg").src = c.url; $("#viewer").showModal(); } return; }
  if (act === "done") return touch({ done: !m.done });
  if (act === "pin") return touch({ pinned: !m.pinned });
  if (act === "del") { confirmId = id; return render(); }
  if (act === "del-no") { confirmId = null; return render(); }
  if (act === "del-yes") {
    confirmId = null; memos = memos.filter((x) => x.id !== id); saveCache(); render();
    return queue({ op: "delete", id, paths: (m.attachments || []).map((a) => a.path) });
  }
  if (act === "edit") {
    if (editingId) return;
    editingId = id; confirmId = null;
    editDraft = { title: m.title || "", body: m.body || "", todo: !!m.todo, attachments: (m.attachments || []).slice(), removed: new Set(), newFiles: [], saving: false };
    return render();
  }
  if (!editDraft) return;
  if (act === "e-todo") { editDraft.todo = !editDraft.todo; btn.setAttribute("aria-pressed", editDraft.todo); return; }
  if (act === "e-add") { fileTarget = "edit"; $("#fileInput").click(); return; }
  if (act === "e-rm") { const p = btn.dataset.path; editDraft.removed.has(p) ? editDraft.removed.delete(p) : editDraft.removed.add(p); btn.classList.toggle("removed"); return; }
  if (act === "e-rmnew") { editDraft.newFiles = editDraft.newFiles.filter((it) => it.key !== btn.dataset.key); btn.remove(); return; }
  if (act === "e-cancel") { editDraft.newFiles.forEach((it) => it.url && URL.revokeObjectURL(it.url)); endEdit(); return; }
  if (act === "e-save") {
    const d = editDraft; if (d.saving) return;
    const body = d.body.trim(), title = d.title.trim();
    const kept = d.attachments.filter((a) => !d.removed.has(a.path));
    if (!body && !title && !kept.length && !d.newFiles.length) { toast("내용이 비어 있습니다. 지우려면 휴지통을 눌러주세요."); return; }
    if (d.newFiles.length && !navigator.onLine) { toast("파일 추가는 인터넷 연결이 필요합니다."); return; }
    let added = [];
    if (d.newFiles.length) {
      d.saving = true; btn.textContent = "올리는 중";
      try { added = await uploadFiles(id, d.newFiles); }
      catch (err) { toast("올리지 못했습니다: " + err.message); d.saving = false; btn.textContent = "수정 저장"; if (added.length) sb.storage.from(BUCKET).remove(added.map((a) => a.path)); return; }
    }
    const attachments = kept.concat(added);
    const removedPaths = [...d.removed];
    const changed = body !== (m.body || "") || title !== (m.title || "") || d.todo !== !!m.todo || removedPaths.length || added.length;
    endEdit();
    if (!changed) return;
    const patch = { title, body, todo: d.todo, done: d.todo ? !!m.done : false, attachments, updated_at: new Date().toISOString() };
    const row = { ...stripLocal(m), ...patch };
    Object.assign(m, patch, { _local: true }); saveCache(); render();
    queue({ op: "upsert", row });
    if (removedPaths.length && navigator.onLine) sb.storage.from(BUCKET).remove(removedPaths);
  }
});
function stripLocal(m) { const { _local, ...r } = m; return r; }
function endEdit() { editingId = null; editDraft = null; pendingRender = false; render(); }
$("#list").addEventListener("input", (e) => {
  if (!editDraft) return;
  if (e.target.id === "eTitle") editDraft.title = e.target.value;
  if (e.target.id === "eBody") editDraft.body = e.target.value;
});
$("#list").addEventListener("paste", (e) => { if (editDraft && e.target.closest(".memo")) handlePaste(e, "edit"); });
$("#list").addEventListener("keydown", (e) => {
  if (!editDraft) return;
  if (e.key === "Escape") document.querySelector('[data-act="e-cancel"]')?.click();
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); document.querySelector('[data-act="e-save"]')?.click(); }
});
$("#viewerClose").onclick = () => $("#viewer").close();
$("#viewer").addEventListener("click", (e) => { if (e.target.id === "viewer") $("#viewer").close(); });

/* ---------------- 검색 ---------------- */
$("#q").addEventListener("input", (e) => { query = e.target.value.trim(); render(); });

/* ---------------- 내보내기 ---------------- */
function exportText() {
  return [...memos].sort((a, b) => ms(b.created_at) - ms(a.created_at)).map((m) => {
    const c = ms(m.created_at), u = ms(m.updated_at);
    const tags = [m.pinned ? "[고정]" : "", m.todo ? (m.done ? "[완료]" : "[할 일]") : ""].filter(Boolean).join(" ");
    const head = "■ " + fullStamp(c) + (u - c > 60000 ? " (수정 " + fullStamp(u) + ")" : "") + (tags ? " " + tags : "");
    const files = (m.attachments || []).map((a) => "  첨부: " + a.name + " (" + fmtSize(a.size || 0) + ")").join("\n");
    return [head, m.title ? "제목: " + m.title : "", m.body, files].filter(Boolean).join("\n");
  }).join("\n\n");
}
const dlg = $("#exportDlg");
$("#exportBtn").onclick = () => { $("#exportText").value = memos.length ? exportText() : "아직 메모가 없습니다."; dlg.showModal(); };
$("#dlgClose").onclick = () => dlg.close();
$("#dlgCopy").onclick = async () => {
  const ta = $("#exportText");
  try { await navigator.clipboard.writeText(ta.value); toast("전체 복사했습니다"); }
  catch (e) { ta.focus(); ta.select(); toast("텍스트를 선택했습니다. 복사를 눌러주세요"); }
};
$("#dlgSave").onclick = () => {
  const d = new Date(), blob = new Blob(["﻿" + exportText()], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "메모_" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + ".txt";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

/* ---------------- 자정이 지나면 '오늘/어제' 갱신 ---------------- */
setInterval(() => requestRender(), 5 * 60 * 1000);

/* ---------------- 설치형(오프라인) 등록 ---------------- */
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));

/* ---------------- 시작 ---------------- */
sb.auth.getSession().then(({ data }) => {
  const u = data.session && data.session.user;
  if (u) { if (u.id !== uid) start(u); } else if (!uid) showAuth();
});
})();

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
  idea: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
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
// 바로 수정(인라인) 상태
let inlineId = null, inlineBase = null, inlineTimer = null;
let pointerDown = false, renderAfterPointer = false;
const pendingDeletes = new Map();   // id -> {memo, timer}
const HISTORY_MAX = 20;

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
let tt, toastFn = null;
function toast(t, action, fn, ms) {
  const el = $("#toast");
  el.innerHTML = esc(t) + (action ? ` <button type="button" class="toast-btn">${esc(action)}</button>` : "");
  el.classList.toggle("has-action", !!action);
  toastFn = fn || null;
  el.classList.add("show"); clearTimeout(tt);
  tt = setTimeout(() => { el.classList.remove("show"); el.classList.remove("has-action"); toastFn = null; }, ms || (action ? 6000 : 2200));
}
$("#toast").addEventListener("click", (e) => {
  if (!e.target.classList.contains("toast-btn") || !toastFn) return;
  const fn = toastFn; toastFn = null;
  $("#toast").classList.remove("show", "has-action"); clearTimeout(tt);
  fn();
});
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
  inlineId = null; inlineBase = null; editingId = null; editDraft = null;
  ideas = []; boxNames = []; view = "memo";
  showAuth();
}
function start(user) {
  uid = user.id;
  $("#accEmail").textContent = user.email || "";
  $("#authView").hidden = true; $("#appView").hidden = false;
  memos = lsGet("memo-cache-" + uid, []);
  outbox = lsGet("memo-outbox-" + uid, []);
  ideas = lsGet("memo-ideas-" + uid, []); boxNames = lsGet("memo-boxes-" + uid, []);
  render(); syncDot();
  load(); subscribe(); flush();
}

/* ---------------- 서버 동기화 ---------------- */
function applyOutbox(list, table = "memos") {
  let out = list.slice();
  for (const op of outbox) {
    if ((op.table || "memos") !== table) continue;
    if (op.op === "upsert") { out = out.filter((m) => m.id !== op.row.id); out.push({ ...op.row, _local: true }); }
    if (op.op === "delete") out = out.filter((m) => m.id !== op.id);
  }
  return out.sort((a, b) => ms(b.created_at) - ms(a.created_at));
}
let loading = null, lastLoad = 0;
async function load(manual) {
  if (!navigator.onLine || !uid) { if (manual) toast("인터넷 연결을 확인해 주세요"); return; }
  if (loading) return loading;
  loading = (async () => {
    const before = memos.length;
    const { data, error } = await sb.from("memos").select("*").order("created_at", { ascending: false }).limit(3000);
    if (error) {
      if (/relation|does not exist/i.test(error.message)) notice("Supabase에 memos 테이블이 없습니다. README의 SQL을 먼저 실행해 주세요.");
      if (manual) toast("불러오지 못했습니다. 잠시 뒤 다시 눌러주세요.");
      return;
    }
    let next = applyOutbox(data || []).filter((m) => !pendingDeletes.has(m.id));
    // 지금 이 기기에서 고치고 있는 메모는 화면의 내용을 그대로 유지
    const editingLocal = inlineId && memos.find((m) => m.id === inlineId);
    if (editingLocal) next = next.map((m) => m.id === inlineId ? editingLocal : m);
    memos = next; lastLoad = Date.now();
    // 소재함
    const [ir, br] = await Promise.all([
      sb.from("clips").select("*").order("created_at", { ascending: false }).limit(5000),
      sb.from("clip_boxes").select("*").order("created_at", { ascending: true })
    ]);
    if (!ir.error) ideas = applyOutbox(ir.data || [], "clips").filter((x) => !ideaDeletes.has(x.id));
    if (!br.error) boxNames = (br.data || []).map((b) => b.name);
    saveIdeas();
    saveCache(); requestRender();
    if (manual) { const diff = memos.length - before; toast(diff > 0 ? `새 메모 ${diff}개를 가져왔습니다` : "최신 상태입니다"); }
  })();
  try { await loading; } finally { loading = null; }
}
function subscribe() {
  if (channel) sb.removeChannel(channel);
  const upsertRow = (row) => {
    if (row.id === inlineId || pendingDeletes.has(row.id)) return;   // 지금 이 기기에서 고치는 중
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
    .on("postgres_changes", { event: "*", schema: "public", table: "clips" }, (p) => {
      if (p.eventType === "DELETE") { const id = p.old && p.old.id; if (!id) return; ideas = ideas.filter((x) => x.id !== id); }
      else {
        const row = p.new; if (!row || row.user_id !== uid || ideaDeletes.has(row.id)) return;
        if (outbox.some((o) => o.table === "clips" && ((o.row && o.row.id === row.id) || o.id === row.id))) return;
        ideas = ideas.filter((x) => x.id !== row.id); ideas.push(row);
      }
      saveIdeas(); requestRender();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "clip_boxes" }, () => load())
    .subscribe((status) => {
      // 실시간 연결이 끊기면 5초 뒤 다시 연결 (오래 켜 둔 PC 창 대비)
      if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") && uid) {
        const ch = channel;
        setTimeout(() => { if (uid && ch === channel && navigator.onLine) { subscribe(); load(); } }, 5000);
      }
    });
}
function queue(op) {
  // 같은 메모의 이전 대기 작업은 합칩니다
  const tb = op.table || "memos", same = (o) => (o.table || "memos") === tb;
  if (op.op === "upsert") outbox = outbox.filter((o) => !(same(o) && o.op === "upsert" && o.row.id === op.row.id));
  if (op.op === "delete") {
    const wasNew = outbox.some((o) => same(o) && o.op === "upsert" && o.row.id === op.id && o.isNew);
    outbox = outbox.filter((o) => !(same(o) && o.op === "upsert" && o.row.id === op.id));
    if (wasNew && !(op.paths || []).length) { saveOutbox(); syncDot(); return; }
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
        const tb = op.table || "memos";
        if (op.op === "upsert") {
          const { error } = await sb.from(tb).upsert(op.row);
          if (error) throw error;
        } else if (op.op === "box") {
          const { error } = await sb.from("clip_boxes").upsert({ name: op.name, user_id: uid }, { onConflict: "user_id,name", ignoreDuplicates: true });
          if (error) throw error;
        } else if (op.op === "delete") {
          const { error } = await sb.from(tb).delete().eq("id", op.id);
          if (error) throw error;
          if (op.paths && op.paths.length) await sb.storage.from(BUCKET).remove(op.paths);
        }
      } catch (e) {
        if (isNetErr(e)) break;
        toast("저장하지 못한 변경이 있습니다: " + (e.message || e));
      }
      outbox.shift(); saveOutbox();
      const m = op.row && ((op.table || "memos") === "clips" ? ideas : memos).find((x) => x.id === op.row.id);
      if (m) delete m._local;
    }
  } finally { flushing = false; saveCache(); saveIdeas(); syncDot(); requestRender(); }
}
window.addEventListener("online", () => { syncDot(); flush(); load(); subscribe(); });
window.addEventListener("offline", syncDot);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && uid) { flush(); load(); } });
// PC 창으로 돌아오면 바로, 켜 둔 동안에는 30초마다 새 메모 확인
window.addEventListener("focus", () => { if (uid && Date.now() - lastLoad > 3000) { flush(); load(); } });
setInterval(() => { if (uid && document.visibilityState === "visible" && Date.now() - lastLoad > 25000) load(); }, 30000);
$("#refreshBtn").addEventListener("click", () => {
  const b = $("#refreshBtn"); b.classList.add("spin");
  flush(); load(true).finally(() => setTimeout(() => b.classList.remove("spin"), 400));
});

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

/* ---------------- 서식 있는 글 (글자 크기·색, 이미지·영상·표) ---------------- */
const SZ = ["sz-s", "sz-m", "sz-l", "sz-xl"];
const CL = ["c-def", "c-red", "c-orange", "c-green", "c-blue", "c-purple", "c-gray"];
const HL = ["hl-none", "hl-yellow", "hl-green", "hl-pink"];
const OK_CLASS = new Set([...SZ, ...CL, ...HL, "mt"]);
const SIZES = [["sz-s", "작게"], ["sz-m", "보통"], ["sz-l", "크게"], ["sz-xl", "아주 크게"]];
const COLORS = [["c-def", "기본색"], ["c-red", "빨강"], ["c-orange", "주황"], ["c-green", "초록"], ["c-blue", "파랑"], ["c-purple", "보라"], ["c-gray", "회색"]];
const HLS = [["hl-none", "형광펜 없음"], ["hl-yellow", "노랑 형광펜"], ["hl-green", "연두 형광펜"], ["hl-pink", "분홍 형광펜"]];
const PURIFY = {
  ALLOWED_TAGS: ["p", "div", "br", "b", "strong", "i", "em", "u", "s", "strike", "span", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th",
    "img", "video", "a", "h1", "h2", "h3", "h4", "blockquote", "hr"],
  ALLOWED_ATTR: ["class", "data-path", "data-name", "href", "colspan", "rowspan"]
};
if (window.DOMPurify) DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "class") {
    const v = String(data.attrValue).split(/\s+/).filter((c) => OK_CLASS.has(c)).join(" ");
    if (v) data.attrValue = v; else data.keepAttr = false;
  }
  if (data.attrName === "href" && !/^https?:\/\//i.test(data.attrValue)) data.keepAttr = false;
});
const clean = (html) => window.DOMPurify ? DOMPurify.sanitize(html || "", PURIFY) : esc(html);
const box = () => document.createElement("div");
const plainToHtml = (t) => esc(t || "").replace(/\n/g, "<br>");
const sourceHTML = (m) => m.html ? clean(m.html) : plainToHtml(m.body);
function fillMedia(root) {
  root.querySelectorAll("img, video").forEach((el) => {
    if (el.hasAttribute("data-uploading")) return;
    const p = el.getAttribute("data-path");
    if (!p) { el.remove(); return; }
    const c = urlCache.get(p);
    if (c) el.setAttribute("src", c.url);
    if (el.tagName === "VIDEO") { el.setAttribute("controls", ""); el.setAttribute("playsinline", ""); el.setAttribute("preload", "metadata"); }
    else { el.setAttribute("loading", "lazy"); el.setAttribute("alt", el.getAttribute("data-name") || "이미지"); }
  });
}
// 보기 화면: 파일 주소 붙이기 + 링크 만들기 + 검색어 표시
function viewHTML(m) {
  const b = box(); b.innerHTML = sourceHTML(m);
  fillMedia(b);
  b.querySelectorAll("a").forEach((a) => { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer"); });
  const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT), nodes = [];
  while (w.nextNode()) nodes.push(w.currentNode);
  for (const n of nodes) {
    const inA = n.parentElement && n.parentElement.closest("a");
    const html = inA ? hl(n.nodeValue) : richText(n.nodeValue);
    if (html === esc(n.nodeValue)) continue;
    const s = box(); s.innerHTML = html; n.replaceWith(...s.childNodes);
  }
  return b.innerHTML;
}
function editHTML(m) { const b = box(); b.innerHTML = sourceHTML(m); fillMedia(b); return b.innerHTML; }
const isEmptyEditor = (ed) => !ed.textContent.trim() && !ed.querySelector("img, video, table, hr");
function storeHTML(ed) {
  if (isEmptyEditor(ed)) return "";
  const b = box(); b.innerHTML = ed.innerHTML;
  b.querySelectorAll("[data-uploading]").forEach((x) => x.remove());
  b.querySelectorAll("img, video").forEach((x) => ["src", "controls", "playsinline", "preload", "loading", "alt", "muted"].forEach((a) => x.removeAttribute(a)));
  return clean(b.innerHTML).trim();
}
const textOf = (ed) => (ed.innerText || "").replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
const changed = (ed) => ed && ed.dispatchEvent(new Event("input", { bubbles: true }));

/* 도구 막대 */
const IC = {
  img: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/></svg>',
  table: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M10 4v16"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>'
};
function toolsHTML() {
  return `<div class="tools" role="toolbar" aria-label="글자 꾸미기">
    <div class="tgrp"><button type="button" class="tbtn" data-t="pop" data-pop="size" title="글자 크기" aria-label="글자 크기"><span class="t-size">가<small>가</small></span></button>
      <div class="pop" data-popid="size">${SIZES.map(([c, l]) => `<button type="button" data-t="size" data-v="${c}"><span class="${c}">${l}</span></button>`).join("")}</div></div>
    <div class="tgrp"><button type="button" class="tbtn" data-t="pop" data-pop="color" title="글자 색" aria-label="글자 색"><span class="t-color">A</span></button>
      <div class="pop pop-sw" data-popid="color">${COLORS.map(([c, l]) => `<button type="button" data-t="color" data-v="${c}" title="${l}" aria-label="${l}"><span class="sw ${c}">A</span></button>`).join("")}</div></div>
    <div class="tgrp"><button type="button" class="tbtn" data-t="pop" data-pop="hl" title="형광펜" aria-label="형광펜"><span class="t-hl">ab</span></button>
      <div class="pop pop-sw" data-popid="hl">${HLS.map(([c, l]) => `<button type="button" data-t="hl" data-v="${c}" title="${l}" aria-label="${l}"><span class="sw ${c}">ab</span></button>`).join("")}</div></div>
    <button type="button" class="tbtn" data-t="bold" title="굵게" aria-label="굵게"><b>B</b></button>
    <button type="button" class="tbtn" data-t="list" title="목록" aria-label="목록">${IC.list}</button>
    <span class="tsep"></span>
    <button type="button" class="tbtn" data-t="media" title="이미지·영상 넣기" aria-label="이미지·영상 넣기">${IC.img}</button>
    <button type="button" class="tbtn" data-t="table" title="표 넣기" aria-label="표 넣기">${IC.table}</button>
    <span class="tbl-ops"><span class="tsep"></span>
      <button type="button" class="tbtn txt" data-t="row+">줄 +</button><button type="button" class="tbtn txt" data-t="col+">칸 +</button>
      <button type="button" class="tbtn txt" data-t="row-">줄 −</button><button type="button" class="tbtn txt" data-t="col-">칸 −</button>
      <button type="button" class="tbtn txt" data-t="tbl-del">표 삭제</button></span>
  </div>`;
}
const editorOf = (tools) => tools.closest("#composer") ? $("#cBody") : (tools.closest(".memo") || document).querySelector(".in-body");
const toolsOf = (ed) => ed.id === "cBody" ? $("#cTools .tools") : ed.closest(".memo") && ed.closest(".memo").querySelector(".tools");
function restoreRange(ed) {
  const sel = getSelection();
  if (document.activeElement !== ed) ed.focus({ preventScroll: true });
  if (ed._range && ed.contains(ed._range.commonAncestorContainer)) { sel.removeAllRanges(); sel.addRange(ed._range); }
  else if (!sel.rangeCount || !ed.contains(sel.anchorNode)) {
    const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  }
}
const elOf = (n) => n && (n.nodeType === 1 ? n : n.parentElement);
document.addEventListener("selectionchange", () => {
  const sel = getSelection(); if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0), host = elOf(r.commonAncestorContainer), ed = host && host.closest(".editor");
  if (!ed) return;
  ed._range = r.cloneRange();
  const td = elOf(r.startContainer) && elOf(r.startContainer).closest("td, th");
  const t = toolsOf(ed); if (t) t.classList.toggle("in-table", !!(td && ed.contains(td)));
});
function wrapClass(ed, group, cls) {
  restoreRange(ed);
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) { toast("꾸밀 글자를 먼저 드래그해서 선택하세요"); return; }
  document.execCommand("styleWithCSS", false, false);
  document.execCommand("fontName", false, "memo-mark");
  ed.querySelectorAll('font[face="memo-mark"]').forEach((f) => {
    f.querySelectorAll("span").forEach((s) => { s.classList.remove(...group); if (!s.classList.length) s.removeAttribute("class"); });
    const sp = document.createElement("span"); sp.className = cls;
    while (f.firstChild) sp.appendChild(f.firstChild);
    f.replaceWith(sp);
    // 기본값으로 되돌리는 경우, 바깥에 다른 값이 없으면 감싸지 않음
    const isDefault = cls === group[0] || cls === "sz-m";
    if (isDefault && !sp.parentElement.closest(group.map((g) => "." + g).join(","))) sp.replaceWith(...sp.childNodes);
  });
  changed(ed);
}
function curCell(ed) {
  const r = ed._range, el = r && elOf(r.startContainer), td = el && el.closest("td, th");
  return td && ed.contains(td) ? td : null;
}
function tableOp(ed, op) {
  if (op === "table") {
    restoreRange(ed);
    document.execCommand("insertHTML", false, '<table class="mt"><tbody><tr><td id="memo-first-cell"><br></td><td><br></td></tr><tr><td><br></td><td><br></td></tr></tbody></table><div><br></div>');
    const first = document.getElementById("memo-first-cell");
    if (first) {   // 커서를 첫 칸으로
      first.removeAttribute("id");
      const r = document.createRange(); r.setStart(first, 0); r.collapse(true);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); ed._range = r.cloneRange();
      const t = toolsOf(ed); if (t) t.classList.add("in-table");
    }
    return;
  }
  const td = curCell(ed); if (!td) { toast("표 안의 칸을 먼저 눌러주세요"); return; }
  const tr = td.parentElement, table = td.closest("table"), idx = td.cellIndex;
  if (op === "row+") { const n = tr.cloneNode(true); n.querySelectorAll("td, th").forEach((c) => { c.innerHTML = "<br>"; }); tr.after(n); }
  if (op === "col+") table.querySelectorAll("tr").forEach((row) => { const c = document.createElement("td"); c.innerHTML = "<br>"; const ref = row.cells[idx]; ref ? ref.after(c) : row.appendChild(c); });
  if (op === "row-") { if (table.rows.length <= 1) table.remove(); else tr.remove(); }
  if (op === "col-") { if (tr.cells.length <= 1) table.remove(); else table.querySelectorAll("tr").forEach((row) => row.cells[idx] && row.cells[idx].remove()); }
  if (op === "tbl-del") table.remove();
  ed._range = null; changed(ed);
}
// 도구 막대를 눌러도 글쓰기 칸의 커서가 유지되도록
document.addEventListener("mousedown", (e) => { if (e.target.closest && e.target.closest(".tools")) e.preventDefault(); }, true);
const mediaInput = document.createElement("input");
mediaInput.type = "file"; mediaInput.multiple = true; mediaInput.accept = "image/*,video/*"; mediaInput.hidden = true;
document.body.appendChild(mediaInput);
let mediaTarget = null;
mediaInput.addEventListener("change", () => { if (mediaTarget) insertFiles([...mediaInput.files], mediaTarget); mediaInput.value = ""; });
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest(".tools [data-t]");
  if (!b) { if (!(e.target.closest && e.target.closest(".tools"))) document.querySelectorAll(".pop.open").forEach((p) => p.classList.remove("open")); return; }
  const tools = b.closest(".tools"), ed = editorOf(tools); if (!ed) return;
  const t = b.dataset.t;
  if (t === "pop") {
    const id = b.dataset.pop;
    tools.querySelectorAll(".pop").forEach((p) => p.classList.toggle("open", p.dataset.popid === id && !p.classList.contains("open")));
    return;
  }
  tools.querySelectorAll(".pop.open").forEach((p) => p.classList.remove("open"));
  if (t === "size") wrapClass(ed, SZ, b.dataset.v);
  else if (t === "color") wrapClass(ed, CL, b.dataset.v);
  else if (t === "hl") wrapClass(ed, HL, b.dataset.v);
  else if (t === "bold") { restoreRange(ed); document.execCommand("bold"); }
  else if (t === "list") { restoreRange(ed); document.execCommand("insertUnorderedList"); }
  else if (t === "media") { mediaTarget = ed; mediaInput.click(); }
  else tableOp(ed, t);
});

/* 이미지·영상을 글 사이에 넣기 */
const inflight = new Set();
const isMedia = (f) => /^(image|video)\//.test(f.type) && !/heic|heif|tiff/.test(f.type);
function insertFiles(files, ed) {
  files = files.filter((f) => f && f.size);
  const media = files.filter(isMedia), others = files.filter((f) => !isMedia(f));
  if (others.length) {
    if (ed.id === "cBody") addFiles(others, "composer");
    else attachToMemo(others, ed);
  }
  if (!media.length) return;
  if (!navigator.onLine) { toast("이미지·영상은 인터넷이 연결되어야 넣을 수 있습니다"); return; }
  const memoId = ed.id === "cBody" ? draftId() : ed.closest(".memo").dataset.id;
  restoreRange(ed);
  for (const f of media) {
    if (f.size > MAX_FILE) { toast((f.name || "파일") + "은 50MB를 넘어 넣을 수 없습니다. 긴 영상은 링크로 붙여주세요."); continue; }
    const key = Math.random().toString(36).slice(2), url = URL.createObjectURL(f), video = f.type.startsWith("video/");
    document.execCommand("insertHTML", false, (video
      ? `<video src="${url}" data-uploading="${key}" muted playsinline controls></video>`
      : `<img src="${url}" data-uploading="${key}" alt="">`) + "<br>");
    const p = uploadFiles(memoId, [{ file: f, name: nameFor(f) }]).then(([att]) => {
      att.inline = true;
      if (ed.id === "cBody") composerAtts.push(att);
      else { const m = memos.find((x) => x.id === memoId); if (m) m.attachments = (m.attachments || []).concat(att); }
      lsSet("memo-draft-atts", composerAtts);
      urlCache.set(att.path, { url, exp: Date.now() + 6 * 3600 * 1000 });
      const el = document.querySelector(`[data-uploading="${key}"]`);
      if (el) { el.setAttribute("data-path", att.path); el.setAttribute("data-name", att.name); el.removeAttribute("data-uploading"); changed(el.closest(".editor")); }
    }).catch((err) => {
      toast("올리지 못했습니다: " + err.message);
      const el = document.querySelector(`[data-uploading="${key}"]`); if (el) { const ed2 = el.closest(".editor"); el.remove(); changed(ed2); }
    }).finally(() => { inflight.delete(p); syncSave(); });
    inflight.add(p);
  }
  syncSave();
}
async function attachToMemo(files, ed) {
  const m = memos.find((x) => x.id === ed.closest(".memo").dataset.id); if (!m) return;
  if (!navigator.onLine) { toast("파일 첨부는 인터넷 연결이 필요합니다."); return; }
  const items = files.filter((f) => f.size <= MAX_FILE).map((f) => ({ file: f, name: nameFor(f) }));
  if (items.length < files.length) toast("50MB를 넘는 파일은 빼고 첨부합니다.");
  try {
    const added = await uploadFiles(m.id, items);
    m.attachments = (m.attachments || []).concat(added);
    saveMemo(m, { updated_at: new Date().toISOString() });
    toast("파일을 첨부했습니다. 수정을 마치면 아래에 보입니다.");
  } catch (err) { toast("올리지 못했습니다: " + err.message); }
}
// 붙여넣기: 파일은 글 사이에, 웹에서 복사한 글은 안전하게 정리해서
document.addEventListener("paste", (e) => {
  const ed = e.target.closest && e.target.closest(".editor");
  const dt = e.clipboardData; if (!dt) return;
  const files = [...dt.files];
  if (ed) {
    if (files.length) { e.preventDefault(); insertFiles(files, ed); return; }
    const html = dt.getData("text/html");
    if (html) {
      e.preventDefault();
      const b = box(); b.innerHTML = clean(html);
      b.querySelectorAll("img, video").forEach((x) => { if (!x.getAttribute("data-path")) x.remove(); });
      fillMedia(b);
      document.execCommand("insertHTML", false, b.innerHTML);
    }
    return;
  }
  // 입력칸 밖에서 붙여넣으면 새 메모 칸으로
  if ($("#appView").hidden || (e.target.matches && e.target.matches("input, textarea"))) return;
  const text = dt.getData("text/plain");
  if (!files.length && !text) return;
  e.preventDefault();
  const cb = $("#cBody");
  if (text) { cb.focus(); const r = document.createRange(); r.selectNodeContents(cb); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand("insertText", false, text); }
  if (files.length) insertFiles(files, cb);
});
// 끌어다 놓기
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
document.addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; $("#composer").classList.add("dragging"); } });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#composer").classList.remove("dragging"); } });
document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault(); dragDepth = 0; $("#composer").classList.remove("dragging");
  const files = [...e.dataTransfer.files];
  if (editDraft && e.target.closest && e.target.closest(".memo.editing")) { addFiles(files, "edit"); return; }
  const ed = (e.target.closest && e.target.closest(".editor")) || $("#cBody");
  const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
  if (r && ed.contains(r.startContainer)) ed._range = r;
  insertFiles(files, ed);
});

/* ---------------- 태그 ---------------- */
const normTag = (t) => String(t || "").replace(/^#+/, "").replace(/[\s,#]+/g, "").slice(0, 30);
let cTags = [];   // 새 메모에 붙일 태그
function allTags() {
  const c = new Map();
  memos.forEach((m) => memoTags(m).forEach((t) => c.set(t, (c.get(t) || 0) + 1)));
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
}
const tagChipsHTML = (tags) => tags.map((t) => `<span class="tag-chip">#${esc(t)}<button type="button" class="tag-x" data-tagrm="${esc(t)}" aria-label="${esc(t)} 태그 빼기">✕</button></span>`).join("");
const tagEditorHTML = (tags) => `<div class="tag-row tag-edit"><span class="tag-chips">${tagChipsHTML(tags)}</span><input class="tag-input" type="text" placeholder="# 태그 추가" list="tagList" maxlength="30" enterkeyhint="done" aria-label="태그 추가"></div>`;
function tagsOf(row) {   // row: 태그 입력 줄
  if (row.id === "cTagRow") return cTags;
  const m = memos.find((x) => x.id === (row.closest(".memo") || {}).dataset?.id); return m ? (m.tags || []) : [];
}
function setTags(row, tags) {
  row.querySelector(".tag-chips").innerHTML = tagChipsHTML(tags);
  if (row.id === "cTagRow") { cTags = tags; row.classList.toggle("has-tags", tags.length > 0); lsSet("memo-draft-tags", tags); return; }
  const m = memos.find((x) => x.id === row.closest(".memo").dataset.id); if (!m) return;
  m.tags = tags;
  if (inlineId === m.id) { inlineDirty = true; clearTimeout(inlineTimer); inlineTimer = setTimeout(inlineSaveNow, 1000); }
}
function addTagFrom(input) {
  const row = input.closest(".tag-row"), parts = input.value.split(/[\s,]+/).map(normTag).filter(Boolean);
  input.value = "";
  if (!parts.length) return;
  const tags = tagsOf(row).slice();
  parts.forEach((t) => { if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t); });
  setTags(row, tags);
}
document.addEventListener("keydown", (e) => {
  const inp = e.target.closest && e.target.closest(".tag-input"); if (!inp) return;
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" || e.key === "," || e.key === " ") { e.preventDefault(); addTagFrom(inp); }
  else if (e.key === "Backspace" && !inp.value) { const row = inp.closest(".tag-row"), t = tagsOf(row).slice(); if (t.length) { t.pop(); setTags(row, t); } }
});
document.addEventListener("input", (e) => {   // 목록에서 고른 경우 바로 추가
  const inp = e.target.closest && e.target.closest(".tag-input"); if (!inp) return;
  if (e.inputType === "insertReplacementText" || (!e.inputType && inp.value)) addTagFrom(inp);
});
document.addEventListener("focusout", (e) => {
  const inp = e.target.closest && e.target.closest(".tag-input"); if (inp && inp.value.trim()) addTagFrom(inp);
});
document.addEventListener("click", (e) => {
  const x = e.target.closest && e.target.closest(".tag-x"); if (!x) return;
  const row = x.closest(".tag-row"); setTags(row, tagsOf(row).filter((t) => t !== x.dataset.tagrm));
});
function setTagFilter(t) {
  const cur = query.startsWith("#") ? query.slice(1).toLowerCase() : "";
  query = cur === String(t).toLowerCase() ? "" : "#" + t;
  $("#q").value = query; render();
  if (query) window.scrollTo({ top: $("#q").getBoundingClientRect().top + scrollY - 80, behavior: "smooth" });
}
function renderTagBar() {
  const tags = allTags(), bar = $("#tagBar"), active = query.startsWith("#") ? query.slice(1).toLowerCase() : "";
  bar.hidden = !tags.length;
  bar.innerHTML = tags.map(([t, n]) => `<button type="button" class="tag-filter${active === t.toLowerCase() ? " on" : ""}" data-tag="${esc(t)}" aria-pressed="${active === t.toLowerCase()}">#${esc(t)}<span>${n}</span></button>`).join("");
  $("#tagList").innerHTML = tags.map(([t]) => `<option value="${esc(t)}">`).join("");
}
$("#tagBar").addEventListener("click", (e) => { const b = e.target.closest("[data-tag]"); if (b) setTagFilter(b.dataset.tag); });

/* ---------------- 입력창 ---------------- */
const cBody = $("#cBody"), cTitle = $("#cTitle"), form = $("#composer");
$("#cTools").innerHTML = toolsHTML();
const fine = matchMedia("(pointer:fine)").matches;
let cTodo = false, cPin = false, expanded = false, saving = false;
let pending = [];        // 글 사이가 아닌 첨부파일 {key, file, name, url}
let composerAtts = lsGet("memo-draft-atts", []);   // 글 사이에 넣은 이미지·영상
function draftId() { let d = lsGet("memo-draft-id", ""); if (!d) { d = newId(); lsSet("memo-draft-id", d); } return d; }
function syncSave() { $("#cSave").disabled = saving || (isEmptyEditor(cBody) && !cTitle.value.trim() && !pending.length); }
function syncEmpty() { cBody.classList.toggle("is-empty", isEmptyEditor(cBody)); }
function syncHint() { $("#cHint").textContent = !fine ? "" : expanded ? "Ctrl+Enter 저장" : "Enter 저장 · Shift+Enter 줄바꿈"; }
syncHint();
cTags = lsGet("memo-draft-tags", []); setTags($("#cTagRow"), cTags);
{ const d = lsGet("memo-draft-html", ""); if (d) { cBody.innerHTML = clean(d); fillMedia(cBody); } syncEmpty(); syncSave(); }
let draftTimer;
cBody.addEventListener("input", () => {
  syncEmpty(); syncSave();
  clearTimeout(draftTimer); draftTimer = setTimeout(() => lsSet("memo-draft-html", storeHTML(cBody)), 400);
});
cTitle.addEventListener("input", syncSave);
$("#cExpand").onclick = function () { expanded = !expanded; this.setAttribute("aria-pressed", expanded); form.classList.toggle("expanded", expanded); cTitle.hidden = !expanded; syncHint(); (expanded ? cTitle : cBody).focus(); };
$("#cTodo").onclick = function () { cTodo = !cTodo; this.setAttribute("aria-pressed", cTodo); };
$("#cPin").onclick = function () { cPin = !cPin; this.setAttribute("aria-pressed", cPin); };
cBody.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229 || e.key !== "Enter") return;   // 한글 조합 중 Enter 무시
  const sel = getSelection(), at = sel.rangeCount && elOf(sel.anchorNode);
  const inBlock = at && at.closest("td, th, li");
  if (expanded ? (e.metaKey || e.ctrlKey) : (fine && !e.shiftKey && !inBlock)) { e.preventDefault(); form.requestSubmit(); }
});

function addFiles(files, target) {
  for (const f of files) {
    if (!f || !f.size) continue;
    if (f.size > MAX_FILE) { toast((f.name || "파일") + "은 50MB를 넘어 첨부할 수 없습니다. 영상은 링크로 붙여주세요."); continue; }
    const it = { key: Math.random().toString(36).slice(2), file: f, name: nameFor(f), url: /^(image|video)\//.test(f.type) ? URL.createObjectURL(f) : null };
    if (target === "edit" && editDraft) editDraft.newFiles.push(it); else pending.push(it);
  }
  if (target === "edit") render(true);
  else { renderPending(); syncSave(); }
}
function renderPending() {
  const bx = $("#cPending");
  bx.hidden = !pending.length;
  bx.innerHTML = pending.map((it) => `<div class="pend" data-key="${it.key}">
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
$("#fileInput").addEventListener("change", (e) => {
  const files = [...e.target.files];
  if (fileTarget === "edit") addFiles(files, "edit"); else insertFiles(files, cBody);
  e.target.value = "";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (saving) return;
  if (inflight.size) {
    saving = true; syncSave(); $("#cSave").textContent = "올리는 중";
    await Promise.allSettled([...inflight]);
    saving = false; $("#cSave").textContent = "저장";
  }
  if ($("#cTagInput").value.trim()) addTagFrom($("#cTagInput"));
  const html = storeHTML(cBody), body = textOf(cBody), title = expanded ? cTitle.value.trim() : "";
  if (!html && !title && !pending.length) return;
  if (pending.length && !navigator.onLine) { toast("파일 첨부는 인터넷 연결이 필요합니다."); return; }
  const id = draftId(), now = new Date().toISOString();
  let files = [];
  if (pending.length) {
    saving = true; syncSave(); $("#cSave").textContent = "올리는 중";
    try {
      files = await uploadFiles(id, pending, (it, st) => {
        const bar = document.querySelector(`.pend[data-key="${it.key}"] .bar`);
        if (bar) bar.style.width = st === "up" ? "60%" : st === "done" ? "100%" : "0";
      });
    } catch (err) {
      toast("올리지 못했습니다: " + err.message);
      if (files.length) sb.storage.from(BUCKET).remove(files.map((a) => a.path));
      saving = false; $("#cSave").textContent = "저장"; syncSave(); return;
    }
    saving = false; $("#cSave").textContent = "저장";
  }
  const used = new Set([...cBody.querySelectorAll("[data-path]")].map((x) => x.getAttribute("data-path")));
  const attachments = composerAtts.filter((a) => used.has(a.path)).concat(files);
  const unused = composerAtts.filter((a) => !used.has(a.path)).map((a) => a.path);
  if (unused.length && navigator.onLine) sb.storage.from(BUCKET).remove(unused);
  const row = { id, user_id: uid, title, body, html, todo: cTodo, done: false, pinned: cPin, attachments, tags: cTags.slice(), history: [], created_at: now, updated_at: now };
  memos.unshift({ ...row, _local: true }); saveCache();
  queue({ op: "upsert", row, isNew: true });
  pending.forEach((p) => p.url && URL.revokeObjectURL(p.url)); pending = []; renderPending();
  cBody.innerHTML = ""; cTitle.value = ""; composerAtts = []; setTags($("#cTagRow"), []);
  lsSet("memo-draft-html", ""); lsSet("memo-draft-id", ""); lsSet("memo-draft-atts", []);
  syncEmpty(); syncSave();
  render(); toast("저장했습니다 · " + timeStr(Date.now()));
  if (fine) cBody.focus();
});

/* ---------------- 목록 그리기 ---------------- */
function requestRender() { if (editingId || inlineId) { pendingRender = true; return; } render(); }
function softRender() { if (pointerDown) renderAfterPointer = true; else setTimeout(requestRender, 0); }
let histOpenId = null, inlineDirty = false;
function hl(raw) {
  raw = String(raw ?? "");
  if (!query) return esc(raw);
  const re = new RegExp("(" + query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
  return raw.split(re).map((p, i) => i % 2 ? "<mark>" + esc(p) + "</mark>" : esc(p)).join("");
}
// 글 속 #태그: 앞이 영문·숫자·/·& 가 아닌 # 뒤의 낱말 (예: "#강의", "기획#프롬프트")
const HASH_RE = /(^|[^A-Za-z0-9/&#])#([0-9A-Za-z가-힣ㄱ-ㆎ_-]*[A-Za-z가-힣ㄱ-ㆎ][0-9A-Za-z가-힣ㄱ-ㆎ_-]*)/g;
function tagText(raw) {
  raw = String(raw ?? ""); let out = "", last = 0;
  raw.replace(HASH_RE, (m, pre, tag, idx) => {
    out += hl(raw.slice(last, idx) + pre);
    out += `<button type="button" class="tag-inline" data-act="tag" data-tag="${esc(tag.slice(0, 30))}" title="#${esc(tag)} 메모만 보기">#${hl(tag)}</button>`;
    last = idx + m.length; return m;
  });
  return out + hl(raw.slice(last));
}
function bodyTags(text) { const set = new Set(); String(text || "").replace(HASH_RE, (m, p, t) => { set.add(t.slice(0, 30)); return m; }); return [...set]; }
function memoTags(m) {
  const out = [...(m.tags || [])];
  bodyTags((m.title || "") + "\n" + (m.body || "")).forEach((t) => { if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t); });
  return out;
}
function richText(raw) {
  const re = /(https?:\/\/[^\s<>"'\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]+)/g, parts = String(raw ?? "").split(re);
  return parts.map((p, i) => {
    if (i % 2 === 0) return tagText(p);
    let url = p, tail = "";
    while (/[.,)\]!?;:]$/.test(url)) { tail = url.slice(-1) + tail; url = url.slice(0, -1); }
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${hl(url)}</a>` + hl(tail);
  }).join("");
}
function attsHTML(m) {
  const atts = (m.attachments || []).filter((a) => !a.inline); if (!atts.length) return "";
  return '<div class="atts">' + atts.map((a) => {
    const c = urlCache.get(a.path), k = kind(a), i = (m.attachments || []).indexOf(a);
    if (k === "image") return c ? `<button type="button" class="att-img" data-act="view" data-i="${i}" aria-label="${esc(a.name)} 크게 보기"><img src="${esc(c.url)}" alt="${esc(a.name)}" loading="lazy"></button>`
      : `<div class="att-ph">${navigator.onLine ? "불러오는 중" : "오프라인"}</div>`;
    if (k === "video" && c) return `<video class="att-video" src="${esc(c.url)}" controls playsinline preload="metadata"></video>`;
    if (k === "audio" && c) return `<audio class="att-audio" src="${esc(c.url)}" controls preload="metadata"></audio>`;
    const href = c ? esc(c.dl || c.url) : "#";
    return `<a class="att-file" href="${href}" target="_blank" rel="noopener"${c ? "" : ' aria-disabled="true"'}>
      <span class="ext">${esc(extOf(a.name) || "file")}</span><span class="fname">${hl(a.name)}</span><span class="fsize">${fmtSize(a.size || 0)}</span></a>`;
  }).join("") + "</div>";
}
function metaHTML(m) {
  const c = ms(m.created_at), u = ms(m.updated_at), edited = u - c > 60000, hist = m.history || [];
  return `<div class="m-meta">
    ${m.pinned ? '<span class="tag">고정</span>' : ""}
    <time datetime="${esc(m.created_at)}" title="${fullStamp(c)}">${dateStr(c)} ${timeStr(c)}</time>
    ${edited ? `<span title="${fullStamp(u)}">· 수정 ${dayKey(u) === dayKey(c) ? "" : dateStr(u) + " "}${timeStr(u)}</span>` : ""}
    ${m._local ? "<span>· 전송 대기</span>" : ""}
    ${hist.length ? `<button type="button" class="hist-btn" data-act="hist" aria-expanded="${histOpenId === m.id}">이전 버전 ${hist.length}</button>` : ""}
  </div>`;
}
function histHTML(m) {
  const hist = m.history || [];
  if (histOpenId !== m.id || !hist.length) return "";
  return `<ol class="hist">${hist.slice().reverse().map((h, ri) => {
    const i = hist.length - 1 - ri, t = ms(h.at);
    const preview = ((h.title ? h.title + " · " : "") + (h.body || "")).replace(/\s+/g, " ").trim() || "(빈 메모)";
    return `<li><span class="h-time">${dateStr(t)} ${timeStr(t)}</span><span class="h-text" title="${esc(preview)}">${esc(preview.length > 60 ? "…" + preview.slice(-60) : preview)}</span>
      <button type="button" class="btn" data-act="restore" data-i="${i}">이 버전으로 되돌리기</button></li>`;
  }).join("")}</ol>`;
}
function memoHTML(m) {
  const checkbox = m.todo ? `<button type="button" class="check" role="checkbox" aria-checked="${!!m.done}" aria-label="완료 표시" data-act="done">${m.done ? ICON.check : ""}</button>` : "";
  if (m.id === editingId) {
    const d = editDraft, files = d.attachments.filter((a) => !a.inline);
    return `<article class="memo editing" data-id="${m.id}"><div class="m-main">
      ${m.title ? `<h3 class="m-title">${esc(m.title)}</h3>` : ""}
      <div class="m-body rich">${viewHTML(m)}</div>
      <p class="edit-help">첨부파일과 할 일 설정을 바꿉니다. 글은 글자를 눌러 바로 고치세요.</p>
      ${(files.length || d.newFiles.length) ? `<div class="edit-att">
        ${files.map((a) => `<button type="button" class="chip${d.removed.has(a.path) ? " removed" : ""}" data-act="e-rm" data-path="${esc(a.path)}" title="누르면 첨부 빼기/되살리기"><span>${esc(a.name)}</span>✕</button>`).join("")}
        ${d.newFiles.map((it) => `<button type="button" class="chip" aria-pressed="true" data-act="e-rmnew" data-key="${it.key}"><span>+ ${esc(it.name)}</span>✕</button>`).join("")}
      </div>` : ""}
      <div class="confirm">
        <button type="button" class="chip" data-act="e-add">파일 추가</button>
        <button type="button" class="chip" data-act="e-todo" aria-pressed="${d.todo}">할 일</button>
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="e-cancel">취소</button>
        <button type="button" class="btn primary" data-act="e-save">${d.saving ? "올리는 중" : "저장"}</button>
      </div></div></article>`;
  }
  const inline = m.id === inlineId;
  const text = inline
    ? `<input class="in-title" type="text" maxlength="120" placeholder="제목 (선택)" value="${esc(m.title || "")}">
       ${toolsHTML()}
       <div class="m-body rich editor in-body" contenteditable="true" role="textbox" aria-multiline="true" aria-label="메모 내용" data-ph="내용">${editHTML(m)}</div>
       ${tagEditorHTML(m.tags || [])}`
    : `${m.title ? `<h3 class="m-title editable">${tagText(m.title)}</h3>` : ""}
       <div class="m-body rich editable" data-ph="${m.title || (m.attachments || []).length ? "눌러서 내용 추가" : ""}">${viewHTML(m)}</div>
       ${(m.tags || []).length ? `<div class="tags">${m.tags.map((t) => `<button type="button" class="tag-chip view" data-act="tag" data-tag="${esc(t)}" title="#${esc(t)} 메모만 보기">#${hl(t)}</button>`).join("")}</div>` : ""}`;
  return `<article class="memo${m.pinned ? " pinned" : ""}${m.todo && m.done ? " done" : ""}${m._local ? " unsynced" : ""}${inline ? " inline" : ""}" data-id="${m.id}">
    ${checkbox}
    <div class="m-main">
      ${text}
      ${attsHTML(m)}
      ${metaHTML(m)}
      ${histHTML(m)}
      ${confirmId === m.id ? `<div class="confirm"><span>이 메모${(m.attachments || []).length ? "와 첨부파일" : ""}을 삭제할까요?</span>
        <button type="button" class="btn danger" data-act="del-yes">삭제</button>
        <button type="button" class="btn" data-act="del-no">취소</button></div>` : ""}
    </div>
    <div class="m-actions">
      <button type="button" data-act="pin" class="${m.pinned ? "on" : ""}" aria-label="${m.pinned ? "고정 해제" : "고정"}" title="${m.pinned ? "고정 해제" : "고정"}">${ICON.pin}</button>
      <button type="button" data-act="toidea" aria-label="소재함으로 보내기" title="소재함으로 보내기">${ICON.idea}</button>
      <button type="button" data-act="edit" aria-label="첨부·할 일 편집" title="첨부·할 일 편집">${ICON.edit}</button>
      <button type="button" data-act="del" aria-label="삭제" title="삭제">${ICON.del}</button>
    </div></article>`;
}
function matches(m, q) {
  if (!q) return true;
  const tags = memoTags(m).map((t) => t.toLowerCase());
  if (q.startsWith("#")) { const t = q.slice(1); return !t || tags.some((x) => x.startsWith(t)); }
  return tags.some((x) => x.includes(q)) || (m.title || "").toLowerCase().includes(q) || (m.body || "").toLowerCase().includes(q) ||
    (m.attachments || []).some((a) => (a.name || "").toLowerCase().includes(q));
}
function render() {
  if (!uid) return;
  syncViewChrome();
  if (view === "ideas") { renderIdeas(); return; }
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
  renderTagBar();
  ensureUrls(list);
  applyClips();
}

/* ---------------- 아주 긴 메모 접기 ---------------- */
// 본문이 LONG_PX보다 길면 윗부분(CLIP_PX)만 보이게 접어 둡니다. 펼친 메모는 이 기기에 기억합니다.
const LONG_PX = 560, CLIP_PX = 220;
let openLong = new Set(lsGet("memo-open-long", []));
function applyClips() {
  document.querySelectorAll("#list .memo:not(.inline):not(.editing)").forEach((art) => {
    const b = art.querySelector(".m-body.editable"); if (!b) return;
    let btn = art.querySelector(".clip-btn");
    const long = !(query && !query.startsWith("#")) && b.scrollHeight > LONG_PX;   // 글자 검색 중에는 찾은 글자가 가려지지 않게 모두 펼침
    if (!long) { b.classList.remove("long", "clipped"); if (btn) btn.remove(); return; }
    const open = openLong.has(art.dataset.id);
    b.classList.add("long"); b.classList.toggle("clipped", !open);
    b.style.setProperty("--clip", CLIP_PX + "px");
    if (!btn) { btn = document.createElement("button"); btn.type = "button"; btn.className = "clip-btn"; btn.dataset.act = "clip"; b.after(btn); }
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "접기 ▴" : "펼쳐서 전체 보기 ▾";
  });
}
function toggleClip(art) {
  const id = art.dataset.id, opening = !openLong.has(id);
  opening ? openLong.add(id) : openLong.delete(id);
  lsSet("memo-open-long", [...openLong]);
  applyClips();
  if (!opening && art.getBoundingClientRect().top < 0) art.scrollIntoView({ block: "start", behavior: "smooth" });
}
let clipTimer = null;
const clipSoon = () => { clearTimeout(clipTimer); clipTimer = setTimeout(applyClips, 120); };
$("#list").addEventListener("load", (e) => { if (e.target.tagName === "IMG") clipSoon(); }, true);   // 이미지가 늦게 뜨면 길이 다시 재기
window.addEventListener("resize", clipSoon);

/* ---------------- 이전 버전 기록 ---------------- */
const snap = (m) => ({ title: m.title || "", body: m.body || "", html: m.html || "", tags: (m.tags || []).slice(), at: m.updated_at });
const tagKey = (t) => JSON.stringify(t || []);
function withHistory(m, before) {
  const h = (m.history || []).slice(), last = h[h.length - 1];
  if (!last || last.title !== before.title || last.body !== before.body || (last.html || "") !== (before.html || "") || tagKey(last.tags) !== tagKey(before.tags)) h.push(before);
  return h.slice(-HISTORY_MAX);
}
function saveMemo(m, patch) {
  Object.assign(m, patch, { _local: true }); saveCache();
  queue({ op: "upsert", row: stripLocal(m) });
}
function stripLocal(m) { const { _local, ...r } = m; return r; }

/* ---------------- 바로 수정(인라인) ---------------- */
function startInline(m, focusTitle, pt) {
  if (editingId) return;
  if (inlineId && inlineId !== m.id) finishInline();
  inlineId = m.id; confirmId = null; inlineDirty = false;
  inlineBase = snap(m);
  render();
  const art = document.querySelector(`.memo[data-id="${m.id}"]`); if (!art) return;
  const el = art.querySelector(focusTitle ? ".in-title" : ".in-body"); if (!el) return;
  el.focus({ preventScroll: true });
  if (focusTitle) { const n = el.value.length; el.setSelectionRange(n, n); return; }
  let r = pt && document.caretRangeFromPoint ? document.caretRangeFromPoint(pt.x, pt.y) : null;
  if (!r || !el.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(el); r.collapse(false); }
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
function inlineSaveNow() {
  clearTimeout(inlineTimer); inlineTimer = null;
  const m = memos.find((x) => x.id === inlineId); if (!m || !inlineDirty) return;
  saveMemo(m, { updated_at: new Date().toISOString() });
}
function finishInline() {
  if (!inlineId) return;
  const tin = document.querySelector(".memo.inline .tag-input"); if (tin && tin.value.trim()) addTagFrom(tin);
  const m = memos.find((x) => x.id === inlineId), base = inlineBase, dirty = inlineDirty;
  clearTimeout(inlineTimer); inlineTimer = null;
  inlineId = null; inlineBase = null; inlineDirty = false; pendingRender = false;
  document.querySelectorAll(".pop.open").forEach((p) => p.classList.remove("open"));
  if (!m) { softRender(); return; }
  m.title = (m.title || "").trim();
  const changedNow = dirty && (m.title !== base.title || (m.body || "") !== base.body || (m.html || "") !== base.html || tagKey(m.tags) !== tagKey(base.tags));
  if (changedNow) {
    saveMemo(m, { history: withHistory(m, base), updated_at: new Date().toISOString() });
    const id = m.id;
    toast("수정했습니다", "되돌리기", () => {
      const mm = memos.find((x) => x.id === id); if (!mm) return;
      if (inlineId === id) { inlineId = null; inlineBase = null; clearTimeout(inlineTimer); }
      saveMemo(mm, { title: base.title, body: base.body, html: base.html, tags: base.tags, history: withHistory(mm, snap(mm)), updated_at: new Date().toISOString() });
      render(); toast("수정 전으로 되돌렸습니다");
    });
  } else if (dirty) saveMemo(m, {});
  softRender();
}
$("#list").addEventListener("input", (e) => {
  if (!inlineId || !e.target.closest || !e.target.closest(".memo.inline")) return;
  const m = memos.find((x) => x.id === inlineId); if (!m) return;
  inlineDirty = true;
  if (e.target.classList.contains("in-title")) m.title = e.target.value;
  const ed = e.target.closest(".in-body");
  if (ed) { m.html = storeHTML(ed); m.body = textOf(ed); }
  clearTimeout(inlineTimer); inlineTimer = setTimeout(inlineSaveNow, 1000);   // 1초 쉬면 자동 저장
});
// 다른 곳을 누르면 수정 끝
document.addEventListener("pointerdown", (e) => {
  pointerDown = true;
  if (inlineId && e.target.closest && !e.target.closest(".memo.inline, .toast, dialog")) finishInline();
}, true);
const afterPointerQ = [];
const afterPointer = (fn) => { if (pointerDown) afterPointerQ.push(fn); else setTimeout(fn, 0); };
document.addEventListener("pointerup", () => {
  pointerDown = false;
  if (renderAfterPointer) { renderAfterPointer = false; setTimeout(requestRender, 0); }
  while (afterPointerQ.length) setTimeout(afterPointerQ.shift(), 0);
}, true);
document.addEventListener("pointercancel", () => { pointerDown = false; while (afterPointerQ.length) setTimeout(afterPointerQ.shift(), 0); }, true);
// 입력창 도구는 클릭이 끝난 뒤에 접어서, 화면이 밀려 클릭이 빗나가지 않게 합니다
$("#composer").addEventListener("focusin", () => $("#composer").classList.add("active"));
$("#composer").addEventListener("focusout", () => afterPointer(() => {
  if (!$("#composer").contains(document.activeElement)) $("#composer").classList.remove("active");
}));
$("#list").addEventListener("focusout", (e) => {
  if (!inlineId || !document.hasFocus()) return;   // 파일 선택 창이 열린 경우는 계속 수정 중
  const art = e.target.closest(".memo.inline"); if (!art) return;
  if (e.relatedTarget && art.contains(e.relatedTarget)) return;
  setTimeout(() => { if (inlineId && !document.activeElement.closest(".memo.inline") && document.hasFocus() && !pointerDown) finishInline(); }, 0);
});
$("#list").addEventListener("keydown", (e) => {
  if (!inlineId || !e.target.closest(".memo.inline")) return;
  if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); e.target.blur(); finishInline(); }
  if (e.key === "Enter" && e.target.classList.contains("in-title") && !e.isComposing) { e.preventDefault(); e.target.closest(".memo").querySelector(".in-body").focus(); }
});
window.addEventListener("pagehide", () => { if (inlineId) inlineSaveNow(); flushDeletes(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { if (inlineId) inlineSaveNow(); flushDeletes(); } });

/* ---------------- 삭제 되돌리기 ---------------- */
function commitDelete(id) {
  const p = pendingDeletes.get(id); if (!p) return;
  clearTimeout(p.timer); pendingDeletes.delete(id);
  queue({ op: "delete", id, paths: (p.memo.attachments || []).map((a) => a.path) });
}
function flushDeletes() { [...pendingDeletes.keys()].forEach(commitDelete); }

/* ---------------- 목록 동작 ---------------- */
$("#list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  const fileLink = e.target.closest('.att-file[aria-disabled="true"]');
  if (fileLink) { e.preventDefault(); toast(navigator.onLine ? "링크를 준비하고 있습니다" : "오프라인에서는 파일을 열 수 없습니다"); return; }
  if (!btn) {
    if (e.target.closest(".memo.inline")) return;
    const img = e.target.closest(".m-body img");
    if (img && img.src) { $("#viewerImg").src = img.src; $("#viewer").showModal(); return; }
    // 글자를 누르면 바로 수정 (링크·영상·첨부는 그대로)
    if (e.target.closest("a, video, .atts, .hist, .confirm")) return;
    const clipped = e.target.closest(".m-body.clipped");   // 접힌 메모는 누르면 먼저 펼침
    if (clipped) { if (!String(getSelection()).length) toggleClip(clipped.closest("[data-id]")); return; }
    const ed = e.target.closest(".editable"); if (!ed) return;
    if (String(getSelection()).length) return;   // 글자를 드래그해 복사하는 중
    const mm = memos.find((x) => x.id === ed.closest("[data-id]").dataset.id);
    if (mm) startInline(mm, ed.classList.contains("m-title"), { x: e.clientX, y: e.clientY });
    return;
  }
  const art = btn.closest("[data-id]"); if (!art) return;
  const id = art.dataset.id, m = memos.find((x) => x.id === id); if (!m) return;
  const act = btn.dataset.act;
  if (act === "clip") { toggleClip(art); return; }
  if (act === "view") { const a = m.attachments[+btn.dataset.i], c = a && urlCache.get(a.path); if (c) { $("#viewerImg").src = c.url; $("#viewer").showModal(); } return; }
  if (act === "done") { saveMemo(m, { done: !m.done }); return render(); }
  if (act === "pin") { saveMemo(m, { pinned: !m.pinned }); return render(); }
  if (act === "del") { confirmId = id; return render(); }
  if (act === "del-no") { confirmId = null; return render(); }
  if (act === "del-yes") {
    confirmId = null; memos = memos.filter((x) => x.id !== id); saveCache(); render();
    pendingDeletes.set(id, { memo: m, timer: setTimeout(() => commitDelete(id), 7000) });
    toast("삭제했습니다", "되돌리기", () => {
      const p = pendingDeletes.get(id); if (!p) return;
      clearTimeout(p.timer); pendingDeletes.delete(id);
      memos.push(p.memo); memos.sort((a, b) => ms(b.created_at) - ms(a.created_at));
      saveCache(); render(); toast("메모를 되살렸습니다");
    }, 7000);
    return;
  }
  if (act === "tag") { setTagFilter(btn.dataset.tag); return; }
  if (act === "hist") { histOpenId = histOpenId === id ? null : id; return render(); }
  if (act === "restore") {
    const h = (m.history || [])[+btn.dataset.i]; if (!h) return;
    saveMemo(m, { title: h.title || "", body: h.body || "", html: h.html || "", tags: h.tags || m.tags || [], history: withHistory(m, snap(m)), updated_at: new Date().toISOString() });
    histOpenId = null; render(); toast("이전 버전으로 되돌렸습니다. 방금 내용도 이전 버전에 남아 있습니다.");
    return;
  }
  if (act === "toidea") {
    const text = [m.title || "", m.body || ""].filter(Boolean).join("\n").trim();
    if (!text) { toast("글이 없는 메모는 소재로 보낼 수 없습니다"); return; }
    openIdeaDlg({ mode: "new", text, memoId: m.id, fromMemo: true });
    return;
  }
  if (act === "edit") {
    if (editingId) return;
    editingId = id; confirmId = null;
    editDraft = { todo: !!m.todo, attachments: (m.attachments || []).slice(), removed: new Set(), newFiles: [], saving: false };
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
    if (d.newFiles.length && !navigator.onLine) { toast("파일 추가는 인터넷 연결이 필요합니다."); return; }
    let added = [];
    if (d.newFiles.length) {
      d.saving = true; btn.textContent = "올리는 중";
      try { added = await uploadFiles(id, d.newFiles); }
      catch (err) { toast("올리지 못했습니다: " + err.message); d.saving = false; btn.textContent = "저장"; if (added.length) sb.storage.from(BUCKET).remove(added.map((a) => a.path)); return; }
    }
    const removedPaths = [...d.removed];
    const attachments = d.attachments.filter((a) => !d.removed.has(a.path)).concat(added);
    const changedNow = d.todo !== !!m.todo || removedPaths.length || added.length;
    endEdit();
    if (!changedNow) return;
    saveMemo(m, { todo: d.todo, done: d.todo ? !!m.done : false, attachments, updated_at: new Date().toISOString() });
    render();
    if (removedPaths.length && navigator.onLine) sb.storage.from(BUCKET).remove(removedPaths);
  }
});
function endEdit() { editingId = null; editDraft = null; pendingRender = false; render(); }
$("#list").addEventListener("keydown", (e) => {
  if (!editDraft) return;
  if (e.key === "Escape") document.querySelector('[data-act="e-cancel"]')?.click();
});
$("#viewerClose").onclick = () => $("#viewer").close();
$("#viewer").addEventListener("click", (e) => { if (e.target.id === "viewer") $("#viewer").close(); });

/* ---------------- 소재함 (메모에서 뽑은 문장·키워드 모으기) ---------------- */
var ideas = [], boxNames = [], view = "memo", ideaBox = "", ideaEdit = null;
const ideaDeletes = new Map();
function flushIdeaDeletes() { [...ideaDeletes.entries()].forEach(([id, p]) => { clearTimeout(p.timer); ideaDeletes.delete(id); queue({ op: "delete", table: "clips", id }); }); }
window.addEventListener("pagehide", flushIdeaDeletes);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushIdeaDeletes(); });
const DEFAULT_BOXES = ["블로그 소재", "인스타툰 소재", "강의 주제"];
function saveIdeas() { if (uid) { lsSet("memo-ideas-" + uid, ideas); lsSet("memo-boxes-" + uid, boxNames); } }
function allBoxes() {
  const set = [];
  [...DEFAULT_BOXES, ...boxNames, ...ideas.map((x) => x.box)].forEach((b) => { if (b && !set.includes(b)) set.push(b); });
  return set;
}
const IIC = {
  move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  src: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>'
};

/* 화면 전환: 메모 / 소재함 */
function syncViewChrome() {
  const ideasView = view === "ideas";
  $("#composer").hidden = ideasView;
  $("#tagBar").classList.toggle("off-view", ideasView);
  $("#ideaBar").hidden = !ideasView;
  $("#tabMemo").classList.toggle("on", !ideasView); $("#tabMemo").setAttribute("aria-selected", !ideasView);
  $("#tabIdeas").classList.toggle("on", ideasView); $("#tabIdeas").setAttribute("aria-selected", ideasView);
  const active = ideas.filter((x) => !x.used).length;
  $("#ideaCount").textContent = ideas.length ? String(active) : "";
  $("#q").placeholder = ideasView ? "소재 검색" : "메모·파일 이름 검색 (#태그)";
}
function setView(v) {
  if (view === v) return;
  if (inlineId) finishInline();
  query = ""; $("#q").value = "";
  view = v; hideIdeaFab(); window.scrollTo({ top: 0 }); render();
}
$("#tabMemo").addEventListener("click", () => setView("memo"));
$("#tabIdeas").addEventListener("click", () => setView("ideas"));

/* 소재함 그리기 */
function renderIdeas() {
  const q = query.replace(/^#/, "").toLowerCase();
  const boxes = allBoxes();
  if (ideaBox && !boxes.includes(ideaBox)) ideaBox = "";
  const counts = new Map(); ideas.forEach((x) => counts.set(x.box, (counts.get(x.box) || 0) + 1));
  $("#ideaBar").innerHTML =
    `<button type="button" class="tag-filter add strong" data-ideact="write">+ 소재 쓰기</button>` +
    `<button type="button" class="tag-filter${!ideaBox ? " on" : ""}" data-box="">전체<span>${ideas.length}</span></button>` +
    boxes.map((b) => `<button type="button" class="tag-filter${ideaBox === b ? " on" : ""}" data-box="${esc(b)}">${esc(b)}<span>${counts.get(b) || 0}</span></button>`).join("") +
    `<button type="button" class="tag-filter add" data-ideact="newbox">+ 새 함</button>`;
  const list = ideas
    .filter((x) => !ideaBox || x.box === ideaBox)
    .filter((x) => !q || (x.text || "").toLowerCase().includes(q) || (x.note || "").toLowerCase().includes(q) || (x.box || "").toLowerCase().includes(q))
    .sort((a, b) => (a.used === b.used ? ms(b.created_at) - ms(a.created_at) : a.used ? 1 : -1));
  $("#count").textContent = q ? list.length + "/" + ideas.length : ideas.length ? ideas.length + "개" : "";
  const el = $("#list");
  if (!ideas.length) {
    el.innerHTML = `<div class="empty"><strong>아직 모은 소재가 없습니다</strong>메모에서 마음에 드는 문장을 드래그하면 나오는 <b>소재로 보관</b> 버튼을 눌러보세요.<br>위의 <b>+ 소재 쓰기</b>로 바로 적어도 됩니다.</div>`;
    return;
  }
  if (!list.length) { el.innerHTML = '<div class="empty"><strong>이 함에는 아직 소재가 없습니다</strong></div>'; return; }
  const activeN = list.filter((x) => !x.used).length;
  el.innerHTML = `<p class="idea-sum">쓸 소재 <b>${activeN}</b> · 다 쓴 소재 ${list.length - activeN}</p>` + list.map(ideaHTML).join("");
  applyIdeaClips();
}
// 긴 소재는 윗부분만 보이게 접기 (펼친 소재는 이 기기에 기억)
const IDEA_LONG = 210, IDEA_CLIP = 130;
let openIdeas = new Set(lsGet("memo-open-ideas", []));
function applyIdeaClips() {
  document.querySelectorAll("#list .idea").forEach((card) => {
    const t = card.querySelector(".idea-text"); if (!t) return;
    let btn = card.querySelector(".idea-clip");
    const long = !query && t.scrollHeight > IDEA_LONG;   // 검색 중에는 찾은 글자가 가려지지 않게 모두 펼침
    if (!long) { t.classList.remove("clipped"); if (btn) btn.remove(); return; }
    const open = openIdeas.has(card.dataset.iid);
    t.classList.toggle("clipped", !open); t.style.setProperty("--clip", IDEA_CLIP + "px");
    if (!btn) { btn = document.createElement("button"); btn.type = "button"; btn.className = "clip-btn idea-clip"; btn.dataset.ideact = "clip"; t.after(btn); }
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "접기 ▴" : "펼쳐서 전체 보기 ▾";
  });
}
function toggleIdeaClip(card) {
  const id = card.dataset.iid, opening = !openIdeas.has(id);
  opening ? openIdeas.add(id) : openIdeas.delete(id);
  lsSet("memo-open-ideas", [...openIdeas]);
  applyIdeaClips();
  if (!opening && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "start", behavior: "smooth" });
}
window.addEventListener("resize", () => { if (view === "ideas") applyIdeaClips(); });
function ideaHTML(x) {
  const src = x.memo_id && memos.find((m) => m.id === x.memo_id);
  const t = ms(x.created_at);
  return `<article class="idea${x.used ? " off" : ""}${x._local ? " unsynced" : ""}" data-iid="${x.id}">
    <div class="idea-main">
      <blockquote class="idea-text">${hl(x.text).replace(/\n/g, "<br>")}</blockquote>
      ${x.note ? `<p class="idea-note">${hl(x.note)}</p>` : ""}
      <div class="idea-meta">
        <span class="idea-box">${esc(x.box)}</span>
        <time title="${fullStamp(t)}">${dateStr(t)}</time>
        ${src ? `<button type="button" class="idea-src" data-ideact="src">${IIC.src}원문 보기</button>` : x.memo_id ? '<span class="idea-gone">원문 메모 삭제됨</span>' : ""}
      </div>
    </div>
    <div class="idea-actions">
      <button type="button" class="switch" role="switch" aria-checked="${!x.used}" data-ideact="toggle" title="${x.used ? "다 쓴 소재 (누르면 다시 활성)" : "쓸 소재 (다 쓰면 끄기)"}" aria-label="${x.used ? "비활성 소재" : "활성 소재"}"><span></span></button>
      <div class="idea-btns">
        <button type="button" data-ideact="move" title="이동" aria-label="다른 함이나 메모로 이동">${IIC.move}</button>
        <button type="button" data-ideact="copy" title="복사" aria-label="복사">${IIC.copy}</button>
        <button type="button" data-ideact="edit" title="수정" aria-label="수정">${ICON.edit}</button>
        <button type="button" data-ideact="del" title="삭제" aria-label="삭제">${ICON.del}</button>
      </div>
    </div>
  </article>`;
}
function saveIdea(x, patch) {
  Object.assign(x, patch, { _local: true }); saveIdeas();
  const { _local, ...row } = x;
  queue({ op: "upsert", table: "clips", row });
}
function addBox(name) {
  name = String(name || "").trim().slice(0, 20);
  if (!name) return "";
  if (!allBoxes().includes(name)) { boxNames.push(name); saveIdeas(); queue({ op: "box", name }); }
  return name;
}

$("#ideaBar").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.ideact === "newbox") { openIdeaDlg({ mode: "box" }); return; }
  if (b.dataset.ideact === "write") { openIdeaDlg({ mode: "new", text: "", memoId: null }); return; }
  ideaBox = b.dataset.box || ""; render();
});
$("#list").addEventListener("click", (e) => {
  if (view !== "ideas") return;
  const card = e.target.closest(".idea"); if (!card) return;
  if (!e.target.closest("[data-ideact]") && e.target.closest(".idea-text.clipped")) { if (!String(getSelection()).length) toggleIdeaClip(card); return; }
  const b = e.target.closest("[data-ideact]"); if (!b) return;
  if (b.dataset.ideact === "clip") { toggleIdeaClip(card); return; }
  const x = ideas.find((i) => i.id === card.dataset.iid); if (!x) return;
  const act = b.dataset.ideact;
  if (act === "toggle") { saveIdea(x, { used: !x.used, updated_at: new Date().toISOString() }); render(); toast(x.used ? "다 쓴 소재로 흐리게 바꿨습니다" : "다시 쓸 소재로 켰습니다"); }
  if (act === "copy") {
    navigator.clipboard.writeText(x.text).then(() => toast("소재를 복사했습니다"), () => toast("복사하지 못했습니다. 글자를 길게 눌러 복사해 주세요"));
  }
  if (act === "edit") openIdeaDlg({ mode: "edit", idea: x });
  if (act === "move") openMoveDlg(x);
  if (act === "src") {
    const id = x.memo_id; view = "memo"; query = ""; $("#q").value = ""; render();
    const art = document.querySelector(`.memo[data-id="${id}"]`);
    if (art) { art.scrollIntoView({ behavior: "smooth", block: "center" }); art.classList.add("flash"); setTimeout(() => art.classList.remove("flash"), 1800); }
  }
  if (act === "del") {
    ideas = ideas.filter((i) => i.id !== x.id); saveIdeas(); render();
    ideaDeletes.set(x.id, { idea: x, timer: setTimeout(() => { ideaDeletes.delete(x.id); queue({ op: "delete", table: "clips", id: x.id }); }, 7000) });
    toast("소재를 삭제했습니다", "되돌리기", () => {
      const p = ideaDeletes.get(x.id); if (!p) return;
      clearTimeout(p.timer); ideaDeletes.delete(x.id); ideas.push(x); saveIdeas(); render(); toast("소재를 되살렸습니다");
    }, 7000);
  }
});

/* 소재 이동: 다른 함으로 / 메모 목록으로 */
const moveDlg = $("#moveDlg");
let moveTarget = null;
function openMoveDlg(x) {
  moveTarget = x;
  $("#moveWhat").textContent = x.text.length > 60 ? x.text.slice(0, 60) + "…" : x.text;
  $("#moveBoxes").innerHTML = allBoxes().map((b) => b === x.box
    ? `<button type="button" class="move-opt current" disabled>${esc(b)} <small>지금 여기</small></button>`
    : `<button type="button" class="move-opt" data-to="${esc(b)}">${esc(b)}</button>`).join("");
  moveDlg.showModal();
}
$("#moveCancel").addEventListener("click", () => moveDlg.close());
$("#moveBoxes").addEventListener("click", (e) => {
  const b = e.target.closest("[data-to]"); if (!b || !moveTarget) return;
  const x = moveTarget, from = x.box, to = b.dataset.to;
  saveIdea(x, { box: to, updated_at: new Date().toISOString() });
  moveDlg.close(); render();
  toast(`'${to}'(으)로 옮겼습니다`, "되돌리기", () => { saveIdea(x, { box: from, updated_at: new Date().toISOString() }); render(); toast("원래 함으로 되돌렸습니다"); });
});
$("#moveToMemo").addEventListener("click", () => {
  const x = moveTarget; if (!x) return;
  const now = new Date().toISOString(), id = newId();
  const body = x.text + (x.note ? "\n\n" + x.note : "");
  const html = plainToHtml(body);
  const row = { id, user_id: uid, title: "", body, html, tags: [], todo: false, done: false, pinned: false, attachments: [], history: [], created_at: now, updated_at: now };
  memos.unshift({ ...row, _local: true }); saveCache();
  queue({ op: "upsert", row, isNew: true });
  ideas = ideas.filter((i) => i.id !== x.id); saveIdeas();
  ideaDeletes.set(x.id, { idea: x, timer: setTimeout(() => { ideaDeletes.delete(x.id); queue({ op: "delete", table: "clips", id: x.id }); }, 7000) });
  moveDlg.close(); render();
  toast("메모 목록으로 옮겼습니다", "되돌리기", () => {
    const p = ideaDeletes.get(x.id); if (p) { clearTimeout(p.timer); ideaDeletes.delete(x.id); }
    ideas.push(x); saveIdeas();
    memos = memos.filter((m) => m.id !== id); saveCache(); queue({ op: "delete", id, paths: [] });
    render(); toast("옮기기 전으로 되돌렸습니다");
  }, 7000);
});

/* 메모에서 문장을 드래그하면 '소재로 보관' 버튼 */
const ideaFab = $("#ideaFab");
let fabSel = null, fabTimer;
function hideIdeaFab() { ideaFab.hidden = true; fabSel = null; }
function checkSelection() {
  if (view !== "memo") { hideIdeaFab(); return; }
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) { hideIdeaFab(); return; }
  const text = String(sel).replace(/ /g, " ").trim();
  const a = elOf(sel.anchorNode), f = elOf(sel.focusNode);
  const art = a && a.closest(".memo:not(.editing)");
  if (!text || !art || !f || !art.contains(f) || !(a.closest(".m-body, .m-title") && f.closest(".m-body, .m-title"))) { hideIdeaFab(); return; }
  const r = sel.getRangeAt(0).getBoundingClientRect();
  fabSel = { text: text.slice(0, 2000), memoId: art.dataset.id };
  ideaFab.hidden = false;
  const w = ideaFab.offsetWidth || 120, top = Math.min(r.bottom + 10, innerHeight - 56);
  ideaFab.style.top = Math.max(8, top) + "px";
  ideaFab.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
}
document.addEventListener("selectionchange", () => { clearTimeout(fabTimer); fabTimer = setTimeout(checkSelection, 180); });
window.addEventListener("scroll", () => { if (!ideaFab.hidden) checkSelection(); }, { passive: true });
ideaFab.addEventListener("mousedown", (e) => e.preventDefault());   // 선택이 풀리지 않게
ideaFab.addEventListener("click", () => {
  if (!fabSel) return;
  const s = fabSel; hideIdeaFab(); getSelection().removeAllRanges();
  openIdeaDlg({ mode: "new", text: s.text, memoId: s.memoId });
});

/* 보관·수정 창 */
const ideaDlg = $("#ideaDlg");
let dlgState = null;
function openIdeaDlg(st) {
  dlgState = st;
  const box = st.mode === "edit" ? st.idea.box : (ideaBox || lsGet("memo-last-box", DEFAULT_BOXES[0]));
  dlgState.box = allBoxes().includes(box) ? box : DEFAULT_BOXES[0];
  $("#ideaDlgTitle").textContent = st.mode === "edit" ? "소재 수정" : st.mode === "box" ? "새 소재함 만들기" : st.text ? "소재로 보관" : "소재 직접 쓰기";
  $("#ideaTextWrap").hidden = st.mode === "box";
  $("#ideaMoveRow").hidden = !st.fromMemo;
  if (st.fromMemo) {
    const mm = memos.find((x) => x.id === st.memoId), hasFiles = mm && (mm.attachments || []).length > 0;
    $("#ideaMove").checked = !hasFiles;
    $("#ideaMoveHint").textContent = hasFiles ? "이 메모에는 사진·파일이 있어 메모 목록에 남겨 두기를 권합니다. 소재함에는 글만 옮겨집니다." : "끄면 메모 목록에도 그대로 남습니다.";
  }
  $("#ideaNoteWrap").hidden = st.mode === "box";
  $("#ideaBoxPick").hidden = st.mode === "box";
  $("#ideaText").value = st.mode === "edit" ? st.idea.text : (st.text || "");
  $("#ideaNote").value = st.mode === "edit" ? (st.idea.note || "") : "";
  $("#newBoxRow").hidden = st.mode !== "box";
  $("#newBoxInput").value = "";
  $("#ideaSave").textContent = st.mode === "edit" ? "저장" : st.mode === "box" ? "만들기" : "보관";
  renderBoxPick();
  ideaDlg.showModal();
  setTimeout(() => (st.mode === "box" ? $("#newBoxInput") : st.text ? $("#ideaNote") : $("#ideaText")).focus(), 50);
}
function renderBoxPick() {
  $("#ideaBoxPick").innerHTML = allBoxes().map((b) => `<button type="button" class="chip" aria-pressed="${dlgState.box === b}" data-pick="${esc(b)}">${esc(b)}</button>`).join("") +
    `<button type="button" class="chip add" data-pick="__new">+ 새 함</button>`;
}
$("#ideaBoxPick").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pick]"); if (!b) return;
  if (b.dataset.pick === "__new") { $("#newBoxRow").hidden = false; $("#newBoxInput").focus(); return; }
  dlgState.box = b.dataset.pick; renderBoxPick();
});
function commitNewBox() {
  const n = addBox($("#newBoxInput").value); if (!n) return false;
  dlgState.box = n; $("#newBoxInput").value = "";
  if (dlgState.mode !== "box") { $("#newBoxRow").hidden = true; renderBoxPick(); }
  return true;
}
$("#newBoxAdd").addEventListener("click", () => { if (dlgState.mode === "box") { if (commitNewBox()) { ideaDlg.close(); ideaBox = dlgState.box; render(); toast("소재함을 만들었습니다"); } } else commitNewBox(); });
$("#newBoxInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); $("#newBoxAdd").click(); } });
$("#ideaCancel").addEventListener("click", () => ideaDlg.close());
$("#ideaSave").addEventListener("click", () => {
  const st = dlgState; if (!st) return;
  if (st.mode === "box") { $("#newBoxAdd").click(); return; }
  if ($("#newBoxInput").value.trim()) commitNewBox();
  const text = $("#ideaText").value.trim(), note = $("#ideaNote").value.trim();
  if (!text) { toast("소재 내용을 적어주세요"); $("#ideaText").focus(); return; }
  const now = new Date().toISOString();
  lsSet("memo-last-box", st.box);
  if (st.mode === "edit") {
    saveIdea(st.idea, { text, note, box: st.box, updated_at: now });
    ideaDlg.close(); render(); toast("소재를 수정했습니다"); return;
  }
  const moving = st.fromMemo && $("#ideaMove").checked;
  const x = { id: newId(), user_id: uid, memo_id: moving ? null : (st.memoId || null), box: st.box, text, note, used: false, created_at: now, updated_at: now };
  ideas.unshift(x); saveIdea(x, {});
  ideaDlg.close();
  if (moving) {
    const mm = memos.find((y) => y.id === st.memoId);
    if (mm) {
      if (inlineId === mm.id) { inlineId = null; inlineBase = null; clearTimeout(inlineTimer); }
      memos = memos.filter((y) => y.id !== mm.id); saveCache();
      pendingDeletes.set(mm.id, { memo: mm, timer: setTimeout(() => commitDelete(mm.id), 7000) });
      render();
      toast(`'${st.box}'(으)로 옮겼습니다`, "되돌리기", () => {
        const p = pendingDeletes.get(mm.id);
        if (p) { clearTimeout(p.timer); pendingDeletes.delete(mm.id); memos.push(p.memo); memos.sort((a, b) => ms(b.created_at) - ms(a.created_at)); saveCache(); }
        ideas = ideas.filter((i) => i.id !== x.id); saveIdeas(); queue({ op: "delete", table: "clips", id: x.id });
        render(); toast("옮기기 전으로 되돌렸습니다");
      }, 7000);
      return;
    }
  }
  render();
  toast(`'${st.box}'에 보관했습니다`, view === "memo" ? "소재함 보기" : null, () => { ideaBox = st.box; setView("ideas"); });
});

/* ---------------- 맨 위로 버튼 ---------------- */
{
  const btn = $("#toTop");
  const sync = () => { btn.hidden = window.scrollY < 500; };
  window.addEventListener("scroll", sync, { passive: true });
  btn.addEventListener("click", () => {
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  });
  sync();
}

/* ---------------- 검색 ---------------- */
$("#q").addEventListener("input", (e) => { query = e.target.value.trim(); render(); });

/* ---------------- 내보내기 ---------------- */
function exportText() {
  return [...memos].sort((a, b) => ms(b.created_at) - ms(a.created_at)).map((m) => {
    const c = ms(m.created_at), u = ms(m.updated_at);
    const tags = [m.pinned ? "[고정]" : "", m.todo ? (m.done ? "[완료]" : "[할 일]") : ""].filter(Boolean).join(" ");
    const head = "■ " + fullStamp(c) + (u - c > 60000 ? " (수정 " + fullStamp(u) + ")" : "") + (tags ? " " + tags : "");
    const files = (m.attachments || []).map((a) => "  첨부: " + a.name + " (" + fmtSize(a.size || 0) + ")").join("\n");
    const tg = (m.tags || []).length ? "태그: " + m.tags.map((t) => "#" + t).join(" ") : "";
    return [head, m.title ? "제목: " + m.title : "", m.body, tg, files].filter(Boolean).join("\n");
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

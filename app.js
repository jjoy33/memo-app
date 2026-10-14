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
}

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
    const ed = e.target.closest(".editable"); if (!ed) return;
    if (String(getSelection()).length) return;   // 글자를 드래그해 복사하는 중
    const mm = memos.find((x) => x.id === ed.closest("[data-id]").dataset.id);
    if (mm) startInline(mm, ed.classList.contains("m-title"), { x: e.clientX, y: e.clientY });
    return;
  }
  const art = btn.closest("[data-id]"); if (!art) return;
  const id = art.dataset.id, m = memos.find((x) => x.id === id); if (!m) return;
  const act = btn.dataset.act;
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

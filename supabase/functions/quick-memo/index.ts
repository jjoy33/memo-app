// 수진쌤 메모 — 아이폰 단축어에서 보낸 내용을 새 메모로 저장하는 함수 (v2: 이미지 + 글 + 링크)
// 호출: POST https://<프로젝트>.supabase.co/functions/v1/quick-memo
//   헤더  Authorization: Bearer <anon 공개 키>
//         x-upload-key: <업로드 전용 키>   (코드에는 키의 해시만 있습니다)
//   본문  ① 이미지·영상 파일 그대로 (또는 multipart 의 file 항목, 선택: text 항목)  → #캡처
//         ② JSON {"text": "..."}  또는 multipart 의 text 항목만, 또는 text/plain  → 글·링크 메모
//            - 글이 주소(URL) 하나뿐이면 페이지 제목·설명·대표 이미지를 가져와 링크 카드로 저장 (#링크 / #인스타 / #유튜브)
//            - 카톡에서 복사한 대화 형식이면 #카톡, 그 밖의 글은 #발췌
//            - 선택: "tag" 값을 주면 그 태그를 추가로 붙임
// 이 키로는 메모를 "올리기"만 할 수 있고, 읽기·수정·삭제는 할 수 없습니다.
import { createClient } from "npm:@supabase/supabase-js@2";

const KEY_SHA256 = "5dc02b75e11b5fd9613fc6ddd2ad538a62320a1e385813636e33dd6e2f0e7649";
const OWNER_ID = "e828a7b9-67aa-42b8-9be4-e84e4cd8036e";
const BUCKET = "memo-files";
const MAX = 50 * 1024 * 1024;
const MAX_TEXT = 200_000;
const THUMB_MAX = 5 * 1024 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const pad = (n: number) => String(n).padStart(2, "0");
const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/quicktime": "mov",
};
function stampName(prefix: string, ext: string, now: Date) {
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  return `${prefix}_${k.getUTCFullYear()}${pad(k.getUTCMonth() + 1)}${pad(k.getUTCDate())}_${pad(k.getUTCHours())}${pad(k.getUTCMinutes())}${pad(k.getUTCSeconds())}.${ext}`;
}
const newPath = (id: string, ext: string) => `${OWNER_ID}/${id}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.${ext}`;
const cleanTag = (t: string) => t.replace(/^#/, "").replace(/[\s#]+/g, "").slice(0, 30);

/* ---------- 링크 미리보기 (제목·설명·대표 이미지) ---------- */
const URL_ONLY = /^(https?:\/\/\S+)$/i;
const URL_ANY = /https?:\/\/[^\s<>"']+/i;
function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (m, g: string) => {
    const l = g.toLowerCase();
    if (l === "amp") return "&"; if (l === "lt") return "<"; if (l === "gt") return ">";
    if (l === "quot") return '"'; if (l === "apos" || l === "#39") return "'";
    const n = l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  });
}
function meta(html: string, keys: string[]) {
  for (const k of keys) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, "i");
    const m = html.match(re1) || html.match(re2);
    if (m && m[1].trim()) return decodeEntities(m[1].trim());
  }
  return "";
}
async function fetchWithTimeout(url: string, ua: string, ms = 7000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { redirect: "follow", signal: ac.signal, headers: { "user-agent": ua, "accept-language": "ko,en;q=0.8" } });
  } finally { clearTimeout(t); }
}
type Preview = { title: string; desc: string; image: string; site: string };
async function preview(url: string): Promise<Preview> {
  const out: Preview = { title: "", desc: "", image: "", site: "" };
  // 일반 브라우저처럼 먼저 요청하고, 제목을 못 얻으면 링크 미리보기용 봇으로 한 번 더 시도 (인스타는 보통 두 번째에서 열림)
  const uas = [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  ];
  for (const ua of uas) {
    try {
      const res = await fetchWithTimeout(url, ua);
      if (!res.ok || !(res.headers.get("content-type") || "").includes("html")) continue;
      const html = (await res.text()).slice(0, 600_000);
      const title = meta(html, ["og:title", "twitter:title"]) ||
        decodeEntities((html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").trim());
      const desc = meta(html, ["og:description", "twitter:description", "description"]);
      let image = meta(html, ["og:image:secure_url", "og:image", "twitter:image"]);
      if (image) { try { image = new URL(image, res.url || url).href; } catch { image = ""; } }
      const site = meta(html, ["og:site_name"]);
      if (title && !/^(instagram|login|log in|로그인)$/i.test(title)) return { title, desc, image, site };
      if (!out.title) Object.assign(out, { title, desc, image, site });
    } catch { /* 시간 초과·차단 → 다음 방법 */ }
  }
  return out;
}
async function grabImage(url: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  try {
    const res = await fetchWithTimeout(url, "Mozilla/5.0", 7000);
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!res.ok || !type.startsWith("image/")) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > THUMB_MAX) return null;
    return { bytes, type };
  } catch { return null; }
}
function sourceTag(url: string) {
  let h = ""; try { h = new URL(url).hostname.replace(/^www\./, ""); } catch { /* */ }
  if (/(^|\.)instagram\.com$/.test(h)) return "인스타";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return "유튜브";
  if (/(^|\.)threads\.(net|com)$/.test(h)) return "스레드";
  if (/(^|\.)blog\.naver\.com$/.test(h)) return "블로그";
  return "링크";
}
// 카톡에서 여러 메시지를 복사하면 "[이름] [오후 3:12] 내용" 형식이 됩니다
const KAKAO_COPY = /^\[[^\]\n]{1,40}\] \[(오전|오후|AM|PM) ?\d{1,2}:\d{2}\]/m;

/* ---------- 본 함수 ---------- */
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST로 보내주세요" }, 405);
  const key = req.headers.get("x-upload-key") || new URL(req.url).searchParams.get("key") || "";
  if (!key || (await sha256(key)) !== KEY_SHA256) return json({ ok: false, error: "업로드 키가 맞지 않습니다" }, 401);

  const q = new URL(req.url).searchParams;
  let type = req.headers.get("content-type") || "application/octet-stream";
  let bytes: Uint8Array | null = null, note = "", extraTag = q.get("tag") || "";

  if (type.startsWith("multipart/form-data")) {
    const fd = await req.formData();
    const f = fd.get("file");
    if (f instanceof File && f.size) { bytes = new Uint8Array(await f.arrayBuffer()); type = f.type || "image/png"; }
    note = String(fd.get("text") || fd.get("url") || "");
    extraTag = String(fd.get("tag") || extraTag);
  } else if (type.startsWith("application/json")) {
    const b = await req.json().catch(() => ({}));
    note = String(b.text ?? b.url ?? ""); extraTag = String(b.tag || extraTag);
  } else if (type.startsWith("text/")) {
    note = await req.text();
  } else {
    bytes = new Uint8Array(await req.arrayBuffer());
    note = q.get("text") || "";
  }
  note = note.replace(/\r\n?/g, "\n").trim();
  if (note.length > MAX_TEXT) return json({ ok: false, error: "글이 너무 깁니다 (20만 자까지)" }, 413);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = new Date(), id = crypto.randomUUID(), stamp = now.toISOString();
  const attachments: Record<string, unknown>[] = [];
  const uploaded: string[] = [];
  const tags: string[] = [];
  let html = "", body = "", title = "", kind = "";

  if (bytes && bytes.length) {
    /* ① 캡처 이미지·영상 (기존 방식 그대로) */
    if (bytes.length > MAX) return json({ ok: false, error: "50MB를 넘는 파일입니다" }, 413);
    if (!/^image\/|^video\//.test(type)) type = "image/png";   // 단축어가 형식을 안 붙여 보내는 경우
    const ext = EXT[type] || "png", name = stampName("캡처", ext, now), path = newPath(id, ext);
    const up = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: false });
    if (up.error) return json({ ok: false, error: "저장소 업로드 실패: " + up.error.message }, 500);
    uploaded.push(path);
    attachments.push({ path, name, size: bytes.length, type, inline: true });
    const media = type.startsWith("video/") ? `<video data-path="${path}" data-name="${esc(name)}"></video>` : `<img data-path="${path}" data-name="${esc(name)}">`;
    html = (note ? `<div>${esc(note).replace(/\n/g, "<br>")}</div>` : "") + `<div>${media}</div>`;
    body = note; tags.push("캡처"); kind = "캡처";
  } else if (note && (URL_ONLY.test(note) || (note.length < 400 && URL_ANY.test(note) && note.replace(URL_ANY, "").trim().length < 120))) {
    /* ② 링크 (주소 하나, 또는 짧은 설명 + 주소 — 인스타·유튜브 공유가 보통 이 형태) */
    const url = note.match(URL_ANY)![0].replace(/[),.]+$/, "");
    const extra = note.replace(url, "").trim();
    const p = await preview(url);
    let img = "";
    if (p.image) {
      const g = await grabImage(p.image);
      if (g) {
        const ext = EXT[g.type] || "jpg", name = stampName("링크", ext, now), path = newPath(id, ext);
        const up = await sb.storage.from(BUCKET).upload(path, g.bytes, { contentType: g.type, upsert: false });
        if (!up.error) {
          uploaded.push(path);
          attachments.push({ path, name, size: g.bytes.length, type: g.type, inline: true });
          img = `<div><img data-path="${path}" data-name="${esc(name)}"></div>`;
        }
      }
    }
    const t = p.title.slice(0, 200), d = p.desc.slice(0, 400);
    html = (extra ? `<div>${esc(extra).replace(/\n/g, "<br>")}</div>` : "") +
      `<blockquote class="lc">` +
      (t ? `<div><b>${esc(t)}</b></div>` : "") +
      (d ? `<div>${esc(d).replace(/\n/g, "<br>")}</div>` : "") +
      img +
      `<div><a href="${esc(url)}">${esc(url)}</a></div>` +
      `</blockquote>`;
    body = [extra, t, d, url].filter(Boolean).join("\n");
    tags.push(sourceTag(url)); kind = tags[0];
  } else if (note) {
    /* ③ 글 (웹페이지·문자·카톡에서 고른 부분) */
    html = `<div>${esc(note).replace(/\n/g, "<br>")}</div>`;
    body = note;
    tags.push(KAKAO_COPY.test(note) ? "카톡" : "발췌"); kind = tags[0];
  } else {
    return json({ ok: false, error: "보낸 내용이 비어 있습니다" }, 400);
  }

  const et = cleanTag(extraTag);
  if (et && et !== "카톡정리" && !tags.includes(et)) tags.push(et);   // 카톡정리 탭은 정리 결과 전용이라 여기서는 붙이지 않음
  const tagLine = tags.map((t) => "#" + t).join(" ");
  html += `<div>${esc(tagLine)}</div>`;
  body = (body ? body + "\n" : "") + tagLine;

  const ins = await sb.from("memos").insert({
    id, user_id: OWNER_ID, title, body, html, tags: [], todo: false, done: false, pinned: false,
    attachments, history: [], created_at: stamp, updated_at: stamp,
  });
  if (ins.error) {
    if (uploaded.length) await sb.storage.from(BUCKET).remove(uploaded);
    return json({ ok: false, error: "메모 저장 실패: " + ins.error.message }, 500);
  }
  return json({ ok: true, message: `메모에 저장했어요 (#${kind})`, id });
});

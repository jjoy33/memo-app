// 수진쌤 메모 — 아이폰 단축어에서 보낸 캡처 이미지를 새 메모로 저장하는 함수
// 호출: POST https://<프로젝트>.supabase.co/functions/v1/quick-memo
//   헤더  Authorization: Bearer <anon 공개 키>
//         x-upload-key: <업로드 전용 키>   (코드에는 키의 해시만 있습니다)
//   본문  이미지 파일 그대로 (또는 multipart 의 file 항목, 선택: text 항목)
// 이 키로는 메모를 "올리기"만 할 수 있고, 읽기·수정·삭제는 할 수 없습니다.
import { createClient } from "npm:@supabase/supabase-js@2";

const KEY_SHA256 = "5dc02b75e11b5fd9613fc6ddd2ad538a62320a1e385813636e33dd6e2f0e7649";
const OWNER_ID = "e828a7b9-67aa-42b8-9be4-e84e4cd8036e";
const BUCKET = "memo-files";
const MAX = 50 * 1024 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const pad = (n: number) => String(n).padStart(2, "0");

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST로 보내주세요" }, 405);
  const key = req.headers.get("x-upload-key") || new URL(req.url).searchParams.get("key") || "";
  if (!key || (await sha256(key)) !== KEY_SHA256) return json({ ok: false, error: "업로드 키가 맞지 않습니다" }, 401);

  let bytes: Uint8Array, type = req.headers.get("content-type") || "application/octet-stream", note = "";
  if (type.startsWith("multipart/form-data")) {
    const fd = await req.formData();
    const f = fd.get("file");
    if (!(f instanceof File)) return json({ ok: false, error: "file 항목이 없습니다" }, 400);
    bytes = new Uint8Array(await f.arrayBuffer()); type = f.type || "image/png";
    note = String(fd.get("text") || "");
  } else {
    bytes = new Uint8Array(await req.arrayBuffer());
    note = new URL(req.url).searchParams.get("text") || "";
  }
  if (!bytes.length) return json({ ok: false, error: "이미지가 비어 있습니다" }, 400);
  if (bytes.length > MAX) return json({ ok: false, error: "50MB를 넘는 파일입니다" }, 413);
  if (!/^image\/|^video\//.test(type)) type = "image/png";   // 단축어가 형식을 안 붙여 보내는 경우

  const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov" } as Record<string, string>)[type] || "png";
  const now = new Date(), kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const name = `캡처_${kst.getUTCFullYear()}${pad(kst.getUTCMonth() + 1)}${pad(kst.getUTCDate())}_${pad(kst.getUTCHours())}${pad(kst.getUTCMinutes())}${pad(kst.getUTCSeconds())}.${ext}`;
  const id = crypto.randomUUID();
  const path = `${OWNER_ID}/${id}/${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 7)}.${ext}`;

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const up = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: false });
  if (up.error) return json({ ok: false, error: "저장소 업로드 실패: " + up.error.message }, 500);

  const isVideo = type.startsWith("video/");
  const media = isVideo ? `<video data-path="${path}" data-name="${esc(name)}"></video>` : `<img data-path="${path}" data-name="${esc(name)}">`;
  const text = note.trim();
  const html = (text ? `<div>${esc(text)}</div>` : "") + `<div>${media}</div><div>#캡처</div>`;
  const body = (text ? text + "\n" : "") + "#캡처";
  const stamp = now.toISOString();
  const ins = await sb.from("memos").insert({
    id, user_id: OWNER_ID, title: "", body, html, tags: [], todo: false, done: false, pinned: false,
    attachments: [{ path, name, size: bytes.length, type, inline: true }], history: [], created_at: stamp, updated_at: stamp,
  });
  if (ins.error) { await sb.storage.from(BUCKET).remove([path]); return json({ ok: false, error: "메모 저장 실패: " + ins.error.message }, 500); }
  return json({ ok: true, message: "메모에 저장했어요", id });
});

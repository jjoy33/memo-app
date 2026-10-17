-- 수진쌤 메모 — Supabase 초기 설정
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여넣고 Run 을 누르세요.
-- 여러 번 실행해도 문제없게 작성했습니다.

-- 1) 메모 테이블
create table if not exists public.memos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title       text not null default '',
  body        text not null default '',
  todo        boolean not null default false,
  done        boolean not null default false,
  pinned      boolean not null default false,
  attachments jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists memos_user_created_idx on public.memos (user_id, created_at desc);

-- 2) 본인 메모만 읽고 쓰기 (행 단위 보안, RLS)
alter table public.memos enable row level security;
drop policy if exists "memos_select_own" on public.memos;
drop policy if exists "memos_insert_own" on public.memos;
drop policy if exists "memos_update_own" on public.memos;
drop policy if exists "memos_delete_own" on public.memos;
create policy "memos_select_own" on public.memos for select to authenticated using (user_id = (select auth.uid()));
create policy "memos_insert_own" on public.memos for insert to authenticated with check (user_id = (select auth.uid()));
create policy "memos_update_own" on public.memos for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "memos_delete_own" on public.memos for delete to authenticated using (user_id = (select auth.uid()));

-- 3) 실시간 동기화 켜기 (폰에서 쓴 메모가 PC에 바로 보이게)
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'memos') then
    alter publication supabase_realtime add table public.memos;
  end if;
end $$;

-- 4) 첨부파일 저장소 (비공개, 파일 1개 최대 50MB)
insert into storage.buckets (id, name, public, file_size_limit)
values ('memo-files', 'memo-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- 5) 첨부파일도 본인 폴더(사용자ID/...)만 접근
drop policy if exists "memo_files_select_own" on storage.objects;
drop policy if exists "memo_files_insert_own" on storage.objects;
drop policy if exists "memo_files_update_own" on storage.objects;
drop policy if exists "memo_files_delete_own" on storage.objects;
create policy "memo_files_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'memo-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "memo_files_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'memo-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "memo_files_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'memo-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "memo_files_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'memo-files' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 6) 이전 버전 보관 (v2에서 추가)
alter table public.memos add column if not exists history jsonb not null default '[]'::jsonb;

-- 7) 서식 있는 본문 (v3에서 추가)
alter table public.memos add column if not exists html text not null default '';

-- 8) 태그 (v4에서 추가)
alter table public.memos add column if not exists tags jsonb not null default '[]'::jsonb;

-- 9) 소재에도 서식·이미지·영상·표·파일 (v5.17에서 추가)
alter table public.clips add column if not exists html text not null default '';
alter table public.clips add column if not exists attachments jsonb not null default '[]'::jsonb;

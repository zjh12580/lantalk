-- ============================================================================
-- bootstrap.sql —— 自托管环境的补充初始化（在 schema.sql 之后执行）
-- ----------------------------------------------------------------------------
-- schema.sql 只覆盖业务表（profiles/groups/messages/...），
-- 这里补三样自托管 Supabase 需要、但原平台内置的东西：
--   1. 对象存储 bucket + 访问策略（聊天图片/文件）
--   2. 内置「大厅」群 + 小美的 profile 行（原平台由后台初始化）
--   3. 常用索引与 Realtime 发布（前端轮询为主，Realtime 可选）
--
-- 用法：
--   psql "$DATABASE_URL" -f deploy/bootstrap.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 对象存储
-- ---------------------------------------------------------------------------
-- 私有 bucket，读写都走签名 URL；路径约定 {uid}/chat/...、{uid}/avatar/...
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat', 'chat', false, 52428800, null)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

-- 登录用户可读全部（聊天室里互相看图片）
drop policy if exists chat_objects_select on storage.objects;
create policy chat_objects_select on storage.objects
  for select to authenticated using (bucket_id = 'chat');

-- 只能写自己目录下的对象（第一段路径必须是自己的 uid）
drop policy if exists chat_objects_insert on storage.objects;
create policy chat_objects_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists chat_objects_update on storage.objects;
create policy chat_objects_update on storage.objects
  for update to authenticated
  using (bucket_id = 'chat' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'chat' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists chat_objects_delete on storage.objects;
create policy chat_objects_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'chat' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 2. 内置大厅群
-- ---------------------------------------------------------------------------
-- 小美（机器人）的固定 uuid —— 与前端 BOT.id 对应，不要改
insert into public.groups (id, name, owner_id, announcement, is_hall)
values ('hall', '大厅', null, '欢迎来到大厅，畅所欲言～', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. 索引（消息表按会话 + id 倒序取最新，是最高频查询）
-- ---------------------------------------------------------------------------
create index if not exists messages_conv_id_desc on public.messages (conv, id desc);
create index if not exists messages_sender_idx on public.messages (sender_id);
create index if not exists group_members_user_idx on public.group_members (user_id);
create index if not exists friends_a_idx on public.friends (a);
create index if not exists friends_b_idx on public.friends (b);
create index if not exists games_conv_idx on public.games (conv);
create index if not exists reads_user_idx on public.reads (user_id);

-- ---------------------------------------------------------------------------
-- 4. Realtime（可选）
-- ---------------------------------------------------------------------------
-- 前端以轮询为主，Realtime 非必需。若后续要用 supabase.channel 订阅，
-- 需要把这几张表加入发布：
--   alter publication supabase_realtime add table public.messages, public.games, public.profiles;
-- 自托管镜像默认发布为 supabase_realtime，若不存在会报错，故这里包一层容错。
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.messages;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.games;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.profiles;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

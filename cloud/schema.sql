-- ============================================================================
-- LanTalk 云聊 · 数据库结构
-- ============================================================================
-- 本文件是云端版（cloud/）依赖的完整 DDL：8 张表 + 行级安全（RLS）策略 +
-- 2 个 SECURITY DEFINER 鉴权函数。
--
-- ⚠️ 重要说明
--   本文件按 cloud/index.html 与 cloud/test-load.js 中的**实际字段用法**反推整理，
--   不是从线上数据库导出的。首次在正式环境执行前请务必核对：
--     1. 用线上库导出真实 DDL 对照（尤其默认值、外键、索引、RLS 策略名）
--     2. 确认 auth.uid() 的类型与签名（本文按 uuid 处理）
--   线上库是本文件的**权威来源**，如两者不一致，以线上库为准并回头修正本文件。
--
-- 用法：
--   psql "$DATABASE_URL" -f cloud/schema.sql
-- ============================================================================

-- gen_random_uuid()
create extension if not exists pgcrypto;

-- ============================================================================
-- 1. profiles —— 用户资料
-- ============================================================================
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  nickname    text not null,
  avatar      text default '',                       -- 表情头像（emoji）或图片 URL
  color       text default '#888888',                -- 昵称首字头像的底色
  signature   text default '',                       -- 个性签名
  last_seen   timestamptz default now(),             -- 在线状态心跳
  created_at  timestamptz default now()
);

-- 昵称全服唯一（前端也会校验，这里是权威约束）
create unique index if not exists profiles_nickname_key on public.profiles (nickname);

alter table public.profiles enable row level security;

-- 所有登录用户可读（需要显示对方昵称/头像）
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

-- 只能改自己那行
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ============================================================================
-- 2. groups —— 群（含内置「大厅」）
-- ============================================================================
create table if not exists public.groups (
  id            text primary key,
  name          text not null,
  owner_id      uuid,                                -- 大厅为 system，无 owner
  announcement  text default '',
  color         text default '#07c160',
  is_hall       boolean default false,               -- 内置大厅标记
  created_at    timestamptz default now()
);

alter table public.groups enable row level security;

-- 大厅对所有人可见；普通群仅成员可见
drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups
  for select to authenticated
  using (is_hall = true or public.chat_is_member(id));

-- 任何登录用户可建群（建群后由 group_members 决定可见性）
drop policy if exists groups_insert on public.groups;
create policy groups_insert on public.groups
  for insert to authenticated with check (owner_id = auth.uid());

-- 群主可改名 / 公告 / 解散
drop policy if exists groups_update_owner on public.groups;
create policy groups_update_owner on public.groups
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists groups_delete_owner on public.groups;
create policy groups_delete_owner on public.groups
  for delete to authenticated using (owner_id = auth.uid() and is_hall = false);

-- ============================================================================
-- 3. group_members —— 群成员与免打扰
-- ============================================================================
create table if not exists public.group_members (
  group_id  text not null references public.groups (id) on delete cascade,
  user_id   uuid not null,
  muted     boolean default false,                   -- 消息免打扰
  joined_at timestamptz default now(),
  primary key (group_id, user_id)
);

create index if not exists group_members_user_idx on public.group_members (user_id);

alter table public.group_members enable row level security;

-- 登录用户可读成员表（前端要据此渲染成员列表与 @ 候选）
drop policy if exists group_members_select on public.group_members;
create policy group_members_select on public.group_members
  for select to authenticated using (true);

-- 本人加入 / 退出；群主可增删成员
drop policy if exists group_members_insert on public.group_members;
create policy group_members_insert on public.group_members
  for insert to authenticated
  with check (user_id = auth.uid() or public.chat_is_owner(group_id));

drop policy if exists group_members_update_self on public.group_members;
create policy group_members_update_self on public.group_members
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists group_members_delete on public.group_members;
create policy group_members_delete on public.group_members
  for delete to authenticated
  using (user_id = auth.uid() or public.chat_is_owner(group_id));

-- ============================================================================
-- 4. messages —— 消息
-- ============================================================================
-- conv 命名约定：
--   群聊   'g:<group_id>'（大厅为 'g:hall'，兼容历史值 'hall'）
--   私聊   'p:<uid_a>~<uid_b>'，两个 uid 升序拼接（后端 pconv() 保证顺序无关）
create table if not exists public.messages (
  id             bigserial primary key,
  conv           text not null,
  sender_id      uuid default auth.uid(),
  sender_name    text default '',                    -- 冗余快照，便于渲染
  sender_avatar  text default '',
  sender_color   text default '',
  type           text default 'text',                -- text/image/file/system/game/card
  text           text default '',
  mentions       text[] default '{}',                -- 被 @ 的 uid 列表
  reply_to       jsonb,                              -- 引用消息快照
  file_path      text,                               -- 对象存储路径
  file_name      text,
  file_size      bigint,
  revoked        boolean default false,              -- 撤回标记（2 分钟内）
  created_at     timestamptz default now()
);

create index if not exists messages_conv_id_idx on public.messages (conv, id desc);
create index if not exists messages_sender_idx on public.messages (sender_id);

alter table public.messages enable row level security;

-- 会话参与者可读（非成员读不到）——越权防护的核心
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select to authenticated using (public.chat_can_read(conv));

-- 只能以自己名义发消息，且只能发到自己有权读的会话
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (sender_id = auth.uid() and public.chat_can_read(conv));

-- 只有发送者本人可撤回
drop policy if exists messages_update_self on public.messages;
create policy messages_update_self on public.messages
  for update to authenticated using (sender_id = auth.uid()) with check (sender_id = auth.uid());

-- ============================================================================
-- 5. reads —— 每个会话的已读位置
-- ============================================================================
create table if not exists public.reads (
  conv        text not null,
  user_id     uuid not null,
  last_msg_id bigint not null default 0,
  updated_at  timestamptz default now(),
  primary key (conv, user_id)
);

alter table public.reads enable row level security;

-- 已读位要算「谁读了我的消息」，因此需要可读；写入仅限自己
drop policy if exists reads_select on public.reads;
create policy reads_select on public.reads
  for select to authenticated using (public.chat_can_read(conv));

drop policy if exists reads_upsert_self on public.reads;
create policy reads_upsert_self on public.reads
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists reads_update_self on public.reads;
create policy reads_update_self on public.reads
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================
-- 6. friends —— 好友关系与备注
-- ============================================================================
-- 单边记录即代表双向好友（isFriend / friendRel 都做双向匹配）
create table if not exists public.friends (
  a          uuid not null,
  b          uuid not null,
  status     text not null default 'pending',        -- pending / accepted
  message    text default '',                        -- 申请附言
  remark     text default '',                        -- 备注名
  created_at timestamptz default now(),
  primary key (a, b)
);

create index if not exists friends_b_idx on public.friends (b);

alter table public.friends enable row level security;

-- 关系双方可读
drop policy if exists friends_select on public.friends;
create policy friends_select on public.friends
  for select to authenticated using (a = auth.uid() or b = auth.uid());

-- 发起方必须是本人
drop policy if exists friends_insert_self on public.friends;
create policy friends_insert_self on public.friends
  for insert to authenticated with check (a = auth.uid());

-- 双方都可改（被请求方接受 / 双方改备注）
drop policy if exists friends_update_both on public.friends;
create policy friends_update_both on public.friends
  for update to authenticated
  using (a = auth.uid() or b = auth.uid())
  with check (a = auth.uid() or b = auth.uid());

drop policy if exists friends_delete_both on public.friends;
create policy friends_delete_both on public.friends
  for delete to authenticated using (a = auth.uid() or b = auth.uid());

-- ============================================================================
-- 7. games —— 对局（五子棋 / 围棋 / 象棋）
-- ============================================================================
create table if not exists public.games (
  id           text primary key,
  conv         text not null,                        -- 对局发起的会话
  kind         text not null default 'gomoku',       -- gomoku / go / xiangqi
  host_id      uuid,
  host_name    text default '',
  guest_id     uuid,
  guest_name   text default '',
  status       text default 'waiting',               -- waiting/playing/over/left
  turn         text default 'host',                  -- host / guest
  board        jsonb default '[]'::jsonb,            -- 棋盘状态
  moves        jsonb default '[]'::jsonb,            -- 着法历史
  winner       text default '',
  restart_by   text default '',
  restart_kind text default '',
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index if not exists games_conv_idx on public.games (conv);

alter table public.games enable row level security;

-- 会话参与者可读（邀请卡片要按对局状态实时渲染）
drop policy if exists games_select on public.games;
create policy games_select on public.games
  for select to authenticated using (public.chat_can_read(conv));

drop policy if exists games_insert_host on public.games;
create policy games_insert_host on public.games
  for insert to authenticated
  with check (host_id = auth.uid() and public.chat_can_read(conv));

-- 参与方都可以更新（落子、认输、再来一局）
drop policy if exists games_update_player on public.games;
create policy games_update_player on public.games
  for update to authenticated
  using (host_id = auth.uid() or guest_id = auth.uid())
  with check (host_id = auth.uid() or guest_id = auth.uid());

-- ============================================================================
-- 8. live —— 大厅直播状态（全局同时只允许一条 live）
-- ============================================================================
create table if not exists public.live (
  id           bigserial primary key,
  host_id      uuid,
  host_name    text default '',
  host_avatar  text default '',
  host_color   text default '#888888',
  title        text default '',
  status       text default 'live',                  -- live / ended
  viewers      integer default 0,
  started_at   timestamptz default now()
);

-- 同一时刻只允许一个主播
create unique index if not exists live_one_active on public.live (status) where status = 'live';

alter table public.live enable row level security;

drop policy if exists live_select on public.live;
create policy live_select on public.live
  for select to authenticated using (true);

drop policy if exists live_insert_self on public.live;
create policy live_insert_self on public.live
  for insert to authenticated with check (host_id = auth.uid());

drop policy if exists live_update_self on public.live;
create policy live_update_self on public.live
  for update to authenticated using (host_id = auth.uid()) with check (host_id = auth.uid());

drop policy if exists live_delete_self on public.live;
create policy live_delete_self on public.live
  for delete to authenticated using (host_id = auth.uid());

-- ============================================================================
-- 鉴权函数（SECURITY DEFINER：绕过调用者权限，用于跨用户判断会话归属）
-- ============================================================================
-- ⚠️ 这两个函数是 messages / reads / games 三张表 RLS 策略的基石。
--    它们必须 SECURITY DEFINER，否则在 RLS 内查 group_members / friends 会被自身策略递归拦住。
--    search_path 固定为 public，防search_path 注入。

-- 我是否是某个群的成员
create or replace function public.chat_is_member(gid text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = gid and m.user_id = auth.uid()
  );
$$;

-- 我是否是某个群的群主
create or replace function public.chat_is_owner(gid text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.groups g
    where g.id = gid and g.owner_id = auth.uid()
  );
$$;

-- 我是否有权读某个会话（conv 是 'g:<gid>' 或 'p:<uid_a>~<uid_b>'）
create or replace function public.chat_can_read(conv text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select case
    -- 群聊：我是群成员，或这是大厅
    when conv like 'g:%' then
      public.chat_is_member(substring(conv from 3))
      or substring(conv from 3) = 'hall'
    -- 私聊：我的 uid 出现在会话键里
    when conv like 'p:%' then
      auth.uid()::text = any (string_to_array(substring(conv from 3), '~'))
    -- 兼容历史值：无前缀的 'hall'
    when conv = 'hall' then true
    else false
  end;
$$;

-- 只授执行权，不授底层表权限
revoke all on function public.chat_is_member(text) from public;
revoke all on function public.chat_is_owner(text) from public;
revoke all on function public.chat_can_read(text) from public;
grant execute on function public.chat_is_member(text) to authenticated;
grant execute on function public.chat_is_owner(text) to authenticated;
grant execute on function public.chat_can_read(text) to authenticated;

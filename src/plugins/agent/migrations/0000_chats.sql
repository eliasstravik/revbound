-- The console chat's history: each chat (an eve session id) and the one person who owns it.
create table revbound_agent.chats (
  id text primary key,                 -- eve's session id
  owner text not null,                 -- the creator's principal: "vercel:<user id>" deployed, "local" on a laptop
  title text,                          -- the start of the first message
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index chats_owner_updated on revbound_agent.chats (owner, updated_at desc);

-- mdm: one de-duplicated set of companies, people and signals, the keys they match on, and where each field came from.
-- `keys`, `fields` and `signals` name their record by (record_type, record_id), so a later record type reuses them.
create table revbound_mdm.companies (
  id uuid primary key,
  name text,
  domain text,                         -- the first domain it was matched on; every one is in keys
  linkedin text,
  data jsonb not null default '{}',    -- enriched fields; where each came from is in fields
  merged_into uuid references revbound_mdm.companies(id),  -- set on a record folded into another; its id then finds that one
  merged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table revbound_mdm.people (
  id uuid primary key,
  name text,
  email text,
  linkedin text,
  title text,
  company_id uuid references revbound_mdm.companies(id),  -- where the person works now
  data jsonb not null default '{}',
  merged_into uuid references revbound_mdm.people(id),
  merged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Each normalized key belongs to one record: email, domain, linkedin, or id:<system>.
create table revbound_mdm.keys (
  record_type text not null,
  key text not null,
  value text not null,
  record_id uuid not null,
  source text not null,
  workflow text,
  run_id uuid,                         -- the ledger run that added it
  created_at timestamptz not null default now(),
  primary key (record_type, key, value)
);
-- The latest value of every field written to a record, who wrote it and when.
create table revbound_mdm.fields (
  record_type text not null,
  record_id uuid not null,
  field text not null,
  value jsonb,
  source text not null,
  workflow text,
  run_id uuid,
  set_at timestamptz not null default now(),
  primary key (record_id, field)
);
create table revbound_mdm.signals (
  id uuid primary key,
  record_type text not null,
  record_id uuid not null,
  type text not null,
  key text not null,                   -- with record and type, what makes it the same signal again
  occurred_at timestamptz not null,
  source text not null,
  workflow text,
  run_id uuid,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (record_id, type, key)
);
create index on revbound_mdm.keys (record_id);
create index on revbound_mdm.people (company_id);
create index on revbound_mdm.people (created_at, id);
create index on revbound_mdm.companies (created_at, id);
create index on revbound_mdm.signals (occurred_at, id);
create index on revbound_mdm.signals (type, occurred_at);

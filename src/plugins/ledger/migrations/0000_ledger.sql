-- The ledger: every run Revbound admits or refuses, every metered action, and the reconcile bookkeeping.
create table revbound_ledger.runs (
  id uuid primary key,                 -- Revbound's own run id, created at admit
  sdk_run_id text unique,              -- Workflow SDK run id, set by started() or reconcile
  workflow text not null,
  trigger text not null check (trigger in ('cli','http','cron','webhook','child','external')),
  preview boolean not null default false,
  input_hash text,                     -- sha256 of the RFC 8785 canonical JSON input, computed on the server
  approved_max_usd numeric(12,2),      -- root runs only: --approve cap, or budget.perRunUsd for schedules
  approval_note text,
  approved_by_preview uuid references revbound_ledger.runs(id),
  parent_run_id uuid,
  root_run_id uuid not null,           -- = id for a top-level run
  child_key text unique,               -- '<parent id>:<item index>' for fanOut children
  status text not null check (status in ('admitted','running','completed','failed','cancelled','unknown','refused','start_failed')),
  reason text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create table revbound_ledger.actions (
  id bigserial primary key,
  run_id uuid not null,                -- no foreign key: an external run's row may be created by this insert's caller
  root_run_id uuid not null,
  workflow text not null,
  plugin text not null,
  kind text not null,                  -- e.g. 'model_call', 'paid_api'
  target text,
  keys jsonb not null default '{}',    -- natural keys: {email, domain, linkedin}
  reserved_usd numeric(12,6),
  cost_usd numeric(12,6),              -- null when unmetered or unknown
  outcome text not null check (outcome in ('reserved','ok','failed','blocked','unknown')),
  detail jsonb not null default '{}',  -- no secrets, no personal data beyond keys
  idempotency_key text,
  attempt int not null default 1,      -- a key's attempts: a new row after each failed one
  created_at timestamptz not null default now(),
  unique (idempotency_key, attempt)
);
create table revbound_ledger.meta (key text primary key, value text not null);
insert into revbound_ledger.meta values ('reconcile_at', '-infinity'), ('reconcile_cursor', '-infinity');
create index on revbound_ledger.actions (run_id);
create index on revbound_ledger.actions (root_run_id);
create index on revbound_ledger.actions (workflow, created_at);
create index on revbound_ledger.runs (status, started_at);
create index on revbound_ledger.runs (root_run_id);
create index on revbound_ledger.runs (workflow, input_hash, started_at) where preview and parent_run_id is null;

-- What a run has spent: settled costs, else what is still reserved. Unmetered calls cost nothing and are counted apart.
create view revbound_ledger.run_costs as
select r.id as run_id, r.root_run_id, r.workflow, r.status, r.preview, r.started_at,
  coalesce(sum(coalesce(a.cost_usd, a.reserved_usd)), 0)::numeric(12,6) as cost_usd,
  count(a.id) filter (where a.outcome <> 'blocked') as calls,
  count(a.id) filter (where a.outcome <> 'blocked' and a.cost_usd is null and a.reserved_usd is null) as unmetered,
  sum(coalesce(sum(coalesce(a.cost_usd, a.reserved_usd)), 0)) over (partition by r.root_run_id)::numeric(12,6) as tree_cost_usd
from revbound_ledger.runs r left join revbound_ledger.actions a on a.run_id = r.id
group by r.id;

create view revbound_ledger.spend_by_workflow_month as
select workflow, date_trunc('month', created_at at time zone 'UTC')::date as month,
  coalesce(sum(coalesce(cost_usd, reserved_usd)), 0)::numeric(12,6) as cost_usd,
  count(*) filter (where outcome <> 'blocked') as calls
from revbound_ledger.actions group by 1, 2;

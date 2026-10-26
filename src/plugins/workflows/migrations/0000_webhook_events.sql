-- One row per webhook delivery claimed, so a repeat of the sender's event id runs onEvent once.
create table revbound_workflows.webhook_events (
  hook text not null,
  dedupe_key text not null,
  received_at timestamptz not null default now(),
  outcome text not null check (outcome in ('claimed', 'handled', 'ignored')),
  run_id uuid,
  primary key (hook, dedupe_key)
);

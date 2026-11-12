"use client";
import type { ReactNode } from "react";
import { splitReason } from "revbound/ledger/words";
import { Link, PageHeader, Status, StatusBadge, useApi, When, type ViewProps } from "revbound/ui";

type Run = { id: string; workflow: string; status: string; reason: string | null; startedAt: string; preview: boolean };
type Summary = { attention: Run[]; running: Run[]; recent: Run[]; local: boolean;
  spend: { usd: number; budgetUsd: number | null; workflows: { workflow: string; usd: number; budgetUsd: number | null }[] } };

const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);

/** Spend against a budget: the two amounts and how full it is. */
function Spend({ name, usd, budget }: { name: ReactNode; usd: number; budget: number | null }) {
  return (
    <li>
      <span className="ov-name">{name}</span>
      {budget != null && <meter min={0} max={budget} value={Math.min(usd, budget)} aria-label={`${money(usd)} of ${money(budget)}`} />}
      <span className="numeric">{money(usd)}{budget != null && <span className="muted"> of {money(budget)}</span>}</span>
    </li>
  );
}

/**
 * Overview, the Console's home: what needs a look (workflows whose last run failed, missing keys), what runs now, the
 * last five runs and this month's spend against the budgets. Every row leads to the place that fixes or shows it.
 */
export default function Overview({ manifest }: ViewProps) {
  const has = (path: string) => manifest.views.some((v) => v.path === path);
  const state = useApi<Summary>(has("runs") ? "ledger/summary" : null, (d) => (d.running.length ? 5000 : 30_000)), d = state.data;
  const missing = useApi<{ count: number }>(has("connections") ? "connections/missing" : null, () => 30_000).data?.count ?? 0;
  const starter = useApi<{ starter?: boolean }>(has("context") ? "context" : null).data?.starter;
  const runs = (list: Run[], reason = false) => list.map((r) => (
    <li key={r.id}>
      <Link className="ov-name" href={`/runs?run=${r.id}`}>{r.workflow}</Link>
      {reason && r.reason && <span className="ov-reason muted" title={splitReason(r.reason).message}>{splitReason(r.reason).message}</span>}
      <StatusBadge status={r.status}>{r.preview && " · Preview"}</StatusBadge>
      <span className="muted ov-when"><When at={r.startedAt} /></span>
    </li>
  ));
  return <>
    <PageHeader title="Overview" />
    <div className="page overview">
      {starter && <p className="banner">Your agent knows nothing about the company yet. <Link className="link" href="/context">Tell your agent about the company</Link></p>}
      <Status state={state} />
      {(d || missing > 0) && <section aria-labelledby="ov-attention">
        <h2 id="ov-attention">Needs attention</h2>
        {d?.attention.length || missing ? <ul role="list" className="ov-rows">
          {runs(d?.attention ?? [], true)}
          {missing > 0 && <li><Link className="ov-name" href="/connections">{missing} {missing === 1 ? "key is" : "keys are"} missing</Link><span className="muted ov-when">Add in Connections</span></li>}
        </ul> : <p className="muted">Nothing needs you right now.</p>}
      </section>}
      {d && <>
        <section aria-labelledby="ov-running">
          <h2 id="ov-running">Running now</h2>
          {d.running.length ? <ul role="list" className="ov-rows">{runs(d.running)}</ul> : <p className="muted">Nothing is running.</p>}
        </section>
        <section aria-labelledby="ov-recent">
          <h2 id="ov-recent">Recent runs</h2>
          {d.recent.length ? <ul role="list" className="ov-rows">{runs(d.recent)}</ul> : <p className="muted">No runs yet.</p>}
          {d.recent.length > 0 && <p><Link className="link" href="/runs">All runs</Link></p>}
        </section>
        <section aria-labelledby="ov-spend">
          <h2 id="ov-spend">Spend this month</h2>
          <ul role="list" className="ov-rows">
            <Spend name="All workflows" usd={d.spend.usd} budget={d.spend.budgetUsd} />
            {d.spend.workflows.map((w) => <Spend key={w.workflow} usd={w.usd} budget={w.budgetUsd}
              name={has("workflows") ? <Link href={`/workflows/${encodeURIComponent(w.workflow)}`}>{w.workflow}</Link> : w.workflow} />)}
          </ul>
          {d.local && <p className="muted">Local runs on your own plan aren't priced.</p>}
        </section>
      </>}
    </div>
  </>;
}

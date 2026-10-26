"use client";
import { useApi, type ViewProps } from "revbound/ui";

export default function FixtureView(_: ViewProps) {
  const data = useApi<{ hello: string; notes: number }>("fixture/hello").data;
  return <div><h1>Fixture</h1><p>{data ? `Notes: ${data.notes}` : "Loading…"}</p></div>;
}

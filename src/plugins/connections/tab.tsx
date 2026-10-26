"use client";
import type { TabProps } from "revbound/ui";
import { ConnectionsView } from "./view.js";

/** A workflow's Connections tab: the keys its registry entry lists. */
export default function ConnectionsTab({ workflow }: TabProps) {
  return <ConnectionsView only={workflow.connections ?? null} />;
}

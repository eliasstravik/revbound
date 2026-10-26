"use client";
import type { TabProps } from "revbound/ui";
import { DataView } from "./view.js";

/** A workflow's Data tab: the tables its registry entry lists. */
export default function DataTab({ workflow }: TabProps) {
  return <DataView tables={workflow.tables ?? []} />;
}

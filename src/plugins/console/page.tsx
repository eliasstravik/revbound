"use client";
import { notFound } from "next/navigation.js";
import { Suspense, type ComponentType } from "react";
import type { Manifest } from "revbound";
import { find } from "revbound/kit";
import type { TabProps, ViewProps } from "revbound/ui";
import { home } from "./shell.js";

/**
 * The console page for a path: the most specific view whose pattern matches (a fixed segment beats a parameter), the
 * home view at `/`, and Next's 404 for anything else.
 */
export default function Console({ manifest, views, tabs, path }: {
  manifest: Manifest; views: Record<string, ComponentType<ViewProps>>; tabs: Record<string, ComponentType<TabProps>>; path: string[];
}) {
  const hit = path.length ? find(manifest.views, path) : (() => { const v = home(manifest.views); return v && { item: v, params: {} }; })();
  const View = hit && views[hit.item.path];
  if (!hit || !View) notFound();
  // Suspense because the views read the query string, which is only known in the browser on static pages.
  return <Suspense><View params={hit.params} manifest={manifest} tabs={tabs} /></Suspense>;
}

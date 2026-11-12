/** The console's shared UI kit for plugin views: data loading, links, status lines, menus, Markdown, and the page parts
 * every list shares (header, toolbar, table, status badge, empty state). */
import type { ComponentType } from "react";
import type { About, Manifest, RegistryInfo } from "../core/types.js";

export { api, apiUrl, clock, duration, Link, OFFLINE, retryAll, vercelUrl, Search, Status, time, useApi, useQuery } from "./load.js";
export { Count, DataTable, EmptyState, PageHeader, Refresh, refreshCounts, StatusBadge, Toolbar, When, type Column } from "./parts.js";
export { ago, cronWords, isActive, keyName, needsLook, statusOf, usd } from "./words.js";
export { glyphs, Icon, Menu, place } from "./menu.js";
export { EnvironmentBadge, onReleaseSettled, releaseStarted, type Release } from "./environment.js";
export { Markdown } from "./markdown.js";

/** A workflow as the Workflows routes describe it to views and tabs. */
export type WorkflowInfo = { name: string; cron: string | null; file: string | null; sourceUrl: string | null } & About & RegistryInfo;
/** What a workflow tab gets. */
export type TabProps = { workflow: WorkflowInfo; manifest: Manifest };
/** What a view gets: its path parameters, the manifest and the workflow tabs (for a page that shows them). */
export type ViewProps = { params: Record<string, string>; manifest: Manifest; tabs: Record<string, ComponentType<TabProps>> };

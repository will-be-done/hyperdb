import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { css, setup, styled } from "goober";
import { DBProvider, useSyncSelector } from "../react";
import type { SubscribableDB } from "../hyperdb/runtime/subscribable-db";
import {
  getTraceDBInfo,
  hyperDBTraceStore,
  safeSerialize,
  unassignedTraceDBKey,
  type MutationEvent,
  type MutationEventKind,
  type RootTrace,
  type SelectCommandEvent,
  type TraceSortDir,
  type TraceSortField,
  type TraceDBInfo,
  type TraceFrame,
  type TraceStatus,
} from "../hyperdb/tracing/store";
import {
  traceStoreTraceSelection,
  traceStoreTraces,
  type TraceSummary,
} from "./traces";

setup(React.createElement);

export type HyperDBDevtoolsPosition = "top" | "bottom" | "left" | "right";
export type HyperDBDevtoolsButtonPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";
export type HyperDBDevtoolsTheme = "dark" | "light" | "system";

export type HyperDBDevtoolsProps = {
  db?: SubscribableDB;
  initialIsOpen?: boolean;
  position?: HyperDBDevtoolsPosition;
  buttonPosition?: HyperDBDevtoolsButtonPosition;
  maxTraces?: number;
  theme?: HyperDBDevtoolsTheme;
};

export type HyperDBDevtoolsPanelProps = {
  db?: SubscribableDB;
  maxTraces?: number;
  theme?: HyperDBDevtoolsTheme;
  position?: HyperDBDevtoolsPosition;
  embedded?: boolean;
  onClose?: () => void;
};

const storageKey = "hyperdb-devtools-open";
const unassignedDBId = unassignedTraceDBKey;
const mutationEventBatchSize = 30;
const mutationValuePreviewSize = 30;
const traceRowHeight = 46;
const traceRowOverscan = 6;
const emptyTraceSelection: {
  visibleTraces: TraceSummary[];
  selectedTrace: RootTrace | undefined;
} = {
  visibleTraces: [],
  selectedTrace: undefined,
};

const readStoredOpenState = (initialIsOpen: boolean): boolean => {
  try {
    if (typeof globalThis.localStorage === "undefined") return initialIsOpen;
    const stored = globalThis.localStorage.getItem(storageKey);
    if (stored === null) return initialIsOpen;
    return stored === "true";
  } catch {
    return initialIsOpen;
  }
};

const writeStoredOpenState = (isOpen: boolean): void => {
  try {
    if (typeof globalThis.localStorage === "undefined") return;
    globalThis.localStorage.setItem(storageKey, String(isOpen));
  } catch {
    // Ignore storage failures so devtools can still mount in restricted contexts.
  }
};

const listWidthKey = "hyperdb-devtools-list-width";
const defaultListWidth = 290;
const minListWidth = 400;
const maxListWidth = 700;

const readStoredListWidth = (): number => {
  try {
    if (typeof globalThis.localStorage === "undefined") return defaultListWidth;
    const stored = globalThis.localStorage.getItem(listWidthKey);
    if (stored === null) return defaultListWidth;
    const n = Number(stored);
    return Number.isFinite(n)
      ? Math.max(minListWidth, Math.min(maxListWidth, n))
      : defaultListWidth;
  } catch {
    return defaultListWidth;
  }
};

const writeStoredListWidth = (width: number): void => {
  try {
    if (typeof globalThis.localStorage === "undefined") return;
    globalThis.localStorage.setItem(listWidthKey, String(width));
  } catch {
    // Ignore unavailable or blocked localStorage writes.
  }
};

const panelHeightKey = "hyperdb-devtools-panel-height";
const defaultPanelHeight = 460;
const minPanelHeight = 280;

// Below this container width the panel collapses to a single column: the trace
// list fills the panel and a selected trace opens as an overlay on top of it.
const narrowBreakpoint = 800;

const readStoredPanelHeight = (): number => {
  try {
    if (typeof globalThis.localStorage === "undefined")
      return defaultPanelHeight;
    const stored = globalThis.localStorage.getItem(panelHeightKey);
    if (stored === null) return defaultPanelHeight;
    const n = Number(stored);
    return Number.isFinite(n)
      ? Math.max(minPanelHeight, n)
      : defaultPanelHeight;
  } catch {
    return defaultPanelHeight;
  }
};

const writeStoredPanelHeight = (height: number): void => {
  try {
    if (typeof globalThis.localStorage === "undefined") return;
    globalThis.localStorage.setItem(panelHeightKey, String(height));
  } catch {
    // Ignore unavailable or blocked localStorage writes.
  }
};

const skipCachedKey = "hyperdb-devtools-skip-cached";

const readStoredSkipCached = (): boolean => {
  try {
    if (typeof globalThis.localStorage === "undefined") return false;
    return globalThis.localStorage.getItem(skipCachedKey) === "true";
  } catch {
    return false;
  }
};

const writeStoredSkipCached = (skipCached: boolean): void => {
  try {
    if (typeof globalThis.localStorage === "undefined") return;
    globalThis.localStorage.setItem(skipCachedKey, String(skipCached));
  } catch {
    // Ignore unavailable or blocked localStorage writes.
  }
};

type TraceKindFilter = "all" | "selector" | "action";

const kindFilterKey = "hyperdb-devtools-kind-filter";

const isTraceKindFilter = (value: string | null): value is TraceKindFilter =>
  value === "all" || value === "selector" || value === "action";

const readStoredKindFilter = (): TraceKindFilter => {
  try {
    if (typeof globalThis.localStorage === "undefined") return "all";
    const stored = globalThis.localStorage.getItem(kindFilterKey);
    return isTraceKindFilter(stored) ? stored : "all";
  } catch {
    return "all";
  }
};

const writeStoredKindFilter = (kind: TraceKindFilter): void => {
  try {
    if (typeof globalThis.localStorage === "undefined") return;
    globalThis.localStorage.setItem(kindFilterKey, kind);
  } catch {
    // Ignore unavailable or blocked localStorage writes.
  }
};

const kindFilterOptions: {
  value: TraceKindFilter;
  label: string;
  dot?: "selector" | "action";
}[] = [
  { value: "all", label: "All" },
  { value: "selector", label: "Sel", dot: "selector" },
  { value: "action", label: "Act", dot: "action" },
];

const sortFieldKey = "hyperdb-devtools-sort-field";
const sortDirKey = "hyperdb-devtools-sort-dir";

const readStoredSortField = (): TraceSortField => {
  try {
    if (typeof globalThis.localStorage === "undefined") return "created";
    return globalThis.localStorage.getItem(sortFieldKey) === "duration"
      ? "duration"
      : "created";
  } catch {
    return "created";
  }
};

const writeStoredSortField = (field: TraceSortField): void => {
  try {
    if (typeof globalThis.localStorage === "undefined") return;
    globalThis.localStorage.setItem(sortFieldKey, field);
  } catch {
    // Ignore unavailable or blocked localStorage writes.
  }
};

const readStoredSortDir = (): TraceSortDir => {
  try {
    if (typeof globalThis.localStorage === "undefined") return "desc";
    return globalThis.localStorage.getItem(sortDirKey) === "asc"
      ? "asc"
      : "desc";
  } catch {
    return "desc";
  }
};

const writeStoredSortDir = (dir: TraceSortDir): void => {
  try {
    if (typeof globalThis.localStorage === "undefined") return;
    globalThis.localStorage.setItem(sortDirKey, dir);
  } catch {
    // Ignore unavailable or blocked localStorage writes.
  }
};

type TraceDBOption = {
  id: string;
  label: string;
  traceCount: number;
};

const traceDBId = (trace: TraceSummary): string =>
  trace.dbId ?? unassignedDBId;

const getTraceDBOptions = (traces: TraceSummary[]): TraceDBOption[] => {
  const optionMap = new Map<string, TraceDBOption>();

  for (const trace of traces) {
    const id = traceDBId(trace);
    const existing = optionMap.get(id);

    if (existing) {
      existing.traceCount += 1;
      continue;
    }

    optionMap.set(id, {
      id,
      label: trace.dbLabel ?? "Unknown DB",
      traceCount: 1,
    });
  }

  return [...optionMap.values()];
};

const addCurrentDBOption = (
  options: TraceDBOption[],
  currentDBInfo: TraceDBInfo | undefined,
): TraceDBOption[] => {
  if (!currentDBInfo) return options;
  if (!options.some((option) => option.id !== unassignedDBId)) return options;

  let hasCurrentDB = false;
  const nextOptions = options.map((option) => {
    if (option.id !== currentDBInfo.id) return option;

    hasCurrentDB = true;
    return {
      ...option,
      label: currentDBInfo.label,
    };
  });

  if (!hasCurrentDB) {
    nextOptions.push({
      id: currentDBInfo.id,
      label: currentDBInfo.label,
      traceCount: 0,
    });
  }

  return nextOptions;
};

const mergeDBOptions = (
  knownOptions: TraceDBOption[],
  observedOptions: TraceDBOption[],
): TraceDBOption[] => {
  const observedById = new Map(
    observedOptions.map((option) => [option.id, option]),
  );
  const mergedOptions: TraceDBOption[] = [];

  for (const knownOption of knownOptions) {
    const observedOption = observedById.get(knownOption.id);

    mergedOptions.push(
      observedOption ?? {
        ...knownOption,
        traceCount: 0,
      },
    );
    observedById.delete(knownOption.id);
  }

  mergedOptions.push(...observedById.values());

  return mergedOptions;
};

const areDBOptionsEqual = (
  left: TraceDBOption[],
  right: TraceDBOption[],
): boolean =>
  left.length === right.length &&
  left.every((option, index) => {
    const rightOption = right[index];

    return (
      rightOption !== undefined &&
      option.id === rightOption.id &&
      option.label === rightOption.label &&
      option.traceCount === rightOption.traceCount
    );
  });

const panelPositionStyle = (position: HyperDBDevtoolsPosition): string => {
  switch (position) {
    case "top":
      return "top:0;left:0;right:0;height:min(44vh,520px);border-bottom:1px solid var(--hdb-border);";
    case "left":
      return "top:0;bottom:0;left:0;width:min(620px,92vw);border-right:1px solid var(--hdb-border);";
    case "right":
      return "top:0;bottom:0;right:0;width:min(620px,92vw);border-left:1px solid var(--hdb-border);";
    case "bottom":
    default:
      return "left:0;right:0;bottom:0;height:min(46vh,560px);border-top:1px solid var(--hdb-border);";
  }
};

const buttonPositionStyle = (
  position: HyperDBDevtoolsButtonPosition,
): string => {
  switch (position) {
    case "top-left":
      return "top:16px;left:16px;";
    case "top-right":
      return "top:16px;right:16px;";
    case "bottom-left":
      return "bottom:16px;left:16px;";
    case "bottom-right":
    default:
      return "bottom:16px;right:16px;";
  }
};

type ShellStyleProps = {
  position: HyperDBDevtoolsPosition;
  embedded: boolean;
  theme: HyperDBDevtoolsTheme;
};

const ShellElement = React.forwardRef<
  HTMLElement,
  React.HTMLAttributes<HTMLElement> & ShellStyleProps
>((props, ref) => {
  const { position, embedded, theme, ...domProps } = props;
  void position;
  void embedded;
  void theme;
  return <section ref={ref} {...domProps} />;
});
ShellElement.displayName = "ShellElement";

const ButtonElement = (
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    selected?: boolean;
    buttonPosition?: HyperDBDevtoolsButtonPosition;
    theme?: HyperDBDevtoolsTheme;
  },
) => {
  const { selected, buttonPosition, theme, ...domProps } = props;
  void selected;
  void buttonPosition;
  void theme;
  return <button {...domProps} />;
};

const SpanElement = (
  props: React.HTMLAttributes<HTMLSpanElement> & {
    tone?: "green" | "blue" | "red" | "amber" | "duration" | "rows" | "cached";
  },
) => {
  const { tone, ...domProps } = props;
  void tone;
  return <span {...domProps} />;
};

const Shell = styled(ShellElement)<ShellStyleProps>`
  --hdb-bg: #090e1a;
  --hdb-panel: #0d1422;
  --hdb-surface: #111b2e;
  --hdb-soft: #172236;
  --hdb-lift: #1d2a42;
  --hdb-border: #1e2d45;
  --hdb-border-strong: #38bdf8;
  --hdb-text: #d0dbf5;
  --hdb-muted: #5c7396;
  --hdb-faint: #253550;
  --hdb-accent: #10b981;
  --hdb-blue: #38bdf8;
  --hdb-warn: #f59e0b;
  --hdb-danger: #f87171;
  --hdb-shadow: 0 -8px 50px rgba(0, 0, 0, 0.65);

  ${({ theme }) =>
    theme === "light"
      ? `
        --hdb-bg: #f8fafc;
        --hdb-panel: #ffffff;
        --hdb-surface: #f1f5f9;
        --hdb-soft: #e8eef7;
        --hdb-lift: #dde6f2;
        --hdb-border: #dce6f0;
        --hdb-border-strong: #0284c7;
        --hdb-text: #0f172a;
        --hdb-muted: #475569;
        --hdb-faint: #94a3b8;
        --hdb-accent: #059669;
        --hdb-blue: #0284c7;
        --hdb-warn: #d97706;
        --hdb-danger: #dc2626;
        --hdb-shadow: 0 -4px 30px rgba(15, 23, 42, 0.1);
      `
      : ""}

  ${({ theme }) =>
    theme === "system"
      ? `
        @media (prefers-color-scheme: light) {
          --hdb-bg: #f8fafc;
          --hdb-panel: #ffffff;
          --hdb-surface: #f1f5f9;
          --hdb-soft: #e8eef7;
          --hdb-lift: #dde6f2;
          --hdb-border: #dce6f0;
          --hdb-border-strong: #0284c7;
          --hdb-text: #0f172a;
          --hdb-muted: #475569;
          --hdb-faint: #94a3b8;
          --hdb-accent: #059669;
          --hdb-blue: #0284c7;
          --hdb-warn: #d97706;
          --hdb-danger: #dc2626;
          --hdb-shadow: 0 -4px 30px rgba(15, 23, 42, 0.1);
        }
      `
      : ""}

  ${({ embedded, position }) =>
    embedded
      ? "position:relative;width:100%;height:100%;border:1px solid var(--hdb-border);"
      : `position:fixed;z-index:2147483646;${panelPositionStyle(position)}`}

  &::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(
      90deg,
      var(--hdb-blue) 0%,
      var(--hdb-accent) 100%
    );
    z-index: 1;
  }

  display: grid;
  min-height: 280px;
  overflow: hidden;
  background: var(--hdb-bg);
  color: var(--hdb-text);
  box-shadow: var(--hdb-shadow);
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  font-size: 12px;
  letter-spacing: 0;
`;

const TraceList = styled("aside")`
  min-width: 0;
  border-right: 1px solid var(--hdb-border);
  background: var(--hdb-panel);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
`;

const ResizeDivider = styled("div")`
  position: absolute;
  top: 0;
  bottom: 0;
  right: -4px;
  width: 8px;
  cursor: col-resize;
  z-index: 10;
  display: flex;
  align-items: stretch;
  justify-content: center;

  &::after {
    content: "";
    width: 1px;
    background: var(--hdb-border);
    transition:
      width 150ms ease,
      background 150ms ease;
    border-radius: 1px;
  }

  &:hover::after {
    width: 2px;
    background: var(--hdb-blue);
  }

  &[data-dragging]::after {
    width: 2px;
    background: var(--hdb-blue);
  }
`;

const PanelResizeDivider = styled("div")<{
  position: HyperDBDevtoolsPosition;
}>`
  position: absolute;
  left: 0;
  right: 0;
  height: 8px;
  cursor: row-resize;
  z-index: 12;
  ${({ position }) => (position === "top" ? "bottom: 0;" : "top: 0;")}
  display: flex;
  flex-direction: column;
  justify-content: ${({ position }) =>
    position === "top" ? "flex-end" : "flex-start"};

  &::after {
    content: "";
    height: 1px;
    background: var(--hdb-border);
    transition:
      height 150ms ease,
      background 150ms ease;
    border-radius: 1px;
  }

  &:hover::after {
    height: 2px;
    background: var(--hdb-blue);
  }

  &[data-dragging]::after {
    height: 2px;
    background: var(--hdb-blue);
  }
`;

const Toolbar = styled("div")`
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  row-gap: 6px;
  padding: 6px 10px 6px 14px;
  border-bottom: 1px solid var(--hdb-border);
  background: var(--hdb-surface);
  flex-shrink: 0;
`;

const Title = styled("strong")`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--hdb-text);
`;

const LogoDot = styled("span")`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--hdb-blue), var(--hdb-accent));
  flex-shrink: 0;
`;

const ToolbarActions = styled("div")`
  display: flex;
  align-items: center;
  gap: 4px;
`;

const TraceCount = styled("span")`
  height: 22px;
  display: inline-flex;
  align-items: center;
  border-radius: 5px;
  padding: 0 7px;
  background: var(--hdb-soft);
  color: var(--hdb-muted);
  font:
    600 10px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  letter-spacing: 0.02em;
`;

const Button = styled("button")`
  height: 22px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--hdb-muted);
  font:
    600 10px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 5px;
  padding: 0 8px;
  cursor: pointer;
  transition:
    background 120ms ease,
    color 120ms ease,
    border-color 120ms ease;

  &:hover {
    background: var(--hdb-soft);
    color: var(--hdb-text);
    border-color: var(--hdb-border);
  }

  &:focus-visible {
    outline: 2px solid var(--hdb-border-strong);
    outline-offset: 2px;
  }
`;

const FilterBar = styled("div")`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px 6px 14px;
  border-bottom: 1px solid var(--hdb-border);
  background: var(--hdb-panel);
  flex-shrink: 0;
`;

const SegmentedControl = styled("div")`
  display: flex;
  flex: 0 0 auto;
  width: 168px;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--hdb-border);
  border-radius: 8px;
  background: var(--hdb-surface);
`;

const Segment = styled(ButtonElement)<{ selected: boolean }>`
  flex: 1 1 0;
  min-width: 0;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
  font:
    700 10px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${({ selected }) =>
    selected ? "var(--hdb-text)" : "var(--hdb-muted)"};
  background: ${({ selected }) =>
    selected ? "var(--hdb-lift)" : "transparent"};
  box-shadow: ${({ selected }) =>
    selected ? "0 1px 2px rgba(0, 0, 0, 0.25)" : "none"};
  transition:
    background 120ms ease,
    color 120ms ease,
    box-shadow 120ms ease;

  &:hover {
    color: var(--hdb-text);
    background: ${({ selected }) =>
      selected ? "var(--hdb-lift)" : "var(--hdb-soft)"};
  }

  &:focus-visible {
    outline: 2px solid var(--hdb-border-strong);
    outline-offset: -2px;
  }
`;

const SegmentDot = styled("span")<{ kind: "selector" | "action" }>`
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${({ kind }) =>
    kind === "action" ? "var(--hdb-accent)" : "var(--hdb-blue)"};
`;

const SortControls = styled("div")`
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  min-width: 0;
`;

const SortButton = styled(ButtonElement)`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--hdb-border);
  border-radius: 6px;
  background: var(--hdb-surface);
  color: var(--hdb-text);
  font:
    600 10px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  letter-spacing: 0.04em;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    color 120ms ease;

  &:hover {
    background: var(--hdb-soft);
    border-color: var(--hdb-muted);
  }

  &:focus-visible {
    outline: 2px solid var(--hdb-border-strong);
    outline-offset: 2px;
  }
`;

const SortButtonLabel = styled("span")`
  color: var(--hdb-muted);
  text-transform: uppercase;
  letter-spacing: 0.07em;
`;

const SortButtonValue = styled("span")`
  color: var(--hdb-blue);
  text-transform: uppercase;
`;

const SortDirButton = styled(ButtonElement)`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 32px;
  flex-shrink: 0;
  border: 1px solid var(--hdb-border);
  border-radius: 6px;
  background: var(--hdb-surface);
  color: var(--hdb-muted);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    color 120ms ease;

  &:hover {
    background: var(--hdb-soft);
    border-color: var(--hdb-muted);
    color: var(--hdb-text);
  }

  &:focus-visible {
    outline: 2px solid var(--hdb-border-strong);
    outline-offset: 2px;
  }
`;

const DBSelect = styled("select")`
  box-sizing: border-box;
  max-width: 140px;
  height: 22px;
  border: 1px solid var(--hdb-border);
  border-radius: 5px;
  padding: 0 20px 0 7px;
  background: var(--hdb-soft);
  color: var(--hdb-text);
  font:
    600 10px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  cursor: pointer;
  transition: border-color 120ms ease;

  &:focus-visible {
    outline: 2px solid var(--hdb-border-strong);
    outline-offset: 2px;
  }

  &:hover {
    border-color: var(--hdb-muted);
  }
`;

const OptionsWrapper = styled("div")`
  position: relative;
  display: inline-flex;
`;

const OptionsPopup = styled("div")`
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  min-width: 200px;
  padding: 10px;
  border: 1px solid var(--hdb-border);
  border-radius: 8px;
  background: var(--hdb-panel);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
`;

const OptionLabel = styled("label")`
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--hdb-text);
  font:
    600 11px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  letter-spacing: 0.02em;

  input {
    width: 13px;
    height: 13px;
    margin: 0;
    accent-color: var(--hdb-blue);
    cursor: pointer;
  }
`;

const ToggleButton = styled(ButtonElement)<{
  buttonPosition: HyperDBDevtoolsButtonPosition;
  theme: HyperDBDevtoolsTheme;
}>`
  --hdb-toggle-bg: #0d1422;
  --hdb-toggle-hover: #172236;
  --hdb-toggle-border: #1e2d45;
  --hdb-toggle-text: #d0dbf5;
  --hdb-toggle-blue: #38bdf8;
  --hdb-toggle-green: #10b981;

  ${({ theme }) =>
    theme === "light"
      ? `
        --hdb-toggle-bg: #ffffff;
        --hdb-toggle-hover: #f1f5f9;
        --hdb-toggle-border: #dce6f0;
        --hdb-toggle-text: #0f172a;
        --hdb-toggle-blue: #0284c7;
        --hdb-toggle-green: #059669;
      `
      : ""}

  ${({ theme }) =>
    theme === "system"
      ? `
        @media (prefers-color-scheme: light) {
          --hdb-toggle-bg: #ffffff;
          --hdb-toggle-hover: #f1f5f9;
          --hdb-toggle-border: #dce6f0;
          --hdb-toggle-text: #0f172a;
          --hdb-toggle-blue: #0284c7;
          --hdb-toggle-green: #059669;
        }
      `
      : ""}

  position: fixed;
  ${({ buttonPosition }) => buttonPositionStyle(buttonPosition)}
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--hdb-toggle-border);
  border-radius: 8px;
  background: var(--hdb-toggle-bg);
  color: var(--hdb-toggle-text);
  box-shadow:
    0 4px 20px rgba(0, 0, 0, 0.3),
    0 1px 4px rgba(0, 0, 0, 0.2);
  font:
    700 11px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background 150ms ease,
    box-shadow 150ms ease;

  &:hover {
    border-color: var(--hdb-toggle-blue);
    background: var(--hdb-toggle-hover);
    box-shadow:
      0 4px 24px rgba(0, 0, 0, 0.35),
      0 0 0 1px var(--hdb-toggle-blue);
  }

  &:focus-visible {
    outline: 2px solid var(--hdb-toggle-blue);
    outline-offset: 2px;
  }
`;

const ToggleDot = styled("span")`
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: linear-gradient(
    135deg,
    var(--hdb-toggle-blue),
    var(--hdb-toggle-green)
  );
  flex-shrink: 0;
`;

const Rows = styled("div")`
  overflow: auto;
  min-height: 0;
  flex: 1;
`;

const TraceRow = styled(ButtonElement)<{ selected: boolean }>`
  position: relative;
  appearance: none;
  box-sizing: border-box;
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  height: ${traceRowHeight}px;
  padding: 7px 10px 7px 14px;
  border: 0;
  border-bottom: 1px solid var(--hdb-border);
  border-radius: 0;
  background: ${({ selected }) =>
    selected ? "var(--hdb-soft)" : "transparent"};
  color: var(--hdb-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  outline: 0;
  overflow: hidden;
  transition: background 100ms ease;

  &::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: ${({ selected }) =>
      selected ? "var(--hdb-kind-color, var(--hdb-blue))" : "transparent"};
    transition: background 100ms ease;
  }

  &:hover {
    background: ${({ selected }) =>
      selected ? "var(--hdb-soft)" : "var(--hdb-lift)"};

    &::before {
      background: var(--hdb-kind-color, var(--hdb-blue));
      opacity: ${({ selected }) => (selected ? 1 : 0.4)};
    }
  }

  &:focus-visible {
    outline: 2px solid var(--hdb-border-strong);
    outline-offset: -2px;
  }
`;

const KindPill = styled("span")<{ kind: "selector" | "action" | "unknown" }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  font:
    700 9px ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  letter-spacing: 0.02em;
  flex-shrink: 0;
  background: ${({ kind }) =>
    kind === "action"
      ? "color-mix(in srgb, var(--hdb-accent) 15%, transparent)"
      : kind === "selector"
        ? "color-mix(in srgb, var(--hdb-blue) 15%, transparent)"
        : "color-mix(in srgb, var(--hdb-muted) 15%, transparent)"};
  color: ${({ kind }) =>
    kind === "action"
      ? "var(--hdb-accent)"
      : kind === "selector"
        ? "var(--hdb-blue)"
        : "var(--hdb-muted)"};
`;

const RowBody = styled("div")`
  min-width: 0;
  display: grid;
  gap: 2px;
  align-content: center;
`;

const RowTitle = styled("div")`
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
`;

const RowName = styled("span")`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--hdb-text);
`;

const TraceListCachedBadge = styled("span")`
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid var(--hdb-blue);
  color: var(--hdb-blue);
  background: color-mix(in srgb, var(--hdb-blue) 10%, transparent);
  font:
    600 10px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  font-size: 9px;
  line-height: 1;
`;

const RowMeta = styled("div")`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  color: var(--hdb-muted);
  font:
    10px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  line-height: 1;
`;

const RowMetaSep = styled("span")`
  color: var(--hdb-faint);
  user-select: none;
`;

const StatusPill = styled("span")<{
  tone: "green" | "blue" | "red" | "amber";
}>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border-radius: 4px;
  font:
    600 10px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  letter-spacing: 0.02em;
  flex-shrink: 0;
  background: ${({ tone }) =>
    tone === "red"
      ? "color-mix(in srgb, var(--hdb-danger) 12%, transparent)"
      : tone === "amber"
        ? "color-mix(in srgb, var(--hdb-warn) 14%, transparent)"
        : tone === "blue"
          ? "color-mix(in srgb, var(--hdb-blue) 12%, transparent)"
          : "color-mix(in srgb, var(--hdb-accent) 12%, transparent)"};
  color: ${({ tone }) =>
    tone === "red"
      ? "var(--hdb-danger)"
      : tone === "amber"
        ? "var(--hdb-warn)"
        : tone === "blue"
          ? "var(--hdb-blue)"
          : "var(--hdb-accent)"};
`;

const StatusDot = styled("span")<{ tone: "green" | "blue" | "red" | "amber" }>`
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${({ tone }) =>
    tone === "red"
      ? "var(--hdb-danger)"
      : tone === "amber"
        ? "var(--hdb-warn)"
        : tone === "blue"
          ? "var(--hdb-blue)"
          : "var(--hdb-accent)"};

  ${({ tone }) =>
    tone === "amber"
      ? `
        @keyframes hdb-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        animation: hdb-pulse 1.2s ease-in-out infinite;
      `
      : ""}
`;

const DurationText = styled("span")<{
  tone: "green" | "blue" | "red" | "amber";
}>`
  font:
    600 10px ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  color: ${({ tone }) =>
    tone === "red"
      ? "var(--hdb-danger)"
      : tone === "amber"
        ? "var(--hdb-warn)"
        : "var(--hdb-muted)"};
  flex-shrink: 0;
  min-width: 52px;
  text-align: right;
`;

const Detail = styled("main")`
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--hdb-bg);
`;

// On narrow layouts the detail view is rendered as an overlay covering the
// shell, so the trace list underneath keeps its scroll position while open.
const MobileDetailOverlay = styled("div")`
  position: absolute;
  inset: 0;
  z-index: 15;
  display: flex;
  flex-direction: column;
  background: var(--hdb-bg);

  & > main {
    flex: 1;
    min-height: 0;
  }
`;

const DetailHeader = styled("header")`
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 14px;
  border-bottom: 1px solid var(--hdb-border);
  background: var(--hdb-surface);
  flex-shrink: 0;
`;

const DetailHeaderLeft = styled("div")`
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
`;

const BackButton = styled(ButtonElement)`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border: 1px solid var(--hdb-border);
  border-radius: 6px;
  background: var(--hdb-surface);
  color: var(--hdb-text);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    color 120ms ease;

  &:hover {
    background: var(--hdb-soft);
    border-color: var(--hdb-muted);
    color: var(--hdb-text);
  }

  &:focus-visible {
    outline: 2px solid var(--hdb-border-strong);
    outline-offset: 2px;
  }
`;

const DetailTitle = styled("div")`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;

  strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--hdb-text);
  }

  span {
    color: var(--hdb-muted);
    font:
      10px ui-monospace,
      SFMono-Regular,
      Menlo,
      Monaco,
      Consolas,
      monospace;
    line-height: 1;
  }
`;

const HeaderBadges = styled("div")`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
`;

const Tabs = styled("div")`
  display: flex;
  gap: 0;
  padding: 0 10px;
  border-bottom: 1px solid var(--hdb-border);
  background: var(--hdb-panel);
  flex-shrink: 0;
`;

const Tab = styled(ButtonElement)<{ selected: boolean }>`
  position: relative;
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 0;
  color: ${({ selected }) =>
    selected ? "var(--hdb-text)" : "var(--hdb-muted)"};
  background: transparent;
  font:
    600 11px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  letter-spacing: 0.03em;
  cursor: pointer;
  transition: color 120ms ease;

  &::after {
    content: "";
    position: absolute;
    bottom: 0;
    left: 4px;
    right: 4px;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: ${({ selected }) =>
      selected ? "var(--hdb-blue)" : "transparent"};
    transition: background 120ms ease;
  }

  &:hover {
    color: var(--hdb-text);
  }

  &:focus-visible {
    outline: 2px solid var(--hdb-border-strong);
    outline-offset: -2px;
  }
`;

const Content = styled("div")`
  min-height: 0;
  overflow: auto;
  padding: 12px 14px;
  flex: 1;
`;

const Empty = styled("div")`
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--hdb-faint);
  font:
    600 10px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  text-transform: uppercase;
  letter-spacing: 0.08em;
`;

const Grid = styled("div")`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
`;

const Stat = styled("div")`
  border: 1px solid var(--hdb-border);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--hdb-panel);

  span {
    display: block;
    color: var(--hdb-muted);
    font:
      600 9px ui-monospace,
      SFMono-Regular,
      Menlo,
      Monaco,
      Consolas,
      monospace;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    margin-bottom: 5px;
  }

  strong {
    display: block;
    color: var(--hdb-text);
    font:
      700 14px ui-monospace,
      SFMono-Regular,
      Menlo,
      Monaco,
      Consolas,
      monospace;
    line-height: 1;
  }
`;

const DataBlock = styled("pre")`
  margin: 8px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--hdb-border);
  border-radius: 6px;
  background: var(--hdb-panel);
  color: var(--hdb-text);
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font:
    11px/1.5 ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
`;

const EventBlock = styled("article")`
  border: 1px solid var(--hdb-border);
  border-radius: 6px;
  background: var(--hdb-panel);
  overflow: hidden;
  margin-bottom: 8px;
`;

const EventBlockContent = styled("div")`
  padding: 5px 10px 10px;
`;

const LoadMoreSentinel = styled("div")`
  height: 1px;
`;

const EventHeader = styled("div")`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--hdb-border);
  background: var(--hdb-surface);
  color: var(--hdb-text);
  font:
    600 11px ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
`;

const EventHeaderLeft = styled("div")`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const TreeRow = styled("div")`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--hdb-border);
  border-radius: 5px;
  background: var(--hdb-surface);
  font:
    600 11px/1.3 ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;

  margin-top: 4px;
`;

const TreeLabel = styled("span")`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--hdb-text);
`;

const treeBadgeColor = (tone: "duration" | "rows" | "cached"): string => {
  if (tone === "rows") return "var(--hdb-accent)";
  if (tone === "cached") return "var(--hdb-blue)";
  return "var(--hdb-border)";
};

const TreeBadge = styled(SpanElement)<{
  tone: "duration" | "rows" | "cached";
}>`
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid ${({ tone }) => treeBadgeColor(tone)};
  color: ${({ tone }) =>
    tone === "duration" ? "var(--hdb-muted)" : treeBadgeColor(tone)};
  background: ${({ tone }) =>
    tone === "duration"
      ? "transparent"
      : `color-mix(in srgb, ${treeBadgeColor(tone)} 10%, transparent)`};
  font-size: 9px;
  line-height: 1;
  font-weight: 600;
`;

const frameIndent = css`
  margin-top: 4px;
  margin-left: 12px;
  padding-left: 10px;
  border-left: 1px solid var(--hdb-border);
`;

const SectionLabel = styled("div")`
  font:
    600 9px ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--hdb-muted);
  margin: 12px 0 6px;

  &:first-child {
    margin-top: 0;
  }
`;

const PreviewNote = styled("div")`
  margin-top: 4px;
  font:
    10px ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  color: var(--hdb-muted);
`;

// ─── Pure logic (unchanged) ────────────────────────────────────────────────

const statusTone = (status: TraceStatus): "green" | "red" | "amber" => {
  if (status === "error") return "red";
  if (status === "running") return "amber";
  return "green";
};

const traceKindLabel = (kind: RootTrace["kind"]): string => {
  if (kind === "selector") return "S";
  if (kind === "action") return "A";
  return "?";
};

const traceKindColor = (kind: RootTrace["kind"]): string => {
  if (kind === "selector") return "var(--hdb-blue)";
  if (kind === "action") return "var(--hdb-accent)";
  return "var(--hdb-muted)";
};

const formatDuration = (durationMs?: number): string =>
  durationMs === undefined ? "…" : `${durationMs.toFixed(1)}ms`;

const formatTime = (time: number): string =>
  new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const renderSerialized = (value: unknown) => safeSerialize(value).text;

const conditionOperators = [
  ["eq", "="],
  ["gt", ">"],
  ["gte", ">="],
  ["lt", "<"],
  ["lte", "<="],
] as const;

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const formatIdentifier = (identifier: string): string =>
  identifierPattern.test(identifier)
    ? identifier
    : `"${identifier.replace(/"/g, '""')}"`;

const formatLiteral = (value: unknown): string => {
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value === null) return "NULL";
  return `'${safeSerialize(value).text.replace(/'/g, "''")}'`;
};

const formatWhereClause = (
  clause: SelectCommandEvent["where"][number],
): string => {
  const conditions = conditionOperators.flatMap(([key, operator]) =>
    clause[key].map(
      ({ col, val }) =>
        `${formatIdentifier(col)} ${operator} ${formatLiteral(val)}`,
    ),
  );

  return conditions.join(" AND ");
};

export const formatSelectQuery = (event: SelectCommandEvent): string => {
  const whereGroups = event.where.map(formatWhereClause).filter(Boolean);
  const lines = [
    `SELECT ${formatIdentifier(event.index)}`,
    `FROM ${formatIdentifier(event.tableName)}`,
  ];

  if (whereGroups.length === 1) {
    lines.push(`WHERE ${whereGroups[0]}`);
  } else if (whereGroups.length > 1) {
    lines.push(
      `WHERE ${whereGroups.map((group) => `(${group})`).join(" OR ")}`,
    );
  }

  if (event.order !== undefined) {
    lines.push(
      `ORDER BY ${formatIdentifier(event.index)} ${event.order.toUpperCase()}`,
    );
  }

  if (event.limit !== undefined) {
    lines.push(`LIMIT ${event.limit}`);
  }

  return `${lines.join("\n")};`;
};

const formatRecordCount = (event: SelectCommandEvent): string => {
  if (event.status === "running") return "…";
  if (event.status === "error") return "error";
  return String(event.resultCount ?? 0);
};

export const getTraceQueriedRowCount = (trace: RootTrace): number =>
  trace.commandEvents.reduce(
    (total, event) => total + (event.resultCount ?? 0),
    0,
  );

export const formatTraceQueriedRowCount = (trace: RootTrace): string => {
  const queriedRowCount = getTraceQueriedRowCount(trace);
  const hasPendingSelect = trace.commandEvents.some(
    (event) => event.status === "running" && event.resultCount === undefined,
  );

  return `${queriedRowCount}${hasPendingSelect ? "+" : ""}`;
};

const formatTraceQueriedRows = (trace: RootTrace): string => {
  const queriedRowCount = getTraceQueriedRowCount(trace);
  const hasPendingSelect = trace.commandEvents.some(
    (event) => event.status === "running" && event.resultCount === undefined,
  );
  const unit = queriedRowCount === 1 && !hasPendingSelect ? "row" : "rows";

  return `${formatTraceQueriedRowCount(trace)} ${unit}`;
};

const countActionFrames = (frame: TraceFrame): number =>
  (frame.kind === "action" ? 1 : 0) +
  frame.children.reduce((total, child) => total + countActionFrames(child), 0);

export const getTraceActionCount = (trace: RootTrace): number =>
  trace.frames.reduce((total, frame) => total + countActionFrames(frame), 0);

const formatActionCount = (count: number): string =>
  `${count} ${count === 1 ? "action" : "actions"}`;

export const isFullyCachedTrace = (trace: RootTrace): boolean =>
  trace.frames[0]?.cached === true;

type CallTreeOperation =
  | {
      kind: "frame";
      id: string;
      startedAt: number;
      order: number;
      frame: TraceFrame;
    }
  | {
      kind: "select";
      id: string;
      startedAt: number;
      order: number;
      event: SelectCommandEvent;
    }
  | {
      kind: "mutation";
      id: string;
      startedAt: number;
      order: number;
      event: MutationEvent;
    };

type CallTreeOperationLookup = {
  selectsByFrameId: Map<string, SelectCommandEvent[]>;
  mutationsByFrameId: Map<string, MutationEvent[]>;
};

const idOrder = (id: string): number => {
  const match = /-(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
};

const groupCallTreeEvents = (trace: RootTrace): CallTreeOperationLookup => {
  const selectsByFrameId = new Map<string, SelectCommandEvent[]>();
  const mutationsByFrameId = new Map<string, MutationEvent[]>();

  for (const event of trace.commandEvents) {
    const events = selectsByFrameId.get(event.frameId);
    if (events) events.push(event);
    else selectsByFrameId.set(event.frameId, [event]);
  }

  for (const event of trace.mutationEvents) {
    const events = mutationsByFrameId.get(event.frameId);
    if (events) events.push(event);
    else mutationsByFrameId.set(event.frameId, [event]);
  }

  return { selectsByFrameId, mutationsByFrameId };
};

const getCallTreeOperationsFromLookup = (
  frame: TraceFrame,
  lookup: CallTreeOperationLookup,
): CallTreeOperation[] =>
  [
    ...(lookup.selectsByFrameId.get(frame.id) ?? []).map((event) => ({
      kind: "select" as const,
      id: event.id,
      startedAt: event.startedAt,
      order: idOrder(event.id),
      event,
    })),
    ...(lookup.mutationsByFrameId.get(frame.id) ?? []).map((event) => ({
      kind: "mutation" as const,
      id: event.id,
      startedAt: event.startedAt,
      order: idOrder(event.id),
      event,
    })),
    ...frame.children.map((child) => ({
      kind: "frame" as const,
      id: child.id,
      startedAt: child.startedAt,
      order: idOrder(child.id),
      frame: child,
    })),
  ].sort(
    (left, right) =>
      left.startedAt - right.startedAt || left.order - right.order,
  );

export const getCallTreeOperations = (
  frame: TraceFrame,
  trace: RootTrace,
): CallTreeOperation[] =>
  getCallTreeOperationsFromLookup(frame, groupCallTreeEvents(trace));

export const formatCallTreeOperation = (
  operation: CallTreeOperation,
): string => {
  if (operation.kind === "frame") {
    return `@${operation.frame.name}`;
  }

  if (operation.kind === "select") {
    return `select ${operation.event.tableName}.${operation.event.index}`;
  }

  return `${operation.event.kind} ${operation.event.tableName}`;
};

const callTreeOperationDuration = (operation: CallTreeOperation): string => {
  const durationMs =
    operation.kind === "frame"
      ? operation.frame.durationMs
      : operation.event.durationMs;

  if (durationMs === undefined) return "…";
  return Number.isInteger(durationMs)
    ? `${durationMs}ms`
    : `${durationMs.toFixed(1)}ms`;
};

const mutationRecordCount = (event: MutationEvent): number | undefined => {
  if (event.rows !== undefined) return event.rows.length;
  if (event.newValue !== undefined) return event.newValue.length;
  if (event.ids !== undefined) return event.ids.length;
  if (event.oldValue !== undefined) return event.oldValue.length;
  return undefined;
};

const mutationKindVerb = (kind: MutationEventKind): string => {
  if (kind === "insert") return "inserted";
  if (kind === "delete") return "deleted";
  return "upserted";
};

const formatMutationSummary = (event: MutationEvent): string => {
  const count = mutationRecordCount(event) ?? 0;
  return `${count} ${count === 1 ? "row" : "rows"} ${mutationKindVerb(event.kind)}`;
};

export const getTraceMutatedRowCount = (trace: RootTrace): number =>
  trace.mutationEvents.reduce(
    (total, event) => total + (mutationRecordCount(event) ?? 0),
    0,
  );

const callTreeOperationRecordCount = (
  operation: CallTreeOperation,
): number | undefined => {
  if (operation.kind === "frame") return undefined;
  if (operation.kind === "select") return operation.event.resultCount;
  return mutationRecordCount(operation.event);
};

const formatRowCount = (count: number): string =>
  `${count} ${count === 1 ? "row" : "rows"}`;

type MutationValuePreview = {
  shown: number;
  total: number;
  omitted: number;
};

type MutationUpdate = { old: unknown; new: unknown };

export type MutationDisplaySection =
  | {
      variant: "rows";
      label: string;
      total: number;
      rows: unknown[];
      preview?: MutationValuePreview;
    }
  | {
      variant: "updates";
      label: string;
      total: number;
      updates: MutationUpdate[];
      preview?: MutationValuePreview;
    };

const truncateRows = <Value,>(
  value: Value[],
): { rows: Value[]; preview?: MutationValuePreview } => {
  if (value.length <= mutationValuePreviewSize) return { rows: value };

  return {
    rows: value.slice(0, mutationValuePreviewSize),
    preview: {
      shown: mutationValuePreviewSize,
      total: value.length,
      omitted: value.length - mutationValuePreviewSize,
    },
  };
};

const rowId = (row: unknown): string | undefined =>
  typeof row === "object" &&
  row !== null &&
  typeof (row as { id?: unknown }).id === "string"
    ? (row as { id: string }).id
    : undefined;

const rowsSection = (
  label: string,
  value: unknown[],
): MutationDisplaySection => {
  const { rows, preview } = truncateRows(value);
  return { variant: "rows", label, total: value.length, rows, preview };
};

// Turns a raw mutation event into the few sections worth reading: what was
// inserted, what was deleted, and — for updates — old vs. new values. Avoids
// the raw event dump where `rows`/`newValue` share a reference and serialize
// as `[Circular]`.
export const getMutationDisplay = (
  event: MutationEvent,
): MutationDisplaySection[] => {
  if (event.kind === "delete") {
    return [rowsSection("Deleted", event.oldValue ?? event.ids ?? [])];
  }

  if (event.kind === "insert") {
    return [rowsSection("Inserted", event.newValue ?? event.rows ?? [])];
  }

  // upsert
  const newRows = event.newValue ?? event.rows ?? [];

  // While the event is still running we don't have prior values yet.
  if (event.oldValue === undefined) {
    return [rowsSection("Upserted", newRows)];
  }

  const oldById = new Map<string, unknown>();
  for (const old of event.oldValue) {
    const id = rowId(old);
    if (id !== undefined) oldById.set(id, old);
  }

  const updates: MutationUpdate[] = [];
  const inserts: unknown[] = [];
  for (const next of newRows) {
    const id = rowId(next);
    const prev = id !== undefined ? oldById.get(id) : undefined;
    if (prev !== undefined) updates.push({ old: prev, new: next });
    else inserts.push(next);
  }

  const sections: MutationDisplaySection[] = [];
  if (updates.length > 0) {
    const { rows, preview } = truncateRows(updates);
    sections.push({
      variant: "updates",
      label: "Updated",
      total: updates.length,
      updates: rows,
      preview,
    });
  }
  if (inserts.length > 0) {
    sections.push(rowsSection("Inserted", inserts));
  }
  if (sections.length === 0) {
    sections.push(rowsSection("Upserted", newRows));
  }
  return sections;
};

export const getCallTreeOperationBadges = (
  operation: CallTreeOperation,
): { text: string; tone: "duration" | "rows" | "cached" }[] => {
  const badges: { text: string; tone: "duration" | "rows" | "cached" }[] = [
    { text: callTreeOperationDuration(operation), tone: "duration" },
  ];
  const recordCount = callTreeOperationRecordCount(operation);

  if (recordCount !== undefined) {
    badges.push({ text: formatRowCount(recordCount), tone: "rows" });
  }

  if (operation.kind === "frame" && operation.frame.cached) {
    badges.push({ text: "cached", tone: "cached" });
  }

  return badges;
};

// ─── Components ────────────────────────────────────────────────────────────

type TraceRowViewProps = {
  id: string;
  kind: RootTrace["kind"];
  name: string;
  startedAt: number;
  durationMs?: number;
  status: TraceStatus;
  cached: boolean;
  selectCount: number;
  queriedRowCount: number;
  hasPendingSelect: boolean;
  actionCount: number;
  selected: boolean;
  onSelectTrace: (id: string) => void;
};

const TraceRowView = React.memo(
  ({
    id,
    kind,
    name,
    startedAt,
    durationMs,
    status,
    cached,
    selectCount,
    queriedRowCount,
    hasPendingSelect,
    actionCount,
    selected,
    onSelectTrace,
  }: TraceRowViewProps) => {
    const handleClick = useCallback(() => {
      onSelectTrace(id);
    }, [id, onSelectTrace]);
    const queriedRowsUnit =
      queriedRowCount === 1 && !hasPendingSelect ? "row" : "rows";

    return (
      <TraceRow
        selected={selected}
        style={
          {
            "--hdb-kind-color": traceKindColor(kind),
          } as React.CSSProperties
        }
        onClick={handleClick}
      >
        <KindPill
          kind={kind === "action" || kind === "selector" ? kind : "unknown"}
        >
          {traceKindLabel(kind)}
        </KindPill>
        <RowBody>
          <RowTitle>
            <RowName>{name}</RowName>
            {cached ? <TraceListCachedBadge>cached</TraceListCachedBadge> : null}
          </RowTitle>
          <RowMeta>
            <span>
              {queriedRowCount}
              {hasPendingSelect ? "+" : ""} {queriedRowsUnit}
            </span>
            <RowMetaSep>·</RowMetaSep>
            <span>{selectCount} sel</span>
            <RowMetaSep>·</RowMetaSep>
            <span>{actionCount} act</span>
            <RowMetaSep>·</RowMetaSep>
            <span>{formatTime(startedAt)}</span>
          </RowMeta>
        </RowBody>
        <DurationText tone={statusTone(status)}>
          {formatDuration(durationMs)}
        </DurationText>
      </TraceRow>
    );
  },
);
TraceRowView.displayName = "TraceRowView";

const TraceRowsView = React.memo(
  ({
    traces,
    selectedTraceId,
    onSelectTrace,
  }: {
    traces: TraceSummary[];
    selectedTraceId: string | undefined;
    onSelectTrace: (id: string) => void;
  }) => {
    const rowsRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 });

    useEffect(() => {
      const el = rowsRef.current;
      if (!el) return;

      const updateHeight = () => {
        setViewport((current) =>
          current.height === el.clientHeight
            ? current
            : { ...current, height: el.clientHeight },
        );
      };

      updateHeight();

      const ResizeObserverCtor = globalThis.ResizeObserver;
      if (!ResizeObserverCtor) return;

      const observer = new ResizeObserverCtor(updateHeight);
      observer.observe(el);

      return () => observer.disconnect();
    }, []);

    const handleScroll = useCallback(
      (event: React.UIEvent<HTMLDivElement>) => {
        const nextScrollTop = event.currentTarget.scrollTop;
        setViewport((current) =>
          current.scrollTop === nextScrollTop
            ? current
            : { ...current, scrollTop: nextScrollTop },
        );
      },
      [],
    );

    const virtualWindow = useMemo(() => {
      if (viewport.height <= 0) {
        return {
          startIndex: 0,
          endIndex: traces.length,
          offsetTop: 0,
          totalHeight: traces.length * traceRowHeight,
          virtualized: false,
        };
      }

      const startIndex = Math.max(
        0,
        Math.floor(viewport.scrollTop / traceRowHeight) - traceRowOverscan,
      );
      const endIndex = Math.min(
        traces.length,
        Math.ceil((viewport.scrollTop + viewport.height) / traceRowHeight) +
          traceRowOverscan,
      );

      return {
        startIndex,
        endIndex,
        offsetTop: startIndex * traceRowHeight,
        totalHeight: traces.length * traceRowHeight,
        virtualized: true,
      };
    }, [traces.length, viewport.height, viewport.scrollTop]);

    const visibleTraces = traces.slice(
      virtualWindow.startIndex,
      virtualWindow.endIndex,
    );

    if (traces.length === 0) {
      return (
        <Rows ref={rowsRef}>
          <Empty>No traces</Empty>
        </Rows>
      );
    }

    return (
      <Rows ref={rowsRef} onScroll={handleScroll}>
        {virtualWindow.virtualized ? (
          <div
            style={{
              height: virtualWindow.totalHeight,
              position: "relative",
            }}
          >
            <div
              style={{
                transform: `translateY(${virtualWindow.offsetTop}px)`,
              }}
            >
              {visibleTraces.map((trace) => (
                <TraceRowView
                  key={trace.id}
                  id={trace.id}
                  kind={trace.kind}
                  name={trace.name}
                  startedAt={trace.startedAt}
                  durationMs={trace.durationMs}
                  status={trace.status}
                  cached={trace.cached}
                  selectCount={trace.selectCount}
                  queriedRowCount={trace.queriedRowCount}
                  hasPendingSelect={trace.hasPendingSelect}
                  actionCount={trace.actionCount}
                  selected={trace.id === selectedTraceId}
                  onSelectTrace={onSelectTrace}
                />
              ))}
            </div>
          </div>
        ) : (
          visibleTraces.map((trace) => (
            <TraceRowView
              key={trace.id}
              id={trace.id}
              kind={trace.kind}
              name={trace.name}
              startedAt={trace.startedAt}
              durationMs={trace.durationMs}
              status={trace.status}
              cached={trace.cached}
              selectCount={trace.selectCount}
              queriedRowCount={trace.queriedRowCount}
              hasPendingSelect={trace.hasPendingSelect}
              actionCount={trace.actionCount}
              selected={trace.id === selectedTraceId}
              onSelectTrace={onSelectTrace}
            />
          ))
        )}
      </Rows>
    );
  },
);
TraceRowsView.displayName = "TraceRowsView";

const MutationEventData = React.memo(({ event }: { event: MutationEvent }) => {
  const sections = getMutationDisplay(event);
  // A single section is already described by the header summary ("1 row
  // upserted"); only label when we split into multiple sections.
  const showLabels = sections.length > 1;

  return (
    <>
      {sections.map((section) => (
        <React.Fragment key={section.label}>
          {showLabels && (
            <SectionLabel>
              {section.label} ({section.total})
            </SectionLabel>
          )}
          <DataBlock>
            {section.variant === "updates"
              ? renderSerialized(section.updates)
              : renderSerialized(section.rows)}
          </DataBlock>
          {section.preview && (
            <PreviewNote>
              Showing first {section.preview.shown} of {section.preview.total} (
              {section.preview.omitted} hidden)
            </PreviewNote>
          )}
        </React.Fragment>
      ))}
      {event.error && (
        <>
          <SectionLabel>Error</SectionLabel>
          <DataBlock>{renderSerialized(event.error)}</DataBlock>
        </>
      )}
    </>
  );
});
MutationEventData.displayName = "MutationEventData";

const SelectEventData = React.memo(({ event }: { event: SelectCommandEvent }) => (
  <>
    <DataBlock>{formatSelectQuery(event)}</DataBlock>
  </>
));
SelectEventData.displayName = "SelectEventData";

const TraceOverview = React.memo(({ trace }: { trace: RootTrace }) => (
  <>
    <Grid>
      <Stat>
        <span>Duration</span>
        <strong>{formatDuration(trace.durationMs)}</strong>
      </Stat>
      <Stat>
        <span>Selects</span>
        <strong>{trace.commandEvents.length}</strong>
      </Stat>
      <Stat>
        <span>Rows queried</span>
        <strong>{formatTraceQueriedRows(trace)}</strong>
      </Stat>
      <Stat>
        <span>Actions</span>
        <strong>{formatActionCount(getTraceActionCount(trace))}</strong>
      </Stat>
      <Stat>
        <span>Rows mutated</span>
        <strong>{formatRowCount(getTraceMutatedRowCount(trace))}</strong>
      </Stat>
    </Grid>
    <SectionLabel>Arguments</SectionLabel>
    <DataBlock>{renderSerialized(trace.arg)}</DataBlock>
    {trace.error && (
      <>
        <SectionLabel>Error</SectionLabel>
        <DataBlock>{renderSerialized(trace.error)}</DataBlock>
      </>
    )}
  </>
));
TraceOverview.displayName = "TraceOverview";

const SelectEvents = React.memo(({ events }: { events: SelectCommandEvent[] }) => {
  if (events.length === 0) return <Empty>No selects</Empty>;

  return (
    <>
      {events.map((event) => (
        <EventBlock key={event.id}>
          <EventHeader>
            <EventHeaderLeft>
              <StatusDot tone={statusTone(event.status)} />
              <span>
                {event.tableName}.{event.index}
              </span>
            </EventHeaderLeft>
            <RowMeta>
              <span>{formatRecordCount(event)} rows</span>
              <span>{formatDuration(event.durationMs)}</span>
            </RowMeta>
          </EventHeader>
          <EventBlockContent>
            <SelectEventData event={event} />
          </EventBlockContent>
        </EventBlock>
      ))}
    </>
  );
});
SelectEvents.displayName = "SelectEvents";

const MutationEvents = React.memo(({
  events,
  scrollParentRef,
}: {
  events: MutationEvent[];
  scrollParentRef: React.RefObject<HTMLDivElement | null>;
}) => {
  const [visibleCount, setVisibleCount] = useState(mutationEventBatchSize);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasMore = visibleCount < events.length;
  const visibleEvents = events.slice(0, visibleCount);

  useEffect(() => {
    if (!hasMore) return;

    const root = scrollParentRef.current;
    const sentinel = sentinelRef.current;
    const IntersectionObserverCtor = globalThis.IntersectionObserver;

    if (!root || !sentinel || !IntersectionObserverCtor) return;

    const observer = new IntersectionObserverCtor(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;

        setVisibleCount((count) =>
          Math.min(count + mutationEventBatchSize, events.length),
        );
      },
      { root, rootMargin: "96px 0px" },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [events.length, hasMore, scrollParentRef, visibleCount]);

  useEffect(() => {
    if (!hasMore || globalThis.IntersectionObserver) return;

    const root = scrollParentRef.current;
    if (!root) return;

    const loadWhenNearBottom = () => {
      const distanceFromBottom =
        root.scrollHeight - root.scrollTop - root.clientHeight;

      if (distanceFromBottom > 96) return;

      setVisibleCount((count) =>
        Math.min(count + mutationEventBatchSize, events.length),
      );
    };

    root.addEventListener("scroll", loadWhenNearBottom, { passive: true });
    loadWhenNearBottom();

    return () => {
      root.removeEventListener("scroll", loadWhenNearBottom);
    };
  }, [events.length, hasMore, scrollParentRef, visibleCount]);

  if (events.length === 0) return <Empty>No mutations</Empty>;

  return (
    <>
      {visibleEvents.map((event) => (
        <EventBlock key={event.id}>
          <EventHeader>
            <EventHeaderLeft>
              <StatusDot tone={statusTone(event.status)} />
              <span>
                {event.kind} {event.tableName}
              </span>
            </EventHeaderLeft>
            <RowMeta>
              <span>{formatMutationSummary(event)}</span>
              <span>{formatDuration(event.durationMs)}</span>
            </RowMeta>
          </EventHeader>
          <EventBlockContent>
            <MutationEventData event={event} />
          </EventBlockContent>
        </EventBlock>
      ))}
      {hasMore ? (
        <LoadMoreSentinel ref={sentinelRef} aria-hidden="true" />
      ) : null}
    </>
  );
});
MutationEvents.displayName = "MutationEvents";

const CallTreeOperationView = React.memo(({
  operation,
  lookup,
}: {
  operation: CallTreeOperation;
  lookup: CallTreeOperationLookup;
}) => {
  const childOperations =
    operation.kind === "frame"
      ? getCallTreeOperationsFromLookup(operation.frame, lookup)
      : [];
  const badges = getCallTreeOperationBadges(operation);

  return (
    <div>
      <TreeRow>
        <TreeLabel>{formatCallTreeOperation(operation)}</TreeLabel>
        {badges.map((badge) => (
          <TreeBadge key={badge.text} tone={badge.tone}>
            {badge.text}
          </TreeBadge>
        ))}
      </TreeRow>
      {childOperations.length > 0 && (
        <div className={frameIndent}>
          {childOperations.map((child) => (
            <CallTreeOperationView
              key={child.id}
              operation={child}
              lookup={lookup}
            />
          ))}
        </div>
      )}
    </div>
  );
});
CallTreeOperationView.displayName = "CallTreeOperationView";

const CallTree = React.memo(({ trace }: { trace: RootTrace }) => {
  const lookup = useMemo(() => groupCallTreeEvents(trace), [trace]);

  return (
    <EventBlock>
      <EventBlockContent>
        <CallTreeOperationView
          operation={{
            kind: "frame",
            id: trace.frames[0]!.id,
            startedAt: trace.frames[0]!.startedAt,
            order: idOrder(trace.frames[0]!.id),
            frame: trace.frames[0]!,
          }}
          lookup={lookup}
        />
      </EventBlockContent>
    </EventBlock>
  );
});
CallTree.displayName = "CallTree";

const TraceDetails = React.memo(({
  trace,
  onBack,
}: {
  trace: RootTrace;
  onBack?: () => void;
}) => {
  const [tab, setTab] = useState<"overview" | "data" | "mutations" | "tree">(
    "overview",
  );
  const contentRef = useRef<HTMLDivElement>(null);

  const tone = statusTone(trace.status);

  return (
    <Detail>
      <DetailHeader>
        <DetailHeaderLeft>
          {onBack ? (
            <BackButton aria-label="Back to traces" onClick={onBack}>
              ←
            </BackButton>
          ) : null}
          <DetailTitle>
            <strong>{trace.name}</strong>
            <span>
              {trace.kind} · {formatTime(trace.startedAt)}
            </span>
          </DetailTitle>
        </DetailHeaderLeft>
        <HeaderBadges>
          <StatusPill tone={tone}>
            <StatusDot tone={tone} />
            {formatDuration(trace.durationMs)}
          </StatusPill>
        </HeaderBadges>
      </DetailHeader>
      <Tabs>
        <Tab selected={tab === "overview"} onClick={() => setTab("overview")}>
          Overview
        </Tab>
        <Tab selected={tab === "data"} onClick={() => setTab("data")}>
          Queries
        </Tab>
        <Tab selected={tab === "mutations"} onClick={() => setTab("mutations")}>
          Mutations
        </Tab>
        <Tab selected={tab === "tree"} onClick={() => setTab("tree")}>
          Call Tree
        </Tab>
      </Tabs>
      <Content ref={contentRef}>
        {tab === "overview" && <TraceOverview trace={trace} />}
        {tab === "data" && <SelectEvents events={trace.commandEvents} />}
        {tab === "mutations" && (
          <MutationEvents
            key={trace.id}
            events={trace.mutationEvents}
            scrollParentRef={contentRef}
          />
        )}
        {tab === "tree" && <CallTree trace={trace} />}
      </Content>
    </Detail>
  );
});
TraceDetails.displayName = "TraceDetails";

const DevtoolsPanelInner = ({
  db,
  maxTraces = 200,
  theme = "system",
  position = "bottom",
  embedded = false,
  onClose,
}: HyperDBDevtoolsPanelProps) => {
  const [listWidth, setListWidth] = useState(readStoredListWidth);
  const [panelHeight, setPanelHeight] = useState(readStoredPanelHeight);
  const [skipCached, setSkipCached] = useState(readStoredSkipCached);
  const [kindFilter, setKindFilter] =
    useState<TraceKindFilter>(readStoredKindFilter);
  const [sortField, setSortField] =
    useState<TraceSortField>(readStoredSortField);
  const [sortDir, setSortDir] = useState<TraceSortDir>(readStoredSortDir);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const isDraggingRef = useRef(false);
  const shellRef = useRef<HTMLElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const panelDividerRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);

  const isVerticallyResizable =
    !embedded && (position === "top" || position === "bottom");

  const handleDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = listWidth;
    isDraggingRef.current = true;

    if (dividerRef.current) dividerRef.current.dataset.dragging = "true";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (ev: MouseEvent) => {
      const next = Math.max(
        minListWidth,
        Math.min(maxListWidth, startWidth + ev.clientX - startX),
      );
      setListWidth(next);
      writeStoredListWidth(next);
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      if (dividerRef.current) delete dividerRef.current.dataset.dragging;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  const handlePanelResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = panelHeight;
    isDraggingRef.current = true;

    if (panelDividerRef.current)
      panelDividerRef.current.dataset.dragging = "true";
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (ev: MouseEvent) => {
      // Bottom panels grow upward, top panels grow downward.
      const delta =
        position === "top" ? ev.clientY - startY : startY - ev.clientY;
      const maxHeight = (globalThis.window?.innerHeight ?? 1200) - 40;
      const next = Math.max(
        minPanelHeight,
        Math.min(maxHeight, startHeight + delta),
      );
      setPanelHeight(next);
      writeStoredPanelHeight(next);
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      if (panelDividerRef.current)
        delete panelDividerRef.current.dataset.dragging;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  const currentDBInfo = useMemo(
    () => (db ? getTraceDBInfo(db) : undefined),
    [db],
  );
  const traces = useSyncSelector({
    selector: traceStoreTraces,
    args: { maxTraces, kind: kindFilter, sortField, sortDir },
    defaultValue: [],
  });

  useEffect(() => {
    hyperDBTraceStore.setMaxTraces(maxTraces);
  }, [maxTraces]);

  useEffect(() => {
    const el = shellRef.current;
    const ResizeObserverCtor = globalThis.ResizeObserver;
    if (!el || !ResizeObserverCtor) return;

    const updateNarrow = (width: number) => {
      setIsNarrow(width > 0 && width < narrowBreakpoint);
    };

    updateNarrow(el.getBoundingClientRect().width);

    const observer = new ResizeObserverCtor((entries) => {
      const entry = entries[0];
      if (entry) updateNarrow(entry.contentRect.width);
    });
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  const observedDBOptions = useMemo(
    () => addCurrentDBOption(getTraceDBOptions(traces), currentDBInfo),
    [currentDBInfo, traces],
  );
  const [knownDBOptions, setKnownDBOptions] =
    useState<TraceDBOption[]>(observedDBOptions);
  const dbOptions = useMemo(
    () => mergeDBOptions(knownDBOptions, observedDBOptions),
    [knownDBOptions, observedDBOptions],
  );
  const hasMultipleDBs = dbOptions.length > 1;
  const [selectedDBId, setSelectedDBId] = useState<string | undefined>(
    currentDBInfo?.id,
  );
  const [selectedTraceId, setSelectedTraceId] = useState<string | undefined>();
  const fallbackDBId =
    dbOptions.find((option) => option.id === currentDBInfo?.id)?.id ??
    dbOptions[0]?.id;
  const activeDBId =
    hasMultipleDBs && selectedDBId
      ? dbOptions.some((option) => option.id === selectedDBId)
        ? selectedDBId
        : fallbackDBId
      : hasMultipleDBs
        ? fallbackDBId
        : undefined;
  const { visibleTraces, selectedTrace } = useSyncSelector({
    selector: traceStoreTraceSelection,
    args: {
      maxTraces,
      kind: kindFilter,
      skipCached,
      sortField,
      sortDir,
      autoSelectFirst: !isNarrow,
      ...(activeDBId !== undefined ? { dbKey: activeDBId } : {}),
      ...(selectedTraceId !== undefined ? { selectedTraceId } : {}),
    },
    defaultValue: emptyTraceSelection,
  });

  useEffect(() => {
    setKnownDBOptions((currentOptions) => {
      const nextOptions = mergeDBOptions(currentOptions, observedDBOptions);

      return areDBOptionsEqual(currentOptions, nextOptions)
        ? currentOptions
        : nextOptions;
    });
  }, [observedDBOptions]);

  useEffect(() => {
    if (!hasMultipleDBs) return;
    if (activeDBId && activeDBId !== selectedDBId) {
      setSelectedDBId(activeDBId);
    }
  }, [activeDBId, hasMultipleDBs, selectedDBId]);

  useEffect(() => {
    if (!selectedTraceId) return;
    if (!visibleTraces.some((trace) => trace.id === selectedTraceId)) {
      setSelectedTraceId(undefined);
    }
  }, [selectedTraceId, visibleTraces]);

  useEffect(() => {
    if (!optionsOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!optionsRef.current?.contains(event.target as Node)) {
        setOptionsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [optionsOpen]);

  const toggleSkipCached = useCallback((next: boolean) => {
    setSkipCached(next);
    writeStoredSkipCached(next);
  }, []);

  const selectKindFilter = useCallback((next: TraceKindFilter) => {
    setKindFilter(next);
    writeStoredKindFilter(next);
    setSelectedTraceId(undefined);
  }, []);

  const toggleSortField = useCallback(() => {
    const next: TraceSortField =
      sortField === "created" ? "duration" : "created";
    setSortField(next);
    writeStoredSortField(next);
  }, [sortField]);

  const toggleSortDir = useCallback(() => {
    const next: TraceSortDir = sortDir === "desc" ? "asc" : "desc";
    setSortDir(next);
    writeStoredSortDir(next);
  }, [sortDir]);

  const clearVisibleTraces = useCallback(() => {
    if (hasMultipleDBs && activeDBId) {
      hyperDBTraceStore.clearDB(
        activeDBId === unassignedDBId ? undefined : activeDBId,
      );
      return;
    }

    hyperDBTraceStore.clear();
  }, [activeDBId, hasMultipleDBs]);

  const handleSelectTrace = useCallback((id: string) => {
    setSelectedTraceId(id);
  }, []);

  // The selector auto-falls back to the first trace so the desktop detail pane
  // is never empty. On narrow layouts we want a list-first view instead, so the
  // overlay only opens for an explicit selection (and "Back" can close it).
  const detailTrace = isNarrow
    ? selectedTraceId !== undefined
      ? selectedTrace
      : undefined
    : selectedTrace;

  return (
    <Shell
      ref={shellRef}
      position={position}
      embedded={embedded}
      theme={theme}
      style={{
        gridTemplateColumns: isNarrow
          ? "minmax(0, 1fr)"
          : `${listWidth}px minmax(0, 1fr)`,
        ...(isVerticallyResizable ? { height: `${panelHeight}px` } : {}),
      }}
    >
      {isVerticallyResizable && !isNarrow ? (
        <PanelResizeDivider
          ref={panelDividerRef}
          position={position}
          onMouseDown={handlePanelResizeMouseDown}
        />
      ) : null}
      <TraceList>
        {!isNarrow ? (
          <ResizeDivider
            ref={dividerRef}
            onMouseDown={handleDividerMouseDown}
          />
        ) : null}
        <Toolbar>
          <Title>
            <LogoDot />
            HyperDB
          </Title>
          <ToolbarActions>
            {hasMultipleDBs ? (
              <DBSelect
                aria-label="HyperDB database"
                value={activeDBId}
                onChange={(event) => {
                  setSelectedDBId(event.currentTarget.value);
                  setSelectedTraceId(undefined);
                }}
              >
                {dbOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </DBSelect>
            ) : null}
            <TraceCount>{visibleTraces.length} traces</TraceCount>
            <OptionsWrapper ref={optionsRef}>
              <Button
                aria-haspopup="true"
                aria-expanded={optionsOpen}
                onClick={() => setOptionsOpen((open) => !open)}
              >
                Options
              </Button>
              {optionsOpen ? (
                <OptionsPopup>
                  <OptionLabel>
                    <input
                      type="checkbox"
                      checked={skipCached}
                      onChange={(event) =>
                        toggleSkipCached(event.currentTarget.checked)
                      }
                    />
                    Skip cached selectors
                  </OptionLabel>
                </OptionsPopup>
              ) : null}
            </OptionsWrapper>
            <Button onClick={clearVisibleTraces}>Clear</Button>
            {onClose ? (
              <Button aria-label="Close HyperDB Devtools" onClick={onClose}>
                ✕
              </Button>
            ) : null}
          </ToolbarActions>
        </Toolbar>
        <FilterBar>
          <SegmentedControl role="tablist" aria-label="Filter traces by kind">
            {kindFilterOptions.map((option) => (
              <Segment
                key={option.value}
                role="tab"
                aria-selected={kindFilter === option.value}
                selected={kindFilter === option.value}
                onClick={() => selectKindFilter(option.value)}
              >
                {option.dot ? <SegmentDot kind={option.dot} /> : null}
                {option.label}
              </Segment>
            ))}
          </SegmentedControl>
          <SortControls>
            <SortButton
              onClick={toggleSortField}
              title="Toggle sort field"
              aria-label={`Sort by ${sortField}. Click to change.`}
            >
              <SortButtonLabel>Sort</SortButtonLabel>
              <SortButtonValue>{sortField}</SortButtonValue>
            </SortButton>
            <SortDirButton
              onClick={toggleSortDir}
              title={`Sort ${sortDir === "desc" ? "descending" : "ascending"}`}
              aria-label={`Sort direction ${
                sortDir === "desc" ? "descending" : "ascending"
              }. Click to change.`}
            >
              {sortDir === "desc" ? "↓" : "↑"}
            </SortDirButton>
          </SortControls>
        </FilterBar>
        <TraceRowsView
          traces={visibleTraces}
          selectedTraceId={detailTrace?.id}
          onSelectTrace={handleSelectTrace}
        />
      </TraceList>
      {detailTrace ? (
        isNarrow ? (
          <MobileDetailOverlay>
            <TraceDetails
              key={detailTrace.id}
              trace={detailTrace}
              onBack={() => setSelectedTraceId(undefined)}
            />
          </MobileDetailOverlay>
        ) : (
          <TraceDetails key={detailTrace.id} trace={detailTrace} />
        )
      ) : isNarrow ? null : (
        <Empty>No traces</Empty>
      )}
    </Shell>
  );
};

const DevtoolsTraceDBProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  useEffect(() => hyperDBTraceStore.activate(), []);

  return <DBProvider value={hyperDBTraceStore.getDB()}>{children}</DBProvider>;
};

const ContextPanel = (props: Omit<HyperDBDevtoolsPanelProps, "db">) => {
  return <DevtoolsPanelInner {...props} />;
};

export const HyperDBDevtoolsPanel = (props: HyperDBDevtoolsPanelProps) => (
  <DevtoolsTraceDBProvider>
    {props.db ? (
      <DevtoolsPanelInner {...props} />
    ) : (
      <ContextPanel
        maxTraces={props.maxTraces}
        theme={props.theme}
        position={props.position}
        embedded={props.embedded}
        onClose={props.onClose}
      />
    )}
  </DevtoolsTraceDBProvider>
);

export const HyperDBDevtools = ({
  db,
  initialIsOpen = false,
  position = "bottom",
  buttonPosition = "bottom-right",
  maxTraces = 200,
  theme = "system",
}: HyperDBDevtoolsProps) => {
  const [isOpen, setIsOpen] = useState(() =>
    readStoredOpenState(initialIsOpen),
  );

  useEffect(() => {
    writeStoredOpenState(isOpen);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  return (
    <>
      <ToggleButton
        buttonPosition={buttonPosition}
        theme={theme}
        aria-label={isOpen ? "Close HyperDB Devtools" : "Open HyperDB Devtools"}
        onClick={() => setIsOpen((open) => !open)}
      >
        <ToggleDot />
        HDB
      </ToggleButton>
      {isOpen && (
        <HyperDBDevtoolsPanel
          db={db}
          maxTraces={maxTraces}
          theme={theme}
          position={position}
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
};

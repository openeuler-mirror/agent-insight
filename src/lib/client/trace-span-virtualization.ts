import type { AgentEvent, AgentNode } from '../engine/observability/agent-trace';
import type { SpanScrollAnchor } from './trace-span-scroll';

export interface SpanEventEntry {
    event: AgentEvent;
    eventIndex: number;
    children: SpanEventEntry[];
}
interface SpanRowPosition {
    key: string;
    height: number;
    node: AgentNode;
    depth: number;
    isLast: boolean;
    prefixBits: boolean[];
    isExpanded: boolean;
    hasChildren: boolean;
    parentKey?: string;
    position: number;
    size: number;
}
export type SpanTreeRow = SpanRowPosition & (
    { kind: 'agent' } | { kind: 'event'; event: AgentEvent; eventIndex: number; childNode?: AgentNode }
);

export function flattenSpanRows(
    root: AgentNode,
    nodes: ReadonlyMap<string, AgentNode>,
    expanded: ReadonlySet<string>,
    eventEntries: (events: AgentEvent[]) => SpanEventEntry[],
    matches: (entry: SpanEventEntry, owner: string) => boolean,
): SpanTreeRow[] {
    const rows: SpanTreeRow[] = [];
    const visitAgent = (node: AgentNode, depth: number, isLast: boolean, prefixBits: boolean[], parentKey?: string) => {
        const key = `a:${node.id}`;
        const anchored = new Set(node.events.map(event => event.spawnedChildId).filter(Boolean));
        const children = node.children.filter(child => !anchored.has(child.id));
        const hasChildren = node.events.length > 0 || children.length > 0;
        const isExpanded = expanded.has(key);
        rows.push({ kind: 'agent', key, height: 34, node, depth, isLast, prefixBits, parentKey, hasChildren, isExpanded, position: 0, size: 0 });
        if (!hasChildren || !isExpanded) return;
        const visitEvent = (entry: SpanEventEntry, eventDepth: number, last: boolean, bits: boolean[], ownerKey: string) => {
            const event = entry.event;
            const childNode = event.spawnedChildId ? nodes.get(event.spawnedChildId) : undefined;
            if (event.treeHidden) {
                if (childNode) visitAgent(childNode, eventDepth, last, bits, ownerKey);
                return;
            }
            if (!matches(entry, node.id)) return;
            const eventKey = `e:${node.id}:${entry.eventIndex}`;
            const hasContent = entry.children.length > 0 || Boolean(childNode);
            const open = hasContent && expanded.has(eventKey);
            rows.push({ kind: 'event', key: eventKey, height: 30, node, event, eventIndex: entry.eventIndex, childNode,
                depth: eventDepth, isLast: last && !open, prefixBits: bits, parentKey: ownerKey,
                hasChildren: hasContent, isExpanded: open, position: 0, size: 0 });
            if (!open) return;
            const descendantBits = [...bits, !last];
            entry.children.forEach((child, index) => visitEvent(child, eventDepth + 1, index === entry.children.length - 1 && !childNode, descendantBits, eventKey));
            if (childNode) visitAgent(childNode, eventDepth + 1, true, descendantBits, eventKey);
        };
        const entries = eventEntries(node.events);
        const bits = depth === 0 ? [] : [...prefixBits, !isLast];
        entries.forEach((entry, index) => visitEvent(entry, depth + 1, index === entries.length - 1 && children.length === 0, bits, key));
        children.forEach((child, index) => visitAgent(child, depth + 1, index === children.length - 1, bits, key));
    };
    visitAgent(root, 0, true, []);
    const siblings = new Map<string | undefined, SpanTreeRow[]>();
    for (const row of rows) {
        const group = siblings.get(row.parentKey) ?? [];
        group.push(row); siblings.set(row.parentKey, group);
    }
    for (const group of siblings.values()) group.forEach((row, index) => { row.position = index + 1; row.size = group.length; });
    return rows;
}

export type SpanLayout = ReturnType<typeof buildSpanLayout>;
export type SpanWindow = { start: number; end: number; top: number; bottom: number };
export const SPAN_VIRTUAL_THRESHOLD = 200;

export function buildSpanLayout(rows: readonly { key: string; height: number }[]) {
    const offsets = [0];
    const indexByKey = new Map<string, number>();
    rows.forEach((row, index) => {
        indexByKey.set(row.key, index);
        offsets.push(offsets[index] + row.height);
    });
    return { rows, offsets, indexByKey, total: offsets[rows.length] };
}

function lowerBound(offsets: number[], value: number): number {
    let left = 0, right = offsets.length;
    while (left < right) {
        const middle = (left + right) >>> 1;
        if (offsets[middle] < value) left = middle + 1;
        else right = middle;
    }
    return left;
}

export function spanWindow(layout: SpanLayout, scrollTop: number, clientHeight: number, overscan = 8): SpanWindow {
    const count = layout.rows.length;
    if (count <= SPAN_VIRTUAL_THRESHOLD) return { start: 0, end: count, top: 0, bottom: 0 };
    const height = Math.max(1, clientHeight || 480);
    const top = Math.max(0, Math.min(scrollTop, Math.max(0, layout.total - height)));
    const start = Math.max(0, lowerBound(layout.offsets, top) - 1 - overscan);
    const end = Math.min(count, lowerBound(layout.offsets, top + height) + overscan);
    return { start, end, top: layout.offsets[start], bottom: layout.total - layout.offsets[end] };
}

function firstVisibleIndex(layout: SpanLayout, scrollTop: number, inset: number): number {
    const offset = Math.max(0, scrollTop - inset);
    let index = lowerBound(layout.offsets, offset);
    if (layout.offsets[index] > offset) index--;
    return Math.max(0, Math.min(layout.rows.length - 1, index));
}

export function spanKeyboardIndex(
    layout: SpanLayout, focusedKey: string | null | undefined, scrollTop: number,
    clientHeight: number, key: string, inset = 4,
): number | null {
    if (!layout.rows.length) return null;
    const focused = focusedKey ? layout.indexByKey.get(focusedKey) : undefined;
    let index = focused ?? firstVisibleIndex(layout, scrollTop, inset);
    if (key === 'Home') index = 0;
    else if (key === 'End') index = layout.rows.length - 1;
    else if (key === 'ArrowUp') index -= focused === undefined ? 0 : 1;
    else if (key === 'ArrowDown') index += focused === undefined ? 0 : 1;
    else if (key === 'PageUp') index -= Math.max(1, Math.floor(clientHeight / 30));
    else if (key === 'PageDown') index += Math.max(1, Math.floor(clientHeight / 30));
    else if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
    return Math.max(0, Math.min(layout.rows.length - 1, index));
}

export function spanModelAnchor(layout: SpanLayout, scrollTop: number, inset = 4): SpanScrollAnchor | null {
    if (!layout.rows.length) return null;
    const index = firstVisibleIndex(layout, scrollTop, inset);
    return { key: layout.rows[index].key, offset: layout.offsets[index] + inset - scrollTop };
}

export function spanScrollOffset(
    layout: SpanLayout, key: string, clientHeight: number, align: 'center' | 'nearest', currentTop: number, inset = 4,
): number | null {
    const index = layout.indexByKey.get(key);
    if (index === undefined) return null;
    const top = layout.offsets[index] + inset;
    const bottom = layout.offsets[index + 1] + inset;
    if (align === 'nearest') {
        if (top < currentTop) return Math.max(0, top);
        if (bottom > currentTop + clientHeight) return Math.max(0, bottom - clientHeight);
        return currentTop;
    }
    return Math.max(0, (top + bottom - clientHeight) / 2);
}

export function spanAnchorOffset(layout: SpanLayout, anchor: SpanScrollAnchor, inset = 4): number | null {
    const index = layout.indexByKey.get(anchor.key);
    return index === undefined ? null : Math.max(0, layout.offsets[index] + inset - anchor.offset);
}

export function createSpanWindowStore(getViewport: () => { scrollTop: number; clientHeight: number } | null) {
    let layout = buildSpanLayout([]);
    let snapshot: SpanWindow = { start: 0, end: 0, top: 0, bottom: 0 };
    const listeners = new Set<() => void>();
    let scrollTop = 0;
    const recordPosition = () => { scrollTop = getViewport()?.scrollTop ?? 0; };
    const update = () => {
        recordPosition();
        const viewport = getViewport();
        const next = spanWindow(layout, viewport?.scrollTop ?? 0, viewport?.clientHeight ?? 480);
        if (next.start === snapshot.start && next.end === snapshot.end && next.top === snapshot.top && next.bottom === snapshot.bottom) return;
        snapshot = next; listeners.forEach(listener => listener());
    };
    return {
        getSnapshot: () => snapshot,
        getLayout: () => layout,
        getScrollTop: () => scrollTop,
        recordPosition,
        setLayout(value: SpanLayout) { layout = value; update(); },
        update,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}

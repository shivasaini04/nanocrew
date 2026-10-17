import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIsMobile } from '../hooks/useIsMobile';
import { withAlpha } from '../lib/cr'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CrewAgent {
    id: string;
    name: string;
    type: string;
    emoji?: string;
    status: string;
    color: string | null;
    parent_agent_id: string | null;
    cycles: number;
}

interface CrewEdge {
    type: 'message' | 'spawn' | 'handoff' | 'pipeline';
    from: string;
    to: string;
    count: number;
    last?: string;
}

interface CrewProject {
    id: string;
    name: string;
    agents: string[];
}

interface GraphData {
    agents: CrewAgent[];
    edges: CrewEdge[];
    projects: CrewProject[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncateName(name: string, max: number): string {
    if (name.length <= max) return name;
    return name.slice(0, max - 1).trimEnd() + '…';
}

const STATUS_COLOR: Record<string, string> = {
    running:    'var(--cr-green)',
    idle:       'var(--cr-muted)',
    paused:     'var(--cr-warn)',
    failed:     'var(--cr-error-str)',
    installing: 'var(--cr-cyan)',
    starting:   'var(--cr-cyan)',
};

// ─── Force-directed layout ───────────────────────────────────────────────────
//
// Nodes that share an edge (or a parent-child / same-project relationship) attract
// each other via spring forces; all node pairs repel via Coulomb-like forces.
// Result: pipelines string out linearly, project members cluster, isolated agents
// drift to the edges. Deterministic seeding by agent id keeps layouts stable across
// renders.

interface NodePos { id: string; x: number; y: number; }

function computeLayout(
    agents: CrewAgent[],
    edges: CrewEdge[],
    projects: CrewProject[],
    width: number,
    height: number,
): NodePos[] {
    if (!agents.length) return [];
    if (agents.length === 1) return [{ id: agents[0].id, x: width / 2, y: height / 2 }];

    const sorted = [...agents].sort((a, b) => a.id.localeCompare(b.id));
    const cx = width / 2, cy = height / 2;

    // Deterministic [0, 1) from string — keeps seeding stable across reloads
    const hash = (s: string) => {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return Math.abs(h) / 0x7fffffff;
    };

    type Particle = { id: string; x: number; y: number; vx: number; vy: number };

    // Seed project centroids evenly around a large circle so clusters start pre-separated,
    // reducing how much force simulation has to fight the initial overlap.
    const clusterRadius = Math.min(width, height) * 0.30;
    const projectCentroids = new Map<string, { x: number; y: number }>();
    projects.forEach((proj, i) => {
        const angle = (i / Math.max(projects.length, 1)) * Math.PI * 2 - Math.PI / 2;
        projectCentroids.set(proj.id, {
            x: cx + Math.cos(angle) * clusterRadius,
            y: cy + Math.sin(angle) * clusterRadius,
        });
    });
    const agentToProject = new Map<string, string>();
    for (const proj of projects) {
        for (const aid of proj.agents) agentToProject.set(aid, proj.id);
    }

    const memberScatter = 70;
    const seedRadius = Math.min(width, height) * 0.22;
    const particles: Particle[] = sorted.map(a => {
        const projId = agentToProject.get(a.id);
        if (projId) {
            const c = projectCentroids.get(projId)!;
            const angle = hash(a.id) * Math.PI * 2;
            const r = memberScatter * (0.3 + hash(a.id + '_r') * 0.7);
            return { id: a.id, x: c.x + Math.cos(angle) * r, y: c.y + Math.sin(angle) * r, vx: 0, vy: 0 };
        }
        const angle = hash(a.id) * Math.PI * 2;
        const r = seedRadius * (0.5 + hash(a.id + '_r') * 0.6);
        return { id: a.id, x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, vx: 0, vy: 0 };
    });
    const byId = new Map(particles.map(p => [p.id, p]));

    // Build link list — real edges + implicit parent-child + same-project
    type Link = { a: Particle; b: Particle; targetDist: number; strength: number };
    const links: Link[] = [];

    for (const e of edges) {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (a && b && a !== b) links.push({ a, b, targetDist: 150, strength: 0.08 });
    }
    for (const agent of sorted) {
        if (!agent.parent_agent_id) continue;
        const p = byId.get(agent.parent_agent_id), c = byId.get(agent.id);
        if (p && c) links.push({ a: p, b: c, targetDist: 75, strength: 0.22 });
    }
    // Same-project pull — keep members together as a coherent cluster but with enough
    // spread that edges and labels between them are readable. 220/0.03 gives a roomy
    // project box without sprawling enough to trap non-members back in the middle.
    for (const proj of projects) {
        for (let i = 0; i < proj.agents.length; i++) {
            for (let j = i + 1; j < proj.agents.length; j++) {
                const a = byId.get(proj.agents[i]), b = byId.get(proj.agents[j]);
                if (a && b) links.push({ a, b, targetDist: 220, strength: 0.03 });
            }
        }
    }

    // Simulation params
    const ITERATIONS = 320;
    const REPULSION = 9000;
    const CENTERING = 0.006;
    const DAMPING = 0.85;
    const MAX_VEL = 28;
    const COLLISION_R = 86;
    const PROJECT_BUFFER = 100; // non-members must stay this far from a project's bbox

    // Build per-agent project membership so we can apply boundary forces
    const projectMembership = new Map<string, Set<string>>(); // agentId -> set of projectIds it belongs to
    for (const proj of projects) {
        for (const aid of proj.agents) {
            if (!projectMembership.has(aid)) projectMembership.set(aid, new Set());
            projectMembership.get(aid)!.add(proj.id);
        }
    }

    for (let iter = 0; iter < ITERATIONS; iter++) {
        const cooling = 1 - iter / ITERATIONS;

        // Pairwise repulsion + hard collision separation
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const p1 = particles[i], p2 = particles[j];
                let dx = p1.x - p2.x, dy = p1.y - p2.y;
                let dist2 = dx * dx + dy * dy;
                if (dist2 < 1) { dist2 = 1; dx = (hash(p1.id + p2.id) - 0.5); dy = (hash(p2.id + p1.id) - 0.5); }
                const dist = Math.sqrt(dist2);
                const force = REPULSION / dist2;
                p1.vx += (dx / dist) * force;
                p1.vy += (dy / dist) * force;
                p2.vx -= (dx / dist) * force;
                p2.vy -= (dy / dist) * force;

                if (dist < COLLISION_R) {
                    const push = (COLLISION_R - dist) * 0.5;
                    p1.x += (dx / dist) * push;
                    p1.y += (dy / dist) * push;
                    p2.x -= (dx / dist) * push;
                    p2.y -= (dy / dist) * push;
                }
            }
        }

        // Spring forces
        for (const link of links) {
            const dx = link.b.x - link.a.x;
            const dy = link.b.y - link.a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = link.strength * (dist - link.targetDist);
            link.a.vx += (dx / dist) * force;
            link.a.vy += (dy / dist) * force;
            link.b.vx -= (dx / dist) * force;
            link.b.vy -= (dy / dist) * force;
        }

        // Project boundary force — non-member nodes get firmly pushed out of each
        // project's inflated bbox so the rectangle visually encloses only its members.
        // Earlier version used a per-axis nudge that lost to opposing forces when a
        // non-member sat at the dead center of a project ring (the bug Data Scientist
        // hit). New version applies a radial push from the project centroid, so the
        // direction is always away from the cluster — no axis-cancellation traps.
        for (const proj of projects) {
            const members = proj.agents.map(aid => byId.get(aid)).filter(Boolean) as Particle[];
            if (members.length < 1) continue;
            const xs = members.map(m => m.x), ys = members.map(m => m.y);
            const px1 = Math.min(...xs) - PROJECT_BUFFER;
            const px2 = Math.max(...xs) + PROJECT_BUFFER;
            const py1 = Math.min(...ys) - PROJECT_BUFFER;
            const py2 = Math.max(...ys) + PROJECT_BUFFER;
            const cxProj = (px1 + px2) / 2;
            const cyProj = (py1 + py2) / 2;
            const projW = (px2 - px1) / 2;
            const projH = (py2 - py1) / 2;

            for (const p of particles) {
                if (projectMembership.get(p.id)?.has(proj.id)) continue; // members aren't repelled by their own project
                if (!(p.x > px1 && p.x < px2 && p.y > py1 && p.y < py2)) continue;

                // Vector from centroid to particle. If the particle is exactly on the
                // centroid (rare but happens at init), nudge it in a deterministic
                // direction based on its id hash so it doesn't get stuck.
                let dx = p.x - cxProj;
                let dy = p.y - cyProj;
                let dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 1) {
                    const a = hash(p.id) * Math.PI * 2;
                    dx = Math.cos(a); dy = Math.sin(a); dist = 1;
                }

                // How "deeply" trapped — closer to centroid means stronger eject.
                // Scaled by the larger of bbox half-extents so the strength is
                // proportional to project size.
                const reach = Math.max(projW, projH);
                const depth = Math.max(0, reach - dist) / reach;  // 0..1
                const strength = 4 + depth * 12;                   // 4..16 per tick

                p.vx += (dx / dist) * strength;
                p.vy += (dy / dist) * strength;

                // Hard separation if the particle is genuinely inside the inner bbox
                // (past the buffer ring), bypassing the velocity loop's damping.
                const innerX1 = Math.min(...xs), innerX2 = Math.max(...xs);
                const innerY1 = Math.min(...ys), innerY2 = Math.max(...ys);
                if (p.x > innerX1 && p.x < innerX2 && p.y > innerY1 && p.y < innerY2) {
                    p.x += (dx / dist) * 2;
                    p.y += (dy / dist) * 2;
                }
            }
        }

        // Weak centering pull
        for (const p of particles) {
            p.vx += (cx - p.x) * CENTERING;
            p.vy += (cy - p.y) * CENTERING;
        }

        // Integrate with damping (cools over time so it settles)
        for (const p of particles) {
            p.vx *= DAMPING * cooling;
            p.vy *= DAMPING * cooling;
            const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
            if (v > MAX_VEL) { p.vx = (p.vx / v) * MAX_VEL; p.vy = (p.vy / v) * MAX_VEL; }
            p.x += p.vx;
            p.y += p.vy;
        }
    }

    return particles.map(p => ({ id: p.id, x: p.x, y: p.y }));
}

// ─── Edge color ───────────────────────────────────────────────────────────────

const EDGE_COLORS: Record<string, string> = {
    message:  'var(--cr-green)',
    spawn:    'var(--cr-purple)',
    handoff:  'var(--cr-orange)',
    pipeline: 'var(--cr-cyan)',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function CrewMapPage() {
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    const svgRef = useRef<SVGSVGElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const [data, setData] = useState<GraphData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dims, setDims] = useState({ w: 900, h: 600 });
    const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);
    const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
    const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
    const [filter, setFilter] = useState<'all' | 'message' | 'spawn' | 'handoff' | 'pipeline'>('all');

    // Panning state
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);
    const dragging = useRef(false);
    const lastMouse = useRef({ x: 0, y: 0 });
    const hasAutoFit = useRef(false);

    // Per-project drag offsets — applied on top of physics positions so users can
    // manually reposition clusters without re-running the simulation.
    // Persisted to localStorage so positions survive page reloads.
    const [projectOffsets, setProjectOffsets] = useState<Record<string, { x: number; y: number }>>(() => {
        try { return JSON.parse(localStorage.getItem('crew-map-offsets') ?? '{}'); } catch { return {}; }
    });
    const draggingProject = useRef<string | null>(null);
    const projectDragStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });

    useEffect(() => {
        localStorage.setItem('crew-map-offsets', JSON.stringify(projectOffsets));
    }, [projectOffsets]);

    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            const r = await fetch('/api/crew/graph');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            setData(d);
            setError(null);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    // Auto-fit on first successful load — compute bounding box of all node positions and center
    useEffect(() => {
        if (!data || hasAutoFit.current || !dims.w || !dims.h) return;
        const positions = computeLayout(data.agents, data.edges, data.projects, dims.w, dims.h);
        if (positions.length === 0) return;
        const xs = positions.map(p => p.x);
        const ys = positions.map(p => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const padding = 120;
        const contentW = Math.max(maxX - minX, 1) + padding * 2;
        const contentH = Math.max(maxY - minY, 1) + padding * 2;
        const scale = Math.min(dims.w / contentW, dims.h / contentH, 1.25);
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        setZoom(scale);
        setPan({ x: dims.w / 2 - cx * scale, y: dims.h / 2 - cy * scale });
        hasAutoFit.current = true;
    }, [data, dims]);

    // Observe container size
    useEffect(() => {
        if (!containerRef.current) return;
        const ro = new ResizeObserver(entries => {
            for (const e of entries) {
                const { width, height } = e.contentRect;
                setDims({ w: Math.max(width, 400), h: Math.max(height, 400) });
            }
        });
        ro.observe(containerRef.current);
        return () => ro.disconnect();
    }, []);

    // Pan / project-drag handlers
    const onMouseDown = (e: React.MouseEvent) => {
        if ((e.target as SVGElement).closest('.crew-node')) return;
        if ((e.target as SVGElement).closest('.crew-hull')) return; // hull's own handler takes over
        dragging.current = true;
        lastMouse.current = { x: e.clientX, y: e.clientY };
    };
    const onMouseMove = (e: React.MouseEvent) => {
        if (draggingProject.current) {
            const pid = draggingProject.current;
            const start = projectDragStart.current;
            const dx = (e.clientX - start.mx) / zoom;
            const dy = (e.clientY - start.my) / zoom;
            setProjectOffsets(prev => ({ ...prev, [pid]: { x: start.ox + dx, y: start.oy + dy } }));
            return;
        }
        if (!dragging.current) return;
        const dx = e.clientX - lastMouse.current.x;
        const dy = e.clientY - lastMouse.current.y;
        lastMouse.current = { x: e.clientX, y: e.clientY };
        setPan(p => ({ x: p.x + dx, y: p.y + dy }));
    };
    const onMouseUp = () => { dragging.current = false; draggingProject.current = null; };
    const onWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        setZoom(z => Math.max(0.3, Math.min(3, z * delta)));
    };

    // Touch pan + pinch-zoom — mirrors the mouse handlers above. One finger pans (same
    // rule as mouse: ignore touches starting on a node/hull, those have their own click/drag),
    // two fingers pinch-zoom around the pinch midpoint.
    const pinchStart = useRef<{ dist: number; zoom: number } | null>(null);
    const onTouchStart = (e: React.TouchEvent) => {
        if ((e.target as SVGElement).closest?.('.crew-node')) return;
        if ((e.target as SVGElement).closest?.('.crew-hull')) return;
        if (e.touches.length === 2) {
            const [a, b] = [e.touches[0], e.touches[1]];
            pinchStart.current = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom };
            dragging.current = false;
        } else if (e.touches.length === 1) {
            dragging.current = true;
            lastMouse.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
    };
    const onTouchMove = (e: React.TouchEvent) => {
        if (e.touches.length === 2 && pinchStart.current) {
            e.preventDefault();
            const [a, b] = [e.touches[0], e.touches[1]];
            const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
            const scale = dist / pinchStart.current.dist;
            setZoom(Math.max(0.3, Math.min(3, pinchStart.current.zoom * scale)));
            return;
        }
        if (!dragging.current || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - lastMouse.current.x;
        const dy = e.touches[0].clientY - lastMouse.current.y;
        lastMouse.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        setPan(p => ({ x: p.x + dx, y: p.y + dy }));
    };
    const onTouchEnd = () => { dragging.current = false; pinchStart.current = null; };

    const agents = data?.agents ?? [];
    const rawEdges = data?.edges ?? [];
    const projects = data?.projects ?? [];

    // Memoize the simulation — only recompute when the graph structure changes (not on hover/pan/zoom)
    const positions = useMemo(
        () => computeLayout(agents, rawEdges, projects, dims.w, dims.h),
        [agents, rawEdges, projects, dims.w, dims.h],
    );
    const posMap = useMemo(
        () => Object.fromEntries(positions.map(p => [p.id, p])),
        [positions],
    );

    // Apply per-project manual offsets on top of physics positions
    const effectivePosMap = useMemo(() => {
        const result: Record<string, NodePos> = { ...posMap };
        for (const proj of (data?.projects ?? [])) {
            const off = projectOffsets[proj.id];
            if (!off) continue;
            for (const aid of proj.agents) {
                if (result[aid]) result[aid] = { id: aid, x: result[aid].x + off.x, y: result[aid].y + off.y };
            }
        }
        return result;
    }, [posMap, data?.projects, projectOffsets]);

    if (loading) return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--cr-muted)', fontFamily: 'var(--cr-font-mono)', fontSize: '13px' }}>
            Loading crew graph...
        </div>
    );

    if (error) return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px' }}>
            <span style={{ color: 'var(--cr-red)', fontFamily: 'var(--cr-font-mono)', fontSize: '13px' }}>Error: {error}</span>
            <button onClick={fetchData} style={{ padding: '6px 16px', borderRadius: '6px', background: 'var(--cr-accent)', color: 'var(--cr-on-accent)', border: 'none', cursor: 'pointer', fontSize: '13px' }}>Retry</button>
        </div>
    );

    const edges = filter === 'all' ? rawEdges : rawEdges.filter(e => e.type === filter);

    // Highlight edges connected to hovered node
    const activeEdgeIds = hoveredAgent
        ? new Set(edges.filter(e => e.from === hoveredAgent || e.to === hoveredAgent).map((_, i) => i))
        : null;

    const NODE_R = 34;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 0 }}>
            {/* Header */}
            <div style={{
                padding: isMobile ? '14px 16px 12px' : '20px 28px 16px',
                borderBottom: '1px solid var(--cr-border)',
                display: 'flex', flexDirection: isMobile ? 'column' : 'row',
                alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'space-between',
                gap: isMobile ? '10px' : 0,
                flexShrink: 0,
            }}>
                <div>
                    <h1 style={{ fontFamily: 'var(--cr-font-serif)', fontSize: isMobile ? '20px' : '24px', color: 'var(--cr-cream)', margin: 0 }}>Crew Map</h1>
                    <p style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '13px', color: 'var(--cr-muted)', margin: '4px 0 0' }}>
                        {agents.length} agent{agents.length !== 1 ? 's' : ''} · {rawEdges.length} connection{rawEdges.length !== 1 ? 's' : ''}
                    </p>
                </div>

                <div style={{
                    display: 'flex', alignItems: 'center', gap: '12px',
                    overflowX: isMobile ? 'auto' : 'visible',
                    WebkitOverflowScrolling: 'touch',
                }}>
                    {/* Filter pills — each pill shows its edge color as a dot, so this also serves as the legend */}
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                        {(['all', 'message', 'spawn', 'handoff', 'pipeline'] as const).map(f => {
                            const dotColor = f === 'all' ? null : EDGE_COLORS[f];
                            const accent = f === 'all' ? 'var(--cr-accent)' : EDGE_COLORS[f];
                            return (
                                <button key={f} onClick={() => setFilter(f)} style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    padding: '4px 12px',
                                    borderRadius: '100px',
                                    border: '1px solid',
                                    borderColor: filter === f ? accent : 'var(--cr-border)',
                                    background: filter === f ? (f === 'all' ? 'var(--cr-accent-25)' : `${withAlpha(EDGE_COLORS[f], 9)}`) : 'transparent',
                                    color: filter === f ? accent : 'var(--cr-muted)',
                                    fontFamily: 'var(--cr-font-mono)',
                                    fontSize: '10px',
                                    fontWeight: 700,
                                    letterSpacing: '0.06em',
                                    textTransform: 'capitalize',
                                    cursor: 'pointer',
                                    transition: 'all 0.15s'
                                }}>
                                    {dotColor && (
                                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0 }} />
                                    )}
                                    {f}
                                </button>
                            );
                        })}
                    </div>

                    <button onClick={() => { hasAutoFit.current = false; fetchData(); }} style={{ flexShrink: 0, padding: '5px 14px', borderRadius: '6px', border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-sub)', fontFamily: 'var(--cr-font-mono)', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        Refresh
                    </button>
                    <button onClick={() => { setProjectOffsets({}); }} style={{ flexShrink: 0, padding: '5px 14px', borderRadius: '6px', border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-sub)', fontFamily: 'var(--cr-font-mono)', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        Reset Layout
                    </button>
                </div>
            </div>

            {/* Canvas */}
            <div
                ref={containerRef}
                style={{
                    flex: 1,
                    position: 'relative',
                    overflow: 'hidden',
                    cursor: dragging.current ? 'grabbing' : 'grab',
                    backgroundColor: 'var(--cr-bg)',
                    backgroundImage: 'radial-gradient(var(--cr-tint-3) 1px, transparent 1px)',
                    backgroundSize: '24px 24px',
                    touchAction: 'none',
                }}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                onWheel={onWheel}
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                onTouchCancel={onTouchEnd}
            >
                {agents.length === 0 ? (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '48px', opacity: 0.3 }}>🤖</span>
                        <span style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '14px', color: 'var(--cr-muted)' }}>No agents yet. Hire your first agent to see the crew map.</span>
                    </div>
                ) : (
                    <svg
                        ref={svgRef}
                        width={dims.w}
                        height={dims.h}
                        // overflow:visible lets nodes panned beyond the SVG's declared box still
                        // render — the outer container's overflow:hidden still bounds the visible
                        // area, so we don't bleed outside the canvas chrome.
                        style={{ display: 'block', overflow: 'visible' }}
                    >
                        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>

                            {/* Project cluster hulls — draggable; label uses a backdrop pill so it stays readable when nearby nodes are close */}
                            {projects.map(proj => {
                                const pts = proj.agents.map(aid => effectivePosMap[aid]).filter(Boolean);
                                if (pts.length < 1) return null;
                                const label = proj.name.toUpperCase();
                                const labelW = Math.max(label.length * 6.2 + 16, 60);

                                const startHullDrag = (e: React.MouseEvent) => {
                                    e.stopPropagation();
                                    const cur = projectOffsets[proj.id] ?? { x: 0, y: 0 };
                                    draggingProject.current = proj.id;
                                    projectDragStart.current = { mx: e.clientX, my: e.clientY, ox: cur.x, oy: cur.y };
                                };

                                if (pts.length === 1) {
                                    const p = pts[0];
                                    const labelY = p.y - NODE_R - 46;
                                    return (
                                        <g key={proj.id} className="crew-hull" style={{ cursor: 'grab' }} onMouseDown={startHullDrag}>
                                            <circle cx={p.x} cy={p.y} r={NODE_R + 36}
                                                fill="var(--cr-purple-low)" stroke="var(--cr-purple-line)" strokeWidth={1} strokeDasharray="4 4" />
                                            <rect x={p.x - labelW / 2} y={labelY - 9} width={labelW} height={16} rx={8}
                                                fill="var(--cr-bg)" stroke="var(--cr-purple-line)" strokeWidth={1} />
                                            <text x={p.x} y={labelY} textAnchor="middle" dominantBaseline="central"
                                                fontFamily="var(--cr-font-mono)" fontSize={9} fill="var(--cr-purple-line)" letterSpacing={1.2} fontWeight={600}
                                                style={{ pointerEvents: 'none' }}>
                                                {label}
                                            </text>
                                        </g>
                                    );
                                }
                                // Multi-agent bounding box hull
                                const xs = pts.map(p => p.x);
                                const ys = pts.map(p => p.y);
                                const pad = NODE_R + 44;
                                const x1 = Math.min(...xs) - pad, y1 = Math.min(...ys) - pad;
                                const x2 = Math.max(...xs) + pad, y2 = Math.max(...ys) + pad;
                                const midX = (x1 + x2) / 2;
                                const labelY = y1 - 14;
                                return (
                                    <g key={proj.id} className="crew-hull" style={{ cursor: 'grab' }} onMouseDown={startHullDrag}>
                                        <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} rx={18}
                                            fill="var(--cr-purple-low)" stroke="var(--cr-purple-line)" strokeWidth={1} strokeDasharray="6 4" />
                                        <rect x={midX - labelW / 2} y={labelY - 9} width={labelW} height={16} rx={8}
                                            fill="var(--cr-bg)" stroke="var(--cr-purple-line)" strokeWidth={1} />
                                        <text x={midX} y={labelY} textAnchor="middle" dominantBaseline="central"
                                            fontFamily="var(--cr-font-mono)" fontSize={9} fill="var(--cr-purple-line)" letterSpacing={1.2} fontWeight={600}
                                            style={{ pointerEvents: 'none' }}>
                                            {label}
                                        </text>
                                    </g>
                                );
                            })}

                            {/* Edges */}
                            <defs>
                                {Object.entries(EDGE_COLORS).map(([type, color]) => (
                                    <marker key={type} id={`arrow-${type}`} markerWidth={8} markerHeight={8} refX={7} refY={3} orient="auto">
                                        <path d="M0,0 L0,6 L8,3 z" fill={color} opacity={0.7} />
                                    </marker>
                                ))}
                            </defs>

                            {(() => {
                                // Build a per-pair index so multi-edges (handoff + pipeline between
                                // the same two agents) curve in DIFFERENT directions, with the
                                // count badge placed at distinct midpoints. Without this, parallel
                                // edges + count labels stack on top of each other.
                                const pairIndex = new Map<string, number>();
                                const pairCount = new Map<string, number>();
                                edges.forEach(e => {
                                    const key = `${e.from}|${e.to}`;
                                    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
                                });
                                return edges.map((edge, i) => {
                                    const from = effectivePosMap[edge.from];
                                    const to = effectivePosMap[edge.to];
                                    if (!from || !to) return null;

                                    const color = EDGE_COLORS[edge.type];
                                    const isActive = !activeEdgeIds || activeEdgeIds.has(i);
                                    const opacity = isActive ? 0.75 : 0.1;

                                    // Per-pair curvature: 1 edge → centered; 2 edges → ±; 3 → -, 0, +; etc.
                                    const key = `${edge.from}|${edge.to}`;
                                    const idx = pairIndex.get(key) ?? 0;
                                    pairIndex.set(key, idx + 1);
                                    const totalForPair = pairCount.get(key) ?? 1;
                                    // Spread offsets symmetrically around 0
                                    const offsetSlot = totalForPair === 1 ? 0 : (idx - (totalForPair - 1) / 2);

                                    const mx = (from.x + to.x) / 2;
                                    const my = (from.y + to.y) / 2;
                                    const dx = to.x - from.x;
                                    const dy = to.y - from.y;
                                    const len = Math.sqrt(dx * dx + dy * dy) || 1;
                                    const baseCurve = Math.min(40, len * 0.2);
                                    // Stagger multi-edges by 28px per slot for visible separation
                                    const curvature = baseCurve + offsetSlot * 28;
                                    const cpx = mx - dy / len * curvature;
                                    const cpy = my + dx / len * curvature;

                                // Shorten endpoints to not overlap node circles
                                const t = (NODE_R + 4) / len;
                                const sx = from.x + dx * t;
                                const sy = from.y + dy * t;
                                const ex = to.x - dx * t;
                                const ey = to.y - dy * t;

                                const isEdgeHovered = hoveredEdge === i;
                                const showBadge = isActive && (edge.count > 1 || isEdgeHovered);

                                return (
                                    <g key={i}
                                        onMouseEnter={() => setHoveredEdge(i)}
                                        onMouseLeave={() => setHoveredEdge(null)}
                                        style={{ cursor: 'default' }}
                                    >
                                        {/* Wider invisible hit area so the thin path is easy to hover */}
                                        <path
                                            d={`M${sx},${sy} Q${cpx},${cpy} ${ex},${ey}`}
                                            fill="none"
                                            stroke="transparent"
                                            strokeWidth={14}
                                        />
                                        <path
                                            d={`M${sx},${sy} Q${cpx},${cpy} ${ex},${ey}`}
                                            fill="none"
                                            stroke={color}
                                            strokeWidth={isEdgeHovered ? Math.min(2 + Math.log(edge.count + 1), 5) : Math.min(1 + Math.log(edge.count + 1), 4)}
                                            strokeOpacity={isEdgeHovered ? 1 : opacity}
                                            markerEnd={`url(#arrow-${edge.type})`}
                                            style={{ transition: 'stroke-opacity 0.15s, stroke-width 0.15s' }}
                                        />
                                        {/* Count badge — always visible on hover, persistent when count > 1 */}
                                        {showBadge && (
                                            <g>
                                                <rect x={cpx - 9} y={cpy - 9} width={18} height={12} rx={6}
                                                    fill="var(--cr-bg)" stroke={color} strokeOpacity={isEdgeHovered ? 0.9 : 0.5} strokeWidth={1} />
                                                <text x={cpx} y={cpy} textAnchor="middle" dominantBaseline="central"
                                                    fontFamily="var(--cr-font-mono)" fontSize={9} fontWeight={600} fill={color}>
                                                    {edge.count}
                                                </text>
                                            </g>
                                        )}
                                    </g>
                                );
                                });
                            })()}

                            {/* Nodes */}
                            {positions.map(({ id }) => {
                                const { x, y } = effectivePosMap[id] ?? { x: 0, y: 0 };
                                const agent = agents.find(a => a.id === id);
                                if (!agent) return null;
                                const isRunning = agent.status === 'running';
                                const isHovered = hoveredAgent === id;
                                const isSub = !!agent.parent_agent_id;
                                const accentColor = agent.color ?? (isSub ? 'var(--cr-purple)' : 'var(--cr-accent)');
                                const nodeR = isSub ? NODE_R * 0.75 : NODE_R;

                                return (
                                    <g
                                        key={id}
                                        className="crew-node"
                                        transform={`translate(${x},${y})`}
                                        style={{ cursor: 'pointer' }}
                                        onMouseEnter={(e) => { setHoveredAgent(id); setTooltipPos({ x: e.clientX, y: e.clientY }); }}
                                        onMouseMove={(e) => setTooltipPos({ x: e.clientX, y: e.clientY })}
                                        onMouseLeave={() => { setHoveredAgent(null); setTooltipPos(null); }}
                                        onClick={() => navigate(`/agents/${id}`)}
                                    >
                                        {/* Glow ring when running */}
                                        {isRunning && (
                                            <circle r={nodeR + 10} fill="none" stroke={accentColor} strokeWidth={1} opacity={0.25} />
                                        )}

                                        {/* Main circle */}
                                        <circle
                                            r={nodeR}
                                            fill="var(--cr-bg-card)"
                                            stroke={isHovered ? accentColor : (isRunning ? accentColor : 'var(--cr-border)')}
                                            strokeWidth={isHovered ? 2 : 1.5}
                                            style={{ transition: 'stroke 0.15s, stroke-width 0.15s' }}
                                        />

                                        {/* Emoji (use || not ?? to handle empty strings) */}
                                        <text textAnchor="middle" dominantBaseline="central" fontSize={isSub ? 18 : 22} y={-4}>
                                            {(agent.emoji && agent.emoji.trim()) || '🤖'}
                                        </text>

                                        {/* Status dot — distinguishes idle / running / paused / failed */}
                                        <circle
                                            cx={nodeR * 0.7}
                                            cy={-nodeR * 0.7}
                                            r={5}
                                            fill={STATUS_COLOR[agent.status] ?? 'var(--cr-muted)'}
                                            stroke="var(--cr-bg-card)"
                                            strokeWidth={2}
                                        />

                                        {/* Name label with backdrop pill — stays readable when labels nearly align */}
                                        {(() => {
                                            const displayName = truncateName(agent.name.replace('[sub] ', ''), 18);
                                            const fontSize = isSub ? 10 : 11;
                                            const labelW = displayName.length * (fontSize * 0.58) + 12;
                                            const labelY = nodeR + 18;
                                            return (
                                                <>
                                                    <rect
                                                        x={-labelW / 2}
                                                        y={labelY - 8}
                                                        width={labelW}
                                                        height={15}
                                                        rx={7}
                                                        fill="var(--cr-bg)"
                                                        fillOpacity={0.85}
                                                        stroke={isHovered ? accentColor : 'transparent'}
                                                        strokeOpacity={0.4}
                                                        strokeWidth={1}
                                                    />
                                                    <text
                                                        y={labelY}
                                                        textAnchor="middle"
                                                        dominantBaseline="central"
                                                        fontFamily="var(--cr-font-sans)"
                                                        fontSize={fontSize}
                                                        fontWeight={isHovered ? 600 : 400}
                                                        fill={isHovered ? 'var(--cr-cream)' : 'var(--cr-sub)'}
                                                        style={{ transition: 'fill 0.15s', pointerEvents: 'none' }}
                                                    >
                                                        {displayName}
                                                    </text>
                                                </>
                                            );
                                        })()}

                                        {/* Sub-agent badge */}
                                        {isSub && (
                                            <text
                                                y={nodeR + 25}
                                                textAnchor="middle"
                                                fontFamily="var(--cr-font-mono)"
                                                fontSize={8}
                                                fill="var(--cr-purple)"
                                                opacity={0.7}
                                            >
                                                sub
                                            </text>
                                        )}

                                    </g>
                                );
                            })}
                        </g>
                    </svg>
                )}

                {/* Zoom controls */}
                <div style={{ position: 'absolute', bottom: '20px', right: '20px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {[{ label: '+', delta: 1.2 }, { label: '−', delta: 0.8 }, { label: '⊙', delta: 0 }].map(({ label, delta }) => (
                        <button key={label} onClick={() => {
                            if (delta === 0) { setZoom(1); setPan({ x: 0, y: 0 }); }
                            else setZoom(z => Math.max(0.3, Math.min(3, z * delta)));
                        }} style={{
                            width: '30px', height: '30px',
                            borderRadius: '6px',
                            border: '1px solid var(--cr-border)',
                            background: 'var(--cr-bg-card)',
                            color: 'var(--cr-sub)',
                            fontFamily: 'var(--cr-font-mono)',
                            fontSize: '14px',
                            cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center'
                        }}>{label}</button>
                    ))}
                </div>

                {/* Hint */}
                {!isMobile && (
                    <div style={{ position: 'absolute', bottom: '20px', left: '20px', fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)', opacity: 0.6 }}>
                        Scroll to zoom · Drag canvas to pan · Drag project box to move · Click node to open
                    </div>
                )}

                {/* HTML tooltip — renders outside SVG so it's never clipped */}
                {hoveredAgent && tooltipPos && (() => {
                    const agent = agents.find(a => a.id === hoveredAgent);
                    if (!agent) return null;
                    const statusColor = STATUS_COLOR[agent.status] ?? 'var(--cr-muted)';
                    const cycleCount = agent.cycles ?? 0;
                    return (
                        <div style={{
                            position: 'fixed',
                            left: tooltipPos.x + 14,
                            top: tooltipPos.y - 56,
                            background: 'var(--cr-bg-elevated)',
                            border: '1px solid var(--cr-border-bright)',
                            borderRadius: '8px',
                            padding: '10px 12px',
                            pointerEvents: 'none',
                            zIndex: 9999,
                            minWidth: '180px',
                            boxShadow: '0 6px 24px var(--cr-shade-2)',
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                <span style={{ fontSize: '16px' }}>{(agent.emoji && agent.emoji.trim()) || '🤖'}</span>
                                <span style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '13px', fontWeight: 600, color: 'var(--cr-cream)' }}>
                                    {agent.name.replace('[sub] ', '')}
                                </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: statusColor }} />
                                <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: statusColor, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                                    {agent.status}
                                </span>
                                <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)' }}>
                                    · {agent.type}
                                </span>
                            </div>
                            <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)', marginBottom: '6px' }}>
                                {cycleCount} cycle{cycleCount === 1 ? '' : 's'} run
                            </div>
                            <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted-br)', letterSpacing: '0.05em', textTransform: 'uppercase', borderTop: '1px solid var(--cr-border)', paddingTop: '6px' }}>
                                Click to open profile
                            </div>
                        </div>
                    );
                })()}
            </div>
        </div>
    );
}

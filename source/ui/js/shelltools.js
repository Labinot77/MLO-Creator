// Tools for the interior shell of a vanilla house: add / cut rooms, partitions, doors, windows, select, floor paint, eraser.
window.MLO = window.MLO || {};
(function (M) {
    'use strict';
    const { Model, Shell } = M, S = Model.state, bus = Model.bus;
    const C = { ghost: [0.31, 0.55, 1.0, 0.36], cut: [0.92, 0.40, 0.30, 0.38], edge: [0.55, 0.75, 1.0, 0.95], hi: [1, 0.85, 0.35, 0.5], sel: [0.35, 0.9, 0.55, 0.55], cand: [0.4, 0.9, 0.5, 0.20], erase: [0.92, 0.32, 0.32, 0.45], paint: [0.95, 0.75, 0.3, 0.38] };
    const SNAP = 0.05, LINE_SNAP = 0.09, CORNER_SNAP = 0.3;
    const randId = () => Math.random().toString(36).slice(2, 7);

    let hover = null, drag = null, poly = null, pd = null;
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const camTol = () => Math.max(0.12, ((M.App.renderer && M.App.renderer.camera.dist) || 20) * 0.012);
    const isImp = () => S.project.kind === 'import' && M.ImportModel;
    const polyById = (id) => (shell().polys || []).find(q => q.id === id) || null;
    const api = () => M.Tools.api;
    const cfg = () => S.project.settings;
    const shell = () => S.project.shell;
    const toast = (t, k) => bus.emit('toast', { text: t, kind: k });

    function snapTo(v, list) {
        let best = Math.round(v / SNAP) * SNAP, bd = LINE_SNAP;
        (list || []).forEach(l => { const d = Math.abs(l - v); if (d < bd) { bd = d; best = l; } });
        return Math.round(best * 10000) / 10000;
    }
    function lines() {
        const b = M.App.built, xs = [], ys = [];
        if (b && b.shell) { b.shell.grid.X.forEach(v => xs.push(v)); b.shell.grid.Y.forEach(v => ys.push(v)); }
        shell().parts.forEach(pt => { if (pt.o === 'H') { ys.push(pt.c); xs.push(pt.u0, pt.u1); } else { xs.push(pt.c); ys.push(pt.u0, pt.u1); } });
        xs.push(0); ys.push(0);
        (shell().polys || []).forEach(pg => (pg.pts || []).forEach(q => { xs.push(q[0]); ys.push(q[1]); }));
        if (S.project.kind === 'import' && M.ImportModel) { const ml = M.ImportModel.snapLines(); ml.xs.forEach(v => xs.push(v)); ml.ys.forEach(v => ys.push(v)); }
        return { xs, ys };
    }
    function ground(e) {
        const ray = api().pointerRay(e), ph = api().planeHit(ray, 0); if (!ph) return null;
        const c = e.shiftKey ? null : corner(ph.x, ph.y); if (c) return { x: c[0], y: c[1], rx: ph.x, ry: ph.y, ray, corner: true };
        const L = lines(); return { x: snapTo(ph.x, L.xs), y: snapTo(ph.y, L.ys), rx: ph.x, ry: ph.y, ray };
    }
    // the nearest corner of the building's walls within CORNER_SNAP of a ground point, or null
    function corner(x, y) {
        if (S.project.kind !== 'import' || !M.ImportModel) return null;
        let best = null, bd = CORNER_SNAP; M.ImportModel.wallCorners().forEach(c => { const d = Math.hypot(c[0] - x, c[1] - y); if (d < bd) { bd = d; best = c; } });
        return best;
    }

    // ---------------- walls as lines on the floor, and snapping at any angle ----------------
    // every wall as a line: the room edges, the partitions (straight and angled) and the angled rooms' edges (skip: a partition or angled room left out)
    function wallSegs(skip) {
        const out = [], b = M.App.built;
        if (b && b.shell) b.shell.segs.forEach(sg => out.push(sg.o === 'H' ? { a: [sg.u0, sg.c], b: [sg.u1, sg.c] } : { a: [sg.c, sg.u0], b: [sg.c, sg.u1] }));
        shell().parts.forEach(pt => { if (pt.id !== skip) out.push(pt.o === 'H' ? { a: [pt.u0, pt.c], b: [pt.u1, pt.c] } : { a: [pt.c, pt.u0], b: [pt.c, pt.u1] }); });
        (shell().aparts || []).forEach(pt => { if (pt.id !== skip) out.push({ a: pt.a, b: pt.b }); });
        Shell.polysOf(shell()).forEach(pg => { if (pg.id !== skip) pg.pts.forEach((q, i) => out.push({ a: q, b: pg.pts[(i + 1) % pg.pts.length] })); });
        return out;
    }
    const unit = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
    const crossL = (a1, d1, a2, d2) => { const den = d1[0] * d2[1] - d1[1] * d2[0]; if (Math.abs(den) < 0.05) return null; const s = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den; return [a1[0] + d1[0] * s, a1[1] + d1[1] * s]; };
    // A point for an angled room: a corner of the building or of a room, else the crossing of two walls, else a point on one wall (the building's walls at
    // any angle too), else 15 degree steps and 5 cm from the last point, else 5 cm. Shift: no snapping.
    function snapPoint(x, y, prev, free, skip) {
        if (free) return { x: r4(x), y: r4(y) };
        const tol = Math.max(0.2, camTol()), segs = wallSegs(skip), pts = [], lines = [];
        if (isImp()) { M.ImportModel.wallCorners().forEach(c => pts.push(c)); M.ImportModel.slantLines().forEach(l => { pts.push(l.a, l.b); }); }
        segs.forEach(sg => pts.push(sg.a, sg.b)); if (poly) poly.pts.forEach(q => pts.push(q));
        let best = null, bd = tol; pts.forEach(q => { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = q; } });
        if (best) return { x: best[0], y: best[1], kind: 'corner' };
        if (isImp()) { const L = M.ImportModel.snapLines(); L.xs.forEach(v => lines.push({ a: [v, 0], d: [0, 1] })); L.ys.forEach(v => lines.push({ a: [0, v], d: [1, 0] })); M.ImportModel.slantLines().forEach(l => lines.push({ a: l.a, d: [Math.cos(l.ang), Math.sin(l.ang)] })); }
        segs.forEach(sg => { if (Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) > 0.05) lines.push({ a: sg.a, d: unit(sg.a, sg.b) }); });
        const near = lines.map(l => ({ l, dist: Math.abs(l.d[0] * (y - l.a[1]) - l.d[1] * (x - l.a[0])) })).filter(o => o.dist < tol * 0.6).sort((p, q) => p.dist - q.dist);
        for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) { const c = crossL(near[i].l.a, near[i].l.d, near[j].l.a, near[j].l.d); if (c && Math.hypot(c[0] - x, c[1] - y) < tol) return { x: r4(c[0]), y: r4(c[1]), kind: 'corner' }; }
        const steps = (p) => { const a = Math.atan2(y - p[1], x - p[0]), q = Math.round(a / (Math.PI / 12)) * (Math.PI / 12); return [Math.cos(q), Math.sin(q)]; };
        if (near.length) {
            const l = near[0].l, t = (x - l.a[0]) * l.d[0] + (y - l.a[1]) * l.d[1];
            if (prev) { const c = crossL(l.a, l.d, prev, steps(prev)); if (c && Math.hypot(c[0] - x, c[1] - y) < tol) return { x: r4(c[0]), y: r4(c[1]), kind: 'line' }; }
            return { x: r4(l.a[0] + l.d[0] * t), y: r4(l.a[1] + l.d[1] * t), kind: 'line' };
        }
        if (prev) { const d = steps(prev), len = Math.round((((x - prev[0]) * d[0] + (y - prev[1]) * d[1])) / SNAP) * SNAP; return { x: r4(prev[0] + d[0] * len), y: r4(prev[1] + d[1] * len) }; }
        return { x: r4(Math.round(x / SNAP) * SNAP), y: r4(Math.round(y / SNAP) * SNAP) };
    }
    function rawGround(e) { const ray = api().pointerRay(e), ph = api().planeHit(ray, 0); return ph ? { x: ph.x, y: ph.y, ray } : null; }

    // ---------------- partitions: straight at any angle, spaced evenly, ends on the walls ----------------
    // a = start [x, y], g = the pointer. The direction snaps to the grid, 45 degrees and the walls' own directions (within 8 degrees); the line moves sideways onto
    // 1/2, 1/3, 2/3, 1/4 or 3/4 of the space between the walls on either side of it when it is within 15 cm of that; both ends go onto a wall within 40 cm.
    function partLine(a0, g, free) {
        let dx = g.x - a0[0], dy = g.y - a0[1]; const len0 = Math.hypot(dx, dy); if (len0 < 0.05) return { a: a0, b: [g.x, g.y], len: len0 };
        let ang = Math.atan2(dy, dx); const segs = wallSegs();
        if (!free) {
            const cands = [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4];
            segs.concat(isImp() ? M.ImportModel.slantLines() : []).forEach(sg => { const g0 = Math.atan2(sg.b[1] - sg.a[1], sg.b[0] - sg.a[0]); cands.push(g0, g0 + Math.PI / 2); });
            let bd = 0.14, best = null; cands.forEach(c => { const df = Math.abs(Math.atan2(Math.sin(ang - c), Math.cos(ang - c))), dd = Math.min(df, Math.PI - df); if (dd < bd) { bd = dd; best = Math.cos(ang - c) >= 0 ? c : c + Math.PI; } });
            if (best != null) ang = best;
        }
        let d = [Math.cos(ang), Math.sin(ang)]; if (Math.abs(d[0]) < 1e-9) d = [0, Math.sign(d[1])]; if (Math.abs(d[1]) < 1e-9) d = [Math.sign(d[0]), 0];
        const len = free ? dx * d[0] + dy * d[1] : Math.round((dx * d[0] + dy * d[1]) / SNAP) * SNAP; let a = a0.slice(), even = null;
        if (!free) {
            const nn = [-d[1], d[0]]; let lo = -1e9, hi = 1e9;
            segs.forEach(sg => {
                const sd = unit(sg.a, sg.b); if (Math.abs(sd[0] * d[1] - sd[1] * d[0]) > 0.02) return;
                const off = (sg.a[0] - a[0]) * nn[0] + (sg.a[1] - a[1]) * nn[1], p0 = (sg.a[0] - a[0]) * d[0] + (sg.a[1] - a[1]) * d[1], p1 = (sg.b[0] - a[0]) * d[0] + (sg.b[1] - a[1]) * d[1];
                if (Math.min(Math.max(p0, p1), len) - Math.max(Math.min(p0, p1), 0) < Math.min(0.3, len * 0.5)) return;
                if (off < -0.05 && off > lo) lo = off; if (off > 0.05 && off < hi) hi = off;
            });
            if (lo > -1e9 && hi < 1e9) {
                let bd = 0.15, best = null;
                for (let n = 2; n <= 4; n++) for (let k = 1; k < n; k++) { const c = lo + (hi - lo) * k / n; if (Math.abs(c) < bd - 1e-9) { bd = Math.abs(c); best = { c, k, n }; } }
                if (best) { a = [r4(a[0] + nn[0] * best.c), r4(a[1] + nn[1] * best.c)]; even = Math.min(best.k, best.n - best.k) + '/' + best.n + ': ' + (best.c - lo).toFixed(2) + ' | ' + (hi - best.c).toFixed(2) + ' m'; }
            }
        }
        let b = [a[0] + d[0] * len, a[1] + d[1] * len];
        if (!free) {
            // each end onto the nearest wall it crosses or nearly reaches (40 cm)
            const reach = (E, s) => { let bt = null; segs.forEach(sg => { const sd = unit(sg.a, sg.b), sl = Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]), den = s[0] * sd[1] - s[1] * sd[0]; if (Math.abs(den) < 0.05) return;
                const wx = sg.a[0] - E[0], wy = sg.a[1] - E[1], t = (wx * sd[1] - wy * sd[0]) / den, q = (wx * s[1] - wy * s[0]) / den; if (t < -0.4 || t > 0.4 || q < -0.02 || q > sl + 0.02) return; if (bt == null || Math.abs(t) < Math.abs(bt)) bt = t; }); return bt; };
            const tb = reach(b, d); if (tb != null) b = [b[0] + d[0] * tb, b[1] + d[1] * tb];
            const ta = reach(a, [-d[0], -d[1]]); if (ta != null && Math.abs(ta) > 1e-4) a = [a[0] - d[0] * ta, a[1] - d[1] * ta];
        }
        return { a: [r4(a[0]), r4(a[1])], b: [r4(b[0]), r4(b[1])], even, len: Math.hypot(b[0] - a[0], b[1] - a[1]) };
    }
    // a partition from a to b: square to the grid it is a plain one, else an angled one
    function addPartition(P, a, b) {
        const d = unit(a, b), L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.3) return false;
        if (Math.abs(d[1]) < 1e-6) P.shell.parts.push({ id: randId(), o: 'H', c: a[1], u0: Math.min(a[0], b[0]), u1: Math.max(a[0], b[0]), open: [] });
        else if (Math.abs(d[0]) < 1e-6) P.shell.parts.push({ id: randId(), o: 'V', c: a[0], u0: Math.min(a[1], b[1]), u1: Math.max(a[1], b[1]), open: [] });
        else (P.shell.aparts = P.shell.aparts || []).push({ id: randId(), a: a.slice(), b: b.slice(), open: [] });
        return true;
    }
    // ---------------- dividing a room into equal parts with partitions ----------------
    // a rectangle (index of shell.ops): across its longer side, or along 'x' / 'y'
    function divideRect(i, n, along) {
        const o = shell().ops[i]; if (!o || n < 2) return 0; const r = o.r, w = r[2] - r[0], h = r[3] - r[1], ax = along === 'x' || (along !== 'y' && w >= h);
        Model.edit(P => { for (let k = 1; k < n; k++) { if (ax) { const x = r4(r[0] + w * k / n); addPartition(P, [x, r[1]], [x, r[3]]); } else { const y = r4(r[1] + h * k / n); addPartition(P, [r[0], y], [r[2], y]); } } });
        return n - 1;
    }
    // an angled room: equal parts along its edge `ei` (default: the longest), the partitions square to that edge
    function dividePoly(id, n, ei) {
        const pg = Shell.polysOf(shell()).find(q => q.id === id); if (!pg || n < 2) return 0; const p = pg.pts;
        if (ei == null || ei < 0 || ei >= p.length) { let la = 0; p.forEach((a, i) => { const l = Math.hypot(p[(i + 1) % p.length][0] - a[0], p[(i + 1) % p.length][1] - a[1]); if (l > la) { la = l; ei = i; } }); }
        const d = unit(p[ei], p[(ei + 1) % p.length]), nn = [-d[1], d[0]], U = (q) => q[0] * d[0] + q[1] * d[1], V = (q) => q[0] * nn[0] + q[1] * nn[1];
        const u0 = Math.min(...p.map(U)), u1 = Math.max(...p.map(U)), lines = [];
        for (let k = 1; k < n; k++) {
            const u = u0 + (u1 - u0) * k / n, vs = [];
            p.forEach((a, i) => { const b = p[(i + 1) % p.length], ua = U(a), ub = U(b); if ((ua > u) !== (ub > u)) vs.push(V(a) + (u - ua) * (V(b) - V(a)) / (ub - ua)); });
            vs.sort((x, y) => x - y); let best = null; for (let j = 0; j + 1 < vs.length; j += 2) if (!best || vs[j + 1] - vs[j] > best[1] - best[0]) best = [vs[j], vs[j + 1]];
            if (best) lines.push([[u * d[0] + best[0] * nn[0], u * d[1] + best[0] * nn[1]], [u * d[0] + best[1] * nn[0], u * d[1] + best[1] * nn[1]]].map(q => [r4(q[0]), r4(q[1])]));
        }
        Model.edit(P => { lines.forEach(l => addPartition(P, l[0], l[1])); });
        return lines.length;
    }
    // ---------------- the room side of every wall: { p (a point on the face), t (along it), n (into the room), u0, u1 (stretch along t from p) } ----------------
    function wallPlanes() {
        const out = [], b = M.App.built, T = Math.max(0, Math.min(0.5, +cfg().wallThick || 0)), PT = cfg().partT;
        if (b && b.shell) b.shell.segs.forEach(sg => { const ci = sg.ci != null ? sg.ci : sg.c + sg.inward * T; out.push(sg.o === 'H' ? { p: [0, ci], t: [1, 0], n: [0, sg.inward], u0: sg.u0, u1: sg.u1 } : { p: [ci, 0], t: [0, 1], n: [sg.inward, 0], u0: sg.u0, u1: sg.u1 }); });
        const two = (a, bb) => { const t = unit(a, bb), n = [-t[1], t[0]], L = Math.hypot(bb[0] - a[0], bb[1] - a[1]); [1, -1].forEach(sd => out.push({ p: [a[0] + n[0] * sd * PT / 2, a[1] + n[1] * sd * PT / 2], t, n: [n[0] * sd, n[1] * sd], u0: 0, u1: L })); };
        shell().parts.forEach(pt => two(pt.o === 'H' ? [pt.u0, pt.c] : [pt.c, pt.u0], pt.o === 'H' ? [pt.u1, pt.c] : [pt.c, pt.u1]));
        (shell().aparts || []).forEach(pt => two(pt.a, pt.b));
        Shell.polysOf(shell()).forEach(pg => pg.pts.forEach((a, i) => { const bb = pg.pts[(i + 1) % pg.pts.length], t = unit(a, bb), n = [-t[1], t[0]]; out.push({ p: [a[0] + n[0] * T, a[1] + n[1] * T], t, n, u0: 0, u1: Math.hypot(bb[0] - a[0], bb[1] - a[1]) }); }));
        return out;
    }
    // the room-side wall face nearest to a point, running along direction u (within 15 degrees), within `reach` metres; null if none
    function wallFaceNear(x, y, u, reach) {
        let best = null, bd = reach || 1.0;
        wallPlanes().forEach(w => {
            if (Math.abs(w.t[0] * u[0] + w.t[1] * u[1]) < 0.966) return;
            const dx = x - w.p[0], dy = y - w.p[1], along = dx * w.t[0] + dy * w.t[1], dist = Math.abs(dx * w.n[0] + dy * w.n[1]);
            if (along < w.u0 - 0.3 || along > w.u1 + 0.3 || dist >= bd) return; bd = dist; best = w;
        });
        return best;
    }

    // ---------------- angled rooms: picking, corners ----------------
    function polyAt(x, y) { let best = null, ba = 1e18; Shell.polysOf(shell()).forEach(pg => { if (!Shell.inPoly(pg.pts, x, y)) return; let a = 0; pg.pts.forEach((q, i) => { const r = pg.pts[(i + 1) % pg.pts.length]; a += q[0] * r[1] - r[0] * q[1]; }); a = Math.abs(a); if (a < ba) { ba = a; best = pg; } }); return best; }
    function polyCorner(id, x, y) { const pg = polyById(id); if (!pg) return -1; const tol = camTol(); let bi = -1, bd = tol; pg.pts.forEach((q, i) => { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; bi = i; } }); return bi; }
    function finishPoly() {
        const pts = poly && Shell.cleanPoly(poly.pts); poly = null;
        if (!pts) { toast('An angled room needs at least 3 corners around a floor.', 'warn'); return; }
        const id = randId(); Model.edit(P => { (P.shell.polys = P.shell.polys || []).push({ id, pts: pts.map(q => [r4(q[0]), r4(q[1])]) }); });
        toast('Angled room added (' + pts.length + ' corners). Select it to move its corners or divide it.', 'ok');
    }

    // wall under the pointer: boundary segment of the room or a partition
    function pick(ray) {
        const b = M.App.built; if (!b || !b.shell) return null; const H = cfg().ceilH, depth = cfg().wallDepth, PT = cfg().partT; let best = null;
        const test = (mn, mx, info) => { const t = api().rayBox(ray, mn, mx); if (t != null && (!best || t < best.t)) { info.t = t; info.px = ray.o[0] + ray.d[0] * t; info.py = ray.o[1] + ray.d[1] * t; best = info; } };
        b.shell.segs.forEach(sg => {
            const a = Math.min(sg.c, sg.c - sg.inward * depth) - 0.05, z = Math.max(sg.c, sg.c - sg.inward * depth) + 0.05;
            if (sg.o === 'H') test([sg.u0, a, 0], [sg.u1, z, H], { kind: 'seg', sg }); else test([a, sg.u0, 0], [z, sg.u1, H], { kind: 'seg', sg });
        });
        shell().parts.forEach(pt => {
            const a = pt.c - PT / 2 - 0.04, z = pt.c + PT / 2 + 0.04;
            if (pt.o === 'H') test([pt.u0, a, 0], [pt.u1, z, H], { kind: 'part', pt }); else test([a, pt.u0, 0], [z, pt.u1, H], { kind: 'part', pt });
        });
        (shell().aparts || []).forEach(pt => {
            // an angled partition: the ray in its own axes
            const L = Math.hypot(pt.b[0] - pt.a[0], pt.b[1] - pt.a[1]), d = unit(pt.a, pt.b), c = [(pt.a[0] + pt.b[0]) / 2, (pt.a[1] + pt.b[1]) / 2], o = [ray.o[0] - c[0], ray.o[1] - c[1]];
            const lo = { o: [o[0] * d[0] + o[1] * d[1], -o[0] * d[1] + o[1] * d[0], ray.o[2]], d: [ray.d[0] * d[0] + ray.d[1] * d[1], -ray.d[0] * d[1] + ray.d[1] * d[0], ray.d[2]] };
            const t = api().rayBox(lo, [-L / 2, -PT / 2 - 0.04, 0], [L / 2, PT / 2 + 0.04, H]); if (t != null && (!best || t < best.t)) best = { kind: 'apart', pt, t, px: ray.o[0] + ray.d[0] * t, py: ray.o[1] + ray.d[1] * t };
        });
        if (best && best.kind !== 'apart') { const o = best.kind === 'seg' ? best.sg.o : best.pt.o; best.u = o === 'H' ? best.px : best.py; best.n = o === 'H' ? best.py : best.px; }
        return best;
    }
    function openingAt(p) {
        if (!p || p.kind === 'apart') return null;
        if (p.kind === 'seg') return shell().openings.find(op => op.o === p.sg.o && Math.abs(op.c - p.sg.c) < 0.3 && p.u > op.u0 && p.u < op.u1 && p.u > p.sg.u0 - 0.01 && p.u < p.sg.u1 + 0.01) || null;
        return (p.pt.open || []).find(op => p.u > op.u0 && p.u < op.u1) || null;
    }

    // ---------------- actions ----------------
    function normRect(a, b) { return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]; }

    function addOpening(p, type) {
        const spec = Shell.OPEN[type], u = p.u;
        Model.edit(P => {
            const sh = P.shell;
            const ex = p.kind === 'seg' ? sh.openings.find(op => op.o === p.sg.o && Math.abs(op.c - p.sg.c) < 0.3 && u > op.u0 && u < op.u1) : (p.pt.open || []).find(op => u > op.u0 && u < op.u1);
            if (ex) {
                // click on an existing opening of the same kind removes it, another kind turns it into that kind
                if (ex.type === type) { if (p.kind === 'seg') sh.openings = sh.openings.filter(o => o !== ex && o.id !== ex.id); else { const pt = sh.parts.find(q => q.id === p.pt.id); pt.open = pt.open.filter(o => o.id !== ex.id); } }
                else { const t = p.kind === 'seg' ? sh.openings.find(o => o.id === ex.id) : sh.parts.find(q => q.id === p.pt.id).open.find(o => o.id === ex.id); t.type = type; t.z0 = spec.z0; t.z1 = spec.z1; }
                return;
            }
            let u0 = u - spec.w / 2, u1 = u + spec.w / 2, z0 = spec.z0, z1 = spec.z1;
            const lo = p.kind === 'seg' ? p.sg.u0 : p.pt.u0, hi = p.kind === 'seg' ? p.sg.u1 : p.pt.u1;
            if (type === 'window' && p.kind === 'seg') {
                const cn = sh.cands.find(c => !c.door && c.o === p.sg.o && Math.abs(c.c - p.sg.c) < 0.45 && u > c.u0 - 0.15 && u < c.u1 + 0.15);
                if (cn) { u0 = cn.u0 + 0.06; u1 = cn.u1 - 0.06; z0 = Math.max(0.2, cn.z0); z1 = cn.z1 - 0.1; }
            }
            u0 = Math.max(u0, lo + 0.08); u1 = Math.min(u1, hi - 0.08); if (u1 - u0 < 0.3) { toast('The wall is too short here.', 'warn'); return; }
            const op = { id: randId(), type, u0: Math.round(u0 * 100) / 100, u1: Math.round(u1 * 100) / 100, z0: Math.round(z0 * 100) / 100, z1: Math.round(z1 * 100) / 100 };
            if (p.kind === 'seg') { op.o = p.sg.o; op.c = p.sg.c; sh.openings.push(op); } else { const pt = sh.parts.find(q => q.id === p.pt.id); pt.open = pt.open || []; pt.open.push(op); }
            S.shellSel = { kind: 'open', id: op.id };
        });
        bus.emit('shellsel');
    }

    function down(e) {
        const t = S.shellTool;
        if (t === 'poly') {
            const rg = rawGround(e); if (!rg) return; const prev = poly && poly.pts.length ? poly.pts[poly.pts.length - 1] : null, q = snapPoint(rg.x, rg.y, prev, e.shiftKey);
            if (poly && poly.pts.length >= 3 && Math.hypot(q.x - poly.pts[0][0], q.y - poly.pts[0][1]) < Math.max(0.2, camTol())) { finishPoly(); return; }
            if (!poly) poly = { pts: [] }; if (!prev || Math.hypot(q.x - prev[0], q.y - prev[1]) > 0.02) poly.pts.push([q.x, q.y]);
            return;
        }
        const g = ground(e); hover = { g, pick: g ? pick(g.ray) : null };
        if (!g) return;
        if (t === 'room' || t === 'cut' || t === 'floor') drag = { tool: t, a: g, b: g };
        else if (t === 'part') drag = { tool: t, a: g, b: g };
        else if (t === 'door' || t === 'window' || t === 'arch') { const p = hover.pick; if (p) addOpening(p, t); }
        else if (t === 'select') {
            // a corner of the selected angled room: drag it
            const sp = S.shellSel && S.shellSel.kind === 'poly' ? polyById(S.shellSel.id) : null, ci = sp ? polyCorner(sp.id, g.rx, g.ry) : -1;
            if (sp && ci >= 0) { pd = { id: sp.id, i: ci, pts0: sp.pts.map(q => q.slice()), p0: [g.rx, g.ry], px: [e.clientX, e.clientY], moved: false, cur: null }; return; }
            const p = hover.pick; const op = openingAt(p);
            if (op) S.shellSel = { kind: 'open', id: op.id }; else if (p && p.kind === 'part') S.shellSel = { kind: 'part', id: p.pt.id }; else if (p && p.kind === 'apart') S.shellSel = { kind: 'apart', id: p.pt.id };
            else { const pg = polyAt(g.rx, g.ry); if (pg) { S.shellSel = { kind: 'poly', id: pg.id }; const src = polyById(pg.id); pd = { id: pg.id, i: -1, pts0: src.pts.map(q => q.slice()), p0: [g.rx, g.ry], px: [e.clientX, e.clientY], moved: false, cur: null }; } else S.shellSel = null; }
            bus.emit('shellsel'); bus.emit('tooloptions');
        }
        else if (t === 'eraser') {
            const p = hover.pick; if (!p) return; const op = openingAt(p);
            Model.edit(P => {
                const sh = P.shell;
                if (op) { if (p.kind === 'seg') sh.openings = sh.openings.filter(o => o.id !== op.id); else { const pt = sh.parts.find(q => q.id === p.pt.id); pt.open = pt.open.filter(o => o.id !== op.id); } }
                else if (p.kind === 'part') sh.parts = sh.parts.filter(q => q.id !== p.pt.id);
                else if (p.kind === 'apart') sh.aparts = (sh.aparts || []).filter(q => q.id !== p.pt.id);
            });
        }
        else if (t === 'paint') {
            const p = hover.pick; if (!p) return; const tex = S.brush.wall;
            if (p.kind === 'apart') { Model.edit(P => { const pt = (P.shell.aparts || []).find(q => q.id === p.pt.id); if (!pt) return; const d = unit(pt.a, pt.b), side = (p.px - pt.a[0]) * -d[1] + (p.py - pt.a[1]) * d[0] > 0 ? 'texB' : 'texA'; pt[side] = tex; }); return; }
            Model.edit(P => {
                const sh = P.shell;
                if (p.kind === 'part') { const pt = sh.parts.find(q => q.id === p.pt.id); const side = p.n < pt.c ? 'texA' : 'texB'; pt[side] = tex; }
                else { sh.paint = sh.paint || []; sh.paint = sh.paint.filter(q => !(q.o === p.sg.o && Math.abs(q.c - p.sg.c) < 0.3 && q.inward === p.sg.inward && q.um > p.sg.u0 && q.um < p.sg.u1)); sh.paint.push({ o: p.sg.o, c: p.sg.c, inward: p.sg.inward, um: (p.sg.u0 + p.sg.u1) / 2, tex }); }
            });
        }
    }

    function move(e) {
        if (S.shellTool === 'poly') { const rg = rawGround(e); const prev = poly && poly.pts.length ? poly.pts[poly.pts.length - 1] : null; hover = rg ? { pq: snapPoint(rg.x, rg.y, prev, e.shiftKey) } : null; return; }
        if (pd) { polyDragMove(e); return; }
        const g = ground(e); hover = { g, pick: g ? pick(g.ray) : null };
        if (!drag || !g) return;
        if (drag.tool === 'part') {
            // a straight line at the snapped angle, moved onto an even spacing, its ends on the walls
            const r = partLine([drag.a.x, drag.a.y], g, e.shiftKey); drag.pa = r.a; drag.pb = r.b; drag.even = r.even;
            drag.b = { x: r.b[0], y: r.b[1] };
        } else drag.b = g;
    }
    // dragging a corner of an angled room (or the whole room): changed live, one undo step when let go
    function polyDragMove(e) {
        const k = pd, pg = polyById(k.id); if (!pg) { pd = null; return; }
        if (!k.moved && Math.hypot(e.clientX - k.px[0], e.clientY - k.px[1]) < 4) return; k.moved = true;
        const rg = rawGround(e); if (!rg) return; let pts = k.pts0.map(q => q.slice());
        if (k.i >= 0) { const q = snapPoint(rg.x, rg.y, null, e.shiftKey, k.id); pts[k.i] = [q.x, q.y]; }
        else { let dx = rg.x - k.p0[0], dy = rg.y - k.p0[1]; if (!e.shiftKey) { dx = Math.round(dx / SNAP) * SNAP; dy = Math.round(dy / SNAP) * SNAP; } pts = pts.map(q => [r4(q[0] + dx), r4(q[1] + dy)]); }
        const key = JSON.stringify(pts); if (key === k.cur) return; k.cur = key; pg.pts = pts; bus.emit('change');
    }
    function polyDragEnd(commit) {
        const k = pd; pd = null; if (!k) return; const pg = polyById(k.id); if (!pg) return; const fin = pg.pts;
        pg.pts = k.pts0;
        if (commit && k.moved && k.cur && Shell.cleanPoly(fin)) Model.edit(P => { const q = (P.shell.polys || []).find(x => x.id === k.id); if (q) q.pts = fin; }); else bus.emit('change');
    }

    function up(e) {
        if (pd) { polyDragEnd(true); return; }
        if (!drag) return; const d = drag; drag = null;
        if (d.tool === 'room' || d.tool === 'cut') {
            const r = normRect(d.a, d.b); if (r[2] - r[0] < 0.2 || r[3] - r[1] < 0.2) return;
            Model.edit(P => { P.shell.ops.push({ op: d.tool === 'room' ? 'add' : 'cut', r }); });
        } else if (d.tool === 'floor') {
            const r = normRect(d.a, d.b); if (r[2] - r[0] < 0.2 || r[3] - r[1] < 0.2) return;
            Model.edit(P => { P.shell.floors.push({ r, tex: S.brush.floor }); });
        } else if (d.tool === 'part') {
            if (!d.pa) return; const a = d.pa, b = d.pb; if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.3) return;
            Model.edit(P => { addPartition(P, a, b); });
        }
    }

    // ---------------- overlays ----------------
    function draw(R, label) {
        const H = cfg().ceilH, depth = cfg().wallDepth, PT = cfg().partT, z = 0.012, b = M.App.built, sh = shell(), t = S.shellTool;
        const quad = (r, col) => R.ovQuad([r[0], r[1], z], [r[2], r[1], z], [r[2], r[3], z], [r[0], r[3], z], col);
        // the wall corner the pointer is held to
        const hg = hover && hover.g; if (hg && hg.corner) { const s = 0.18, cc = [1, 0.85, 0.2, 1]; R.ovTopLine([hg.x - s, hg.y, z], [hg.x + s, hg.y, z], cc); R.ovTopLine([hg.x, hg.y - s, z], [hg.x, hg.y + s, z], cc); }
        // entrance arrow
        const legacy = S.project.kind === 'vanilla', ez = 0.02;
        if (legacy) { R.ovQuad([-0.28, -0.7, ez], [0.28, -0.7, ez], [0, -0.05, ez], [0, -0.05, ez], [0.25, 0.85, 0.5, 0.85]); R.ovQuad([-0.1, -1.2, ez], [0.1, -1.2, ez], [0.1, -0.7, ez], [-0.1, -0.7, ez], [0.25, 0.85, 0.5, 0.85]); }
        // detected windows while placing one
        if (legacy && (t === 'window' || t === 'select')) sh.cands.forEach(c => {
            const a = c.u0, bb = c.u1, o0 = c.c - 0.04, o1 = c.c + 0.04;
            if (c.o === 'H') R.ovBox([a, o0, c.z0], [bb, o1, c.z1], c.door ? [1, 0.7, 0.2, 0.14] : C.cand); else R.ovBox([o0, a, c.z0], [o1, bb, c.z1], c.door ? [1, 0.7, 0.2, 0.14] : C.cand);
        });
        // selection
        if (S.shellSel) {
            if (S.shellSel.kind === 'open') {
                let op = sh.openings.find(o => o.id === S.shellSel.id), host = null;
                if (!op) sh.parts.forEach(pt => { const f = (pt.open || []).find(o => o.id === S.shellSel.id); if (f) { op = f; host = pt; } });
                if (op) { const c = host ? host.c : op.c, h = host ? PT / 2 + 0.03 : 0.1; if ((host ? host.o : op.o) === 'H') R.ovBox([op.u0, c - h, op.z0], [op.u1, c + h, op.z1], C.sel, [1, 1, 1, 0.9]); else R.ovBox([c - h, op.u0, op.z0], [c + h, op.u1, op.z1], C.sel, [1, 1, 1, 0.9]); }
            } else if (S.shellSel.kind === 'part') {
                const pt = sh.parts.find(q => q.id === S.shellSel.id); if (pt) { const h = PT / 2 + 0.03; if (pt.o === 'H') R.ovBox([pt.u0, pt.c - h, 0], [pt.u1, pt.c + h, H], C.sel, [1, 1, 1, 0.9]); else R.ovBox([pt.c - h, pt.u0, 0], [pt.c + h, pt.u1, H], C.sel, [1, 1, 1, 0.9]); }
            } else if (S.shellSel.kind === 'apart') {
                const pt = (sh.aparts || []).find(q => q.id === S.shellSel.id); if (pt) aBox(R, pt.a, pt.b, H, C.sel, [1, 1, 1, 0.9]);
            } else if (S.shellSel.kind === 'poly') {
                const pg = polyById(S.shellSel.id); if (pg) { polyOutline(R, pg.pts, [1, 1, 1, 0.95], true, C.sel); const hs = camTol() * 0.42; pg.pts.forEach((q, i) => { const hot = pd && pd.i === i; R.ovTopQuad([q[0] - hs, q[1] - hs, 0.035], [q[0] + hs, q[1] - hs, 0.035], [q[0] + hs, q[1] + hs, 0.035], [q[0] - hs, q[1] + hs, 0.035], hot ? [1, 0.93, 0.55, 1] : [1, 1, 1, 0.95]); }); }
            }
        }
        if (S.hoverOp != null && sh.ops[S.hoverOp]) quad(sh.ops[S.hoverOp].r, [1, 1, 0.4, 0.3]);
        let lbl = null, at = null;
        if (drag && (drag.tool === 'room' || drag.tool === 'cut' || drag.tool === 'floor')) {
            const r = normRect(drag.a, drag.b); quad(r, drag.tool === 'cut' ? C.cut : (drag.tool === 'floor' ? C.paint : C.ghost));
            lbl = (r[2] - r[0]).toFixed(2) + ' x ' + (r[3] - r[1]).toFixed(2) + ' m'; at = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2, 0.15];
        } else if (drag && drag.tool === 'part') {
            if (drag.pa) {
                const a = drag.pa, bb = drag.pb, len = Math.hypot(bb[0] - a[0], bb[1] - a[1]), deg = (((Math.atan2(bb[1] - a[1], bb[0] - a[0]) * 180 / Math.PI) % 180) + 180) % 180;
                if (len > 0.01) aBox(R, a, bb, H, C.ghost, C.edge);
                lbl = len.toFixed(2) + ' m  ' + deg.toFixed(0) + '°' + (drag.even ? '  · even ' + drag.even : ''); at = [(a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2, H + 0.1];
            }
        } else if (t === 'poly') {
            const q = hover && hover.pq, pts = poly ? poly.pts : [], z1 = 0.03, col = [0.45, 0.8, 1, 1];
            for (let i = 0; i + 1 < pts.length; i++) R.ovTopLine([pts[i][0], pts[i][1], z1], [pts[i + 1][0], pts[i + 1][1], z1], col);
            if (q && pts.length) { const l = pts[pts.length - 1]; R.ovTopLine([l[0], l[1], z1], [q.x, q.y, z1], [0.45, 0.8, 1, 0.6]); if (pts.length >= 2) R.ovTopLine([q.x, q.y, z1], [pts[0][0], pts[0][1], z1], [0.45, 0.8, 1, 0.25]); }
            pts.forEach((p, i) => { const s = i === 0 ? 0.09 : 0.06; R.ovTopQuad([p[0] - s, p[1] - s, z1], [p[0] + s, p[1] - s, z1], [p[0] + s, p[1] + s, z1], [p[0] - s, p[1] + s, z1], i === 0 ? [1, 0.85, 0.2, 1] : col); });
            if (q) {
                const s = 0.18, cc = q.kind ? [1, 0.85, 0.2, 1] : [0.55, 0.75, 1, 0.95]; R.ovTopLine([q.x - s, q.y, z1], [q.x + s, q.y, z1], cc); R.ovTopLine([q.x, q.y - s, z1], [q.x, q.y + s, z1], cc);
                const l = pts[pts.length - 1]; lbl = l ? Math.hypot(q.x - l[0], q.y - l[1]).toFixed(2) + ' m  ' + ((((Math.atan2(q.y - l[1], q.x - l[0]) * 180 / Math.PI) % 360) + 360) % 360).toFixed(0) + '°' : q.x.toFixed(2) + ', ' + q.y.toFixed(2);
                if (pts.length >= 3 && Math.hypot(q.x - pts[0][0], q.y - pts[0][1]) < Math.max(0.2, camTol())) lbl = 'Click: close the room'; at = [q.x, q.y, 0.7];
            }
        } else if (hover && hover.g) {
            const p = hover.pick, g = hover.g;
            if (t === 'room' || t === 'cut' || t === 'part' || t === 'floor') R.ovBox([g.x - 0.05, g.y - 0.05, 0], [g.x + 0.05, g.y + 0.05, 0.5], C.edge);
            if (p && (t === 'door' || t === 'window' || t === 'arch' || t === 'select' || t === 'eraser' || t === 'paint')) {
                const op = openingAt(p), spec = Shell.OPEN[t] || Shell.OPEN.window, col = t === 'eraser' ? C.erase : C.hi;
                if (op && (t === 'select' || t === 'eraser' || t === 'door' || t === 'window' || t === 'arch')) {
                    const c = p.kind === 'seg' ? op.c : p.pt.c, h = p.kind === 'seg' ? 0.1 : PT / 2 + 0.03;
                    if ((p.kind === 'seg' ? op.o : p.pt.o) === 'H') R.ovBox([op.u0, c - h, op.z0], [op.u1, c + h, op.z1], col, [1, 1, 1, 0.9]); else R.ovBox([c - h, op.u0, op.z0], [c + h, op.u1, op.z1], col, [1, 1, 1, 0.9]);
                } else if (t === 'door' || t === 'window' || t === 'arch') {
                    const o = p.kind === 'seg' ? p.sg.o : p.pt.o, c = p.kind === 'seg' ? p.sg.c : p.pt.c, h = p.kind === 'seg' ? 0.1 : PT / 2 + 0.03;
                    if (o === 'H') R.ovBox([p.u - spec.w / 2, c - h, spec.z0], [p.u + spec.w / 2, c + h, spec.z1], C.hi, [1, 1, 1, 0.9]); else R.ovBox([c - h, p.u - spec.w / 2, spec.z0], [c + h, p.u + spec.w / 2, spec.z1], C.hi, [1, 1, 1, 0.9]);
                } else if (t === 'eraser' && p.kind === 'part') {
                    const pt = p.pt, h = PT / 2 + 0.03; if (pt.o === 'H') R.ovBox([pt.u0, pt.c - h, 0], [pt.u1, pt.c + h, H], C.erase); else R.ovBox([pt.c - h, pt.u0, 0], [pt.c + h, pt.u1, H], C.erase);
                } else if (t === 'paint') {
                    if (p.kind === 'seg') { const sg = p.sg, off = -sg.inward * 0 + sg.inward * 0.015; if (sg.o === 'H') R.ovQuad([sg.u0, sg.c + off, 0], [sg.u1, sg.c + off, 0], [sg.u1, sg.c + off, H], [sg.u0, sg.c + off, H], C.ghost); else R.ovQuad([sg.c + off, sg.u0, 0], [sg.c + off, sg.u1, 0], [sg.c + off, sg.u1, H], [sg.c + off, sg.u0, H], C.ghost); }
                    else { const pt = p.pt, side = p.n < pt.c ? -1 : 1, off = side * (PT / 2 + 0.015); if (pt.o === 'H') R.ovQuad([pt.u0, pt.c + off, 0], [pt.u1, pt.c + off, 0], [pt.u1, pt.c + off, H], [pt.u0, pt.c + off, H], C.ghost); else R.ovQuad([pt.c + off, pt.u0, 0], [pt.c + off, pt.u1, 0], [pt.c + off, pt.u1, H], [pt.c + off, pt.u0, H], C.ghost); }
                }
            }
            lbl = (t === 'room' || t === 'cut' || t === 'part' || t === 'floor') ? g.x.toFixed(2) + ', ' + g.y.toFixed(2) : null; at = lbl ? [g.x, g.y, 0.7] : null;
        }
        if (t === 'select' && !pd && hover && hover.g && !(S.shellSel && S.shellSel.kind === 'poly')) { const pg = polyAt(hover.g.rx, hover.g.ry); if (pg) polyOutline(R, pg.pts, [1, 1, 1, 0.55], false); }
        label(lbl, at);
    }
    function aBox(R, a, b, H, col, edge) { const L = Math.hypot(b[0] - a[0], b[1] - a[1]), PT = cfg().partT; R.ovOBox([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, H / 2], L / 2, PT / 2 + 0.03, H / 2, Math.atan2(b[1] - a[1], b[0] - a[0]), col, edge); }
    function polyOutline(R, pts, col, fill, fcol) {
        const z = 0.03; pts.forEach((q, i) => { const r = pts[(i + 1) % pts.length]; R.ovTopLine([q[0], q[1], z], [r[0], r[1], z], col); });
        if (fill) { const cp = Shell.cleanPoly(pts); if (cp) Shell.triangulate(cp).forEach(tr => R.ovTopQuad([cp[tr[0]][0], cp[tr[0]][1], z - 0.005], [cp[tr[1]][0], cp[tr[1]][1], z - 0.005], [cp[tr[2]][0], cp[tr[2]][1], z - 0.005], [cp[tr[2]][0], cp[tr[2]][1], z - 0.005], [fcol[0], fcol[1], fcol[2], 0.2])); }
    }

    function key(k) {
        if (S.shellTool === 'poly' && poly) {
            if (k === 'Enter') { finishPoly(); return true; }
            if (k === 'Backspace' || k === 'Delete') { poly.pts.pop(); if (!poly.pts.length) poly = null; return true; }
        }
        if (k === 'x' && S.shellTool === 'select' && S.shellSel && (S.shellSel.kind === 'poly' || S.shellSel.kind === 'apart')) { deleteSelected(); return true; }
        const map = { '1': 'room', '2': 'cut', '3': 'part', '4': 'door', '5': 'window', '6': 'arch', '7': 'floor', '8': 'poly', v: 'select', x: 'eraser', p: 'paint' };
        if (map[k]) { poly = null; M.App.setTool(map[k]); return true; }
        if (k === 'Escape') { drag = null; poly = null; if (pd) polyDragEnd(false); return true; }
        if ((k === 'Delete' || k === 'Backspace') && S.shellSel) { deleteSelected(); return true; }
        return false;
    }
    function deleteSelected() {
        const sel = S.shellSel; if (!sel) return;
        Model.edit(P => {
            if (sel.kind === 'open') { P.shell.openings = P.shell.openings.filter(o => o.id !== sel.id); P.shell.parts.forEach(pt => { pt.open = (pt.open || []).filter(o => o.id !== sel.id); }); }
            else if (sel.kind === 'part') P.shell.parts = P.shell.parts.filter(q => q.id !== sel.id);
            else if (sel.kind === 'apart') P.shell.aparts = (P.shell.aparts || []).filter(q => q.id !== sel.id);
            else if (sel.kind === 'poly') P.shell.polys = (P.shell.polys || []).filter(q => q.id !== sel.id);
        });
        S.shellSel = null; bus.emit('shellsel');
    }

    let labelFn = null;
    function label(text, at) { if (labelFn) labelFn(text, at); }

    M.ShellTools = { down, move, up, draw, key, deleteSelected, pick, ground, openingAt, snapTo, lines, corner, wallSegs, wallPlanes, wallFaceNear, partLine, divideRect, dividePoly, polyAt, busy: () => !!pd || !!poly,
        cancel() { drag = null; poly = null; if (pd) polyDragEnd(false); }, setLabel(f) { labelFn = f; }, get hover() { return hover; }, get dragging() { return drag ? drag.tool : (pd ? 'poly' : null); } };
})(window.MLO);

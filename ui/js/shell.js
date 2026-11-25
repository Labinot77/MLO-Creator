// Interior shell for a vanilla house. The interior is a set of rectangles (add / cut), so the automatic fit and hand edits share one model.
// Walls are thin: the room's surface is the detected inner boundary and the wall box reaches outward by `wallDepth` towards the game's own wall.
// Output has the same shape as Mesher.build(): batches, collision boxes, portals, lights.
window.MLO = window.MLO || {};
(function (M) {
    'use strict';
    const TEX = M.TEX;
    const MAXV = 60000;
    const OPEN = {
        door: { w: 0.9, z0: 0, z1: 2.1, portal: 8192 },
        window: { w: 0.9, z0: 0.9, z1: 2.1, portal: 0, glass: true },
        arch: { w: 1.0, z0: 0, z1: 2.3, portal: 8192 }
    };

    // The surfaces a collision box can have: the game's own surface types (the numbers are the lines of data\materials\materials.dat), with the colour of the
    // box's outline in the editor. The type decides how it sounds, how bullets go through it and what it does to a ragdoll.
    const COLMATS = [
        { id: 'concrete', name: 'Concrete', type: 1, col: [0.72, 0.74, 0.80] }, { id: 'plaster', name: 'Plaster, drywall', type: 101, col: [0.95, 0.90, 0.72] },
        { id: 'brick', name: 'Brick', type: 13, col: [0.90, 0.52, 0.40] }, { id: 'stone', name: 'Stone', type: 11, col: [0.62, 0.66, 0.62] }, { id: 'marble', name: 'Marble', type: 14, col: [0.86, 0.88, 0.95] },
        { id: 'wood', name: 'Wood (polished)', type: 72, col: [0.82, 0.62, 0.36] }, { id: 'metal', name: 'Metal (solid)', type: 56, col: [0.55, 0.72, 0.95] }, { id: 'railing', name: 'Metal railing', type: 65, col: [0.40, 0.62, 0.90] },
        { id: 'tile', name: 'Tile (ceramic)', type: 81, col: [0.55, 0.92, 0.92] }, { id: 'carpet', name: 'Carpet', type: 97, col: [0.78, 0.58, 0.85] }, { id: 'linoleum', name: 'Linoleum', type: 95, col: [0.70, 0.85, 0.55] },
        { id: 'plastic', name: 'Plastic', type: 86, col: [0.95, 0.60, 0.80] }, { id: 'glass', name: 'Glass (shoot through)', type: 112, col: [0.50, 0.90, 1.0] }
    ];
    const COLMAT = {}; COLMATS.forEach(m => { COLMAT[m.id] = m; });
    M.COLMATS = { list: COLMATS, byId: COLMAT, get: (id) => COLMAT[id] || COLMAT.concrete };

    function uniq(a) { a.sort((p, q) => p - q); const o = []; for (const v of a) if (!o.length || Math.abs(v - o[o.length - 1]) > 1e-6) o.push(v); return o; }

    // ---------------- angled rooms: polygons of any shape (shell.polys = [{ id, pts: [[x, y], ...], tex, wtex }]) ----------------
    const pArea = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; };
    const crs = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    // counter-clockwise, without repeated or straight-through corners
    function cleanPoly(pts) {
        let p = (pts || []).filter((q, i, a) => Math.hypot(q[0] - a[(i + 1) % a.length][0], q[1] - a[(i + 1) % a.length][1]) > 0.01);
        for (let k = 0; k < 4 && p.length > 3; k++) p = p.filter((q, i, a) => { const A = a[(i + a.length - 1) % a.length], B = a[(i + 1) % a.length]; return Math.abs(crs(A, q, B)) > 1e-4 * Math.hypot(B[0] - A[0], B[1] - A[1]); });
        if (p.length < 3 || Math.abs(pArea(p)) < 0.04) return null;
        return pArea(p) < 0 ? p.slice().reverse() : p;
    }
    function polysOf(shell) { const o = []; ((shell && shell.polys) || []).forEach(pg => { const pts = cleanPoly(pg.pts); if (pts) o.push({ id: pg.id, pts, tex: pg.tex, wtex: pg.wtex }); }); return o; }
    function inPoly(p, x, y) { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const a = p[i], b = p[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
    // ear clipping (p counter-clockwise): index triples
    function triangulate(p) {
        const idx = p.map((_, i) => i), out = [];
        for (let guard = 0; idx.length > 3 && guard < 10000; guard++) {
            let cut = false;
            for (let i = 0; i < idx.length && !cut; i++) {
                const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length], a = p[ia], b = p[ib], c = p[ic];
                if (crs(a, b, c) <= 1e-9) continue;
                if (idx.some(k => k !== ia && k !== ib && k !== ic && crs(a, b, p[k]) >= -1e-9 && crs(b, c, p[k]) >= -1e-9 && crs(c, a, p[k]) >= -1e-9)) continue;
                out.push([ia, ib, ic]); idx.splice(i, 1); cut = true;
            }
            if (!cut) break;
        }
        if (idx.length === 3) out.push(idx.slice());
        return out;
    }
    // every edge moved d into the polygon, corners where the moved edges meet (mitred)
    function inset(p, d) {
        const n = p.length, L = (i) => { const a = p[i], b = p[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, t = [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; return { a: [a[0] - t[1] * d, a[1] + t[0] * d], t }; };
        return p.map((q, i) => {
            const e0 = L((i + n - 1) % n), e1 = L(i), den = e0.t[0] * e1.t[1] - e0.t[1] * e1.t[0];
            if (Math.abs(den) < 1e-6) return [q[0] - e1.t[1] * d, q[1] + e1.t[0] * d];
            const s = ((e1.a[0] - e0.a[0]) * e1.t[1] - (e1.a[1] - e0.a[1]) * e1.t[0]) / den;
            return [e0.a[0] + e0.t[0] * s, e0.a[1] + e0.t[1] * s];
        });
    }
    // the polygon as boxes turned by `ang`: strips `step` wide, each only as long as the polygon is at both of its sides (so no box reaches outside)
    function stripBoxes(pts, ang, step) {
        const c = Math.cos(ang), s = Math.sin(ang), loc = pts.map(q => [q[0] * c + q[1] * s, -q[0] * s + q[1] * c]);
        const cutAt = (v) => { const xs = []; loc.forEach((a, i) => { const b = loc[(i + 1) % loc.length]; if ((a[1] > v) !== (b[1] > v)) xs.push(a[0] + (v - a[1]) * (b[0] - a[0]) / (b[1] - a[1])); }); xs.sort((p, q) => p - q); const o = []; for (let k = 0; k + 1 < xs.length; k += 2) o.push([xs[k], xs[k + 1]]); return o; };
        const both = (A, B) => { const o = []; let i = 0, j = 0; while (i < A.length && j < B.length) { const lo = Math.max(A[i][0], B[j][0]), hi = Math.min(A[i][1], B[j][1]); if (hi - lo > 0.02) o.push([lo, hi]); if (A[i][1] < B[j][1]) i++; else j++; } return o; };
        let v0 = 1e9, v1 = -1e9; loc.forEach(q => { v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1]); });
        const n = Math.max(1, Math.min(800, Math.ceil((v1 - v0) / step - 1e-6))), h = (v1 - v0) / n, done = [], open = [];
        for (let j = 0; j < n; j++) {
            const a = v0 + j * h, iv = both(cutAt(a + 1e-5), cutAt(a + h - 1e-5)), next = [];
            iv.forEach(w => { const o = open.find(b => Math.abs(b.u0 - w[0]) < 1e-4 && Math.abs(b.u1 - w[1]) < 1e-4); if (o) { o.v1 = a + h; next.push(o); } else next.push({ u0: w[0], u1: w[1], v0: a, v1: a + h }); });
            open.forEach(b => { if (next.indexOf(b) < 0) done.push(b); }); open.length = 0; next.forEach(b => open.push(b));
        }
        open.forEach(b => done.push(b));
        return done.map(b => { const um = (b.u0 + b.u1) / 2, vm = (b.v0 + b.v1) / 2; return { cx: um * c - vm * s, cy: um * s + vm * c, w: b.u1 - b.u0, d: b.v1 - b.v0, yaw: ang }; });
    }
    // the turn of the strips that needs the fewest boxes (the edges of the polygon decide it)
    function polyBoxes(pts, step) {
        const angs = []; pts.forEach((a, i) => { const b = pts[(i + 1) % pts.length]; let g = Math.atan2(b[1] - a[1], b[0] - a[0]) % (Math.PI / 2); if (g < 0) g += Math.PI / 2; if (!angs.some(x => Math.abs(x - g) < 1e-3)) angs.push(g); });
        let best = null; angs.forEach(g => { const b = stripBoxes(pts, g, step || 0.1); if (!best || b.length < best.length) best = b; });
        return best || [];
    }
    // all the rooms as boxes in the grid's frame: the rectangles (turn 0) and the angled rooms (turned strips); `ins` moves the angled rooms' edges in
    function roomBoxes(shell, ins) {
        const out = gridRects(shell).map(r => ({ cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2, w: r[2] - r[0], d: r[3] - r[1], yaw: 0, rect: r }));
        polysOf(shell).forEach(pg => { const p = ins ? inset(pg.pts, ins) : pg.pts; if (Math.abs(pArea(p)) > 0.02) polyBoxes(p).forEach(b => out.push(b)); });
        return out;
    }

    // compressed grid of the region (union of 'add' rects minus 'cut' rects, in order)
    function regionGrid(shell, extraX, extraY) {
        const xs = [], ys = [];
        shell.ops.forEach(o => { xs.push(o.r[0], o.r[2]); ys.push(o.r[1], o.r[3]); });
        (extraX || []).forEach(v => xs.push(v)); (extraY || []).forEach(v => ys.push(v));
        const X = uniq(xs), Y = uniq(ys), nx = Math.max(X.length - 1, 0), ny = Math.max(Y.length - 1, 0), mask = [];
        for (let i = 0; i < nx; i++) mask.push(new Array(ny).fill(false));
        shell.ops.forEach(o => {
            const r = o.r;
            for (let i = 0; i < nx; i++) {
                const cx = (X[i] + X[i + 1]) / 2; if (cx <= r[0] || cx >= r[2]) continue;
                for (let j = 0; j < ny; j++) { const cy = (Y[j] + Y[j + 1]) / 2; if (cy > r[1] && cy < r[3]) mask[i][j] = o.op === 'add'; }
            }
        });
        return { X, Y, nx, ny, mask };
    }

    // wall segments along the boundary of the region; inward = which side of the wall line the room is on (+1 = towards +x / +y)
    function boundary(g) {
        const segs = [];
        for (let j = 0; j <= g.ny; j++) {
            let cur = null;
            for (let i = 0; i < g.nx; i++) {
                const below = j > 0 ? g.mask[i][j - 1] : false, above = j < g.ny ? g.mask[i][j] : false;
                if (below !== above) {
                    const inward = above ? 1 : -1;
                    if (cur && cur.inward === inward && Math.abs(cur.u1 - g.X[i]) < 1e-6) cur.u1 = g.X[i + 1];
                    else { cur = { o: 'H', c: g.Y[j], u0: g.X[i], u1: g.X[i + 1], inward, ops: [] }; segs.push(cur); }
                } else cur = null;
            }
        }
        for (let i = 0; i <= g.nx; i++) {
            let cur = null;
            for (let j = 0; j < g.ny; j++) {
                const left = i > 0 ? g.mask[i - 1][j] : false, right = i < g.nx ? g.mask[i][j] : false;
                if (left !== right) {
                    const inward = right ? 1 : -1;
                    if (cur && cur.inward === inward && Math.abs(cur.u1 - g.Y[j]) < 1e-6) cur.u1 = g.Y[j + 1];
                    else { cur = { o: 'V', c: g.X[i], u0: g.Y[j], u1: g.Y[j + 1], inward, ops: [] }; segs.push(cur); }
                } else cur = null;
            }
        }
        return segs;
    }

    // ---------------- floor heights: shell.floorH = { base, pts: [{ id, x, y, z, r, ry, slope, shape: 'round' | 'square' }] } ----------------
    // The floor is `base` high everywhere, except near a height point: flat at the point's height out to r (a square: r across, ry along y), then a
    // straight slope `slope` metres long back to the floor around it. Where points overlap they are averaged. Heights are above the grid floor (0).
    function floorCfg(shell) { const f = (shell && shell.floorH) || {}; return { base: +f.base || 0, pts: (f.pts || []).filter(p => isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) }; }
    function heightAt(fl, x, y) {
        let sw = 0, sd = 0;
        for (const p of fl.pts) {
            const r = p.r != null ? +p.r : 1, sl = Math.max(0.01, p.slope != null ? +p.slope : 1.5);
            const d = p.shape === 'square' ? Math.max(Math.abs(x - p.x) - r, Math.abs(y - p.y) - (p.ry != null ? +p.ry : r)) : Math.hypot(x - p.x, y - p.y) - r;
            const w = d <= 0 ? 1 : 1 - d / sl; if (w <= 0) continue; sw += w; sd += w * (p.z - fl.base);
        }
        return fl.base + sd / Math.max(1, sw);
    }
    // ---------------- the abandoned look: shell.atmos = { on, seed, potholes, damage, grime } (amounts 0..1) ----------------
    function atmosCfg(shell) { const a = (shell && shell.atmos) || {}; return { on: !!a.on, seed: (a.seed | 0) || 1, potholes: a.potholes != null ? +a.potholes : 0.5, damage: a.damage != null ? +a.damage : 0.5, grime: a.grime != null ? +a.grime : 0.6 }; }
    // the same random numbers for the same seed (so a project looks the same every time it is opened)
    function rng(seed) { let a = (seed | 0) ^ 0x9E3779B9; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
    function hashNums(arr) { let h = 2166136261; arr.forEach(v => { h = Math.imul(h ^ (Math.round(v * 100) | 0), 16777619); }); return h; }
    // a convex polygon ([x, y] corners) cut by a line: keeps the part where p[ax] >= v (keep > 0) or <= v (keep < 0)
    function clipAx(poly, ax, v, keep) {
        const out = []; for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length], ia = (a[ax] - v) * keep >= -1e-9, ib = (b[ax] - v) * keep >= -1e-9;
            if (ia) out.push(a);
            if (ia !== ib) { const t = (v - a[ax]) / (b[ax] - a[ax]); const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; q[ax] = v; out.push(q); }
        }
        return out;
    }
    const clipRect = (poly, x0, y0, x1, y1) => { let p = clipAx(poly, 0, x0, 1); if (p.length >= 3) p = clipAx(p, 0, x1, -1); if (p.length >= 3) p = clipAx(p, 1, y0, 1); if (p.length >= 3) p = clipAx(p, 1, y1, -1); return p.length >= 3 ? p : null; };
    // a pothole: an uneven round hole; depth below the floor at (x, y) (0 outside it)
    function potDepth(P, x, y) {
        const dx = x - P.cx, dy = y - P.cy, d = Math.hypot(dx, dy); if (d > P.rad * 1.4) return 0;
        const a = Math.atan2(dy, dx), rr = P.rad * (1 + 0.18 * Math.sin(3 * a + P.p1) + 0.1 * Math.sin(5 * a + P.p2) + 0.06 * Math.sin(9 * a + P.p3)), t = d / rr;
        const prof = t < 0.7 ? 1 : (t < 1 ? 1 - ((t - 0.7) / 0.3) * ((t - 0.7) / 0.3) * (3 - 2 * (t - 0.7) / 0.3) : 0);
        return P.depth * prof * (0.8 + 0.2 * Math.sin(x * 37 + P.p1) * Math.sin(y * 41 + P.p2));
    }

    function build(project, opts) {
        opts = opts || {};
        const S = project.shell, cfg = project.settings, D = project.defaults;
        const H = cfg.ceilH, depth = cfg.wallDepth, PT = cfg.partT;
        const exportMode = opts.mode === 'export';
        const wantBoxes = exportMode || !!opts.boxes;         // the collision boxes are made for the export, and for the editor's "my collision" outline
        // walls = 'skin' (imported models only): the walls are the building's own wall faces turned to look into the rooms, so they cannot be off by a millimetre;
        // no wall pieces or wall collision are made from the room edges (the game's own collision of the building stays). Openings, trim and portals still are.
        const skin = project.kind === 'import' && cfg.walls === 'skin';
        const acc = new Map(), batches = [], boxes = [], matList = [], matIdx = new Map(), portals = [], lights = [];
        const bmn = [1e9, 1e9, 1e9], bmx = [-1e9, -1e9, -1e9];
        const stats = { tris: 0, boxes: 0, portals: 0, lights: 0, warnings: [] };

        const FL = floorCfg(S), ATM = atmosCfg(S);
        const zOff = FL.base;                                                                    // walls' textures start at the floor (the dirty band sits on it)
        let zLow = Math.min(0, FL.base, ...FL.pts.map(p => +p.z)); zLow = zLow < 0 ? zLow - 0.02 : 0;     // walls reach down to the lowest floor
        // texture coordinates: square to the face (a slanted wall along its own length, so bricks are not stretched)
        function uvOf(p, nx, ny, nz, tile) {
            const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
            if (az > ax && az > ay) return [p[0] / tile, p[1] / tile];
            if (Math.min(ax, ay) > 0.02) { const h = Math.hypot(nx, ny); return [(-p[0] * ny + p[1] * nx) / h / tile, -(p[2] - zOff) / tile]; }
            return ax >= ay ? [p[1] / tile, -(p[2] - zOff) / tile] : [p[0] / tile, -(p[2] - zOff) / tile];
        }
        // one triangle with its own texture coordinates (uvs null: worked out from flat points `flat`, else from the corners)
        function emitRaw(kind, group, tex, pts, flat) {
            const key = kind + '|' + group + '|' + tex + '|0'; let m = acc.get(key);
            if (!m || m.pos.length / 3 + 3 > MAXV) { m = { level: 0, kind, group, tex, glass: false, pos: [], nrm: [], uv: [], idx: [] }; acc.set(key, m); batches.push(m); }
            const a = pts[0], b = pts[1], c = pts[2], ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz); if (l < 1e-12) return; nx /= l; ny /= l; nz /= l;
            const src = flat || pts, f = flat ? (() => { const p = flat, e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]]; const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], k = Math.hypot(n[0], n[1], n[2]) || 1; return [n[0] / k, n[1] / k, n[2] / k]; })() : [nx, ny, nz];
            const tile = TEX.tile(tex), base = m.pos.length / 3;
            pts.forEach((p, i) => { const uv = uvOf(src[i], f[0], f[1], f[2], tile); m.pos.push(p[0], p[1], p[2]); m.nrm.push(nx, ny, nz); m.uv.push(uv[0], uv[1]); for (let q = 0; q < 3; q++) { if (p[q] < bmn[q]) bmn[q] = p[q]; if (p[q] > bmx[q]) bmx[q] = p[q]; } });
            m.idx.push(base, base + 1, base + 2); stats.tris += 1;
        }
        // A wall face (upright rectangle): down to the lowest floor; with the abandoned look, chunks knocked out of it and the dirty band at its bottom.
        function emitQuad(kind, group, tex, glass, a, b, c, d) {
            if (glass || kind !== 'wall' || (!ATM.on && zLow === 0)) return emitQuad0(kind, group, tex, glass, a, b, c, d);
            const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz); if (l < 1e-12) return; nx /= l; ny /= l; nz /= l;
            const hl = Math.hypot(nx, ny); if (hl < 0.98) return emitQuad0(kind, group, tex, glass, a, b, c, d);
            const tx = -ny / hl, ty = nx / hl, off = (a[0] * nx + a[1] * ny) / hl, S2 = [a, b, c, d].map(p => [p[0] * tx + p[1] * ty, p[2]]);
            const s0 = Math.min(...S2.map(q => q[0])), s1 = Math.max(...S2.map(q => q[0])), z0r = Math.min(...S2.map(q => q[1])), z1 = Math.max(...S2.map(q => q[1]));
            if (!S2.every(q => (Math.abs(q[0] - s0) < 1e-5 || Math.abs(q[0] - s1) < 1e-5) && (Math.abs(q[1] - z0r) < 1e-5 || Math.abs(q[1] - z1) < 1e-5))) return emitQuad0(kind, group, tex, glass, a, b, c, d);
            const z0 = Math.abs(z0r) < 1e-6 ? zLow : z0r, P = (sv, z, dn) => [tx * sv + nx / hl * (off - (dn || 0)), ty * sv + ny / hl * (off - (dn || 0)), z];
            const quad = (t, sa, sb, za, zb) => { if (sb - sa > 1e-5 && zb - za > 1e-5) emitQuad0(kind, group, t, false, P(sa, za), P(sb, za), P(sb, zb), P(sa, zb)); };
            const dirtyOk = ATM.on && ATM.grime > 0.05 && !/^trim|^glass|_low$/.test(tex), band = zOff + TEX.tile(tex), texAt = (z) => (dirtyOk && z < band ? TEX.low(tex) : tex);
            // a rectangle of the wall, split at the top of the dirty band
            const piece = (sa, sb, za, zb) => { if (dirtyOk && za < band - 1e-4 && zb > band + 1e-4) { quad(texAt(za), sa, sb, za, band); quad(tex, sa, sb, band, zb); } else quad(texAt((za + zb) / 2), sa, sb, za, zb); };
            const holes = ATM.on && ATM.damage > 0.01 && tex.indexOf('trim') !== 0 ? wallHoles(s0, s1, z0, z1, nx, ny, off) : [];
            if (!holes.length) return piece(s0, s1, z0, z1);
            // the face around the holes: cut into rectangles column by column
            const xs = uniq([s0, s1].concat(...holes.map(h => [h.s0, h.s1]))).filter(v => v >= s0 - 1e-9 && v <= s1 + 1e-9);
            for (let i = 0; i + 1 < xs.length; i++) {
                const sa = xs[i], sb = xs[i + 1], m = (sa + sb) / 2, cut = holes.filter(h => h.s0 < m && h.s1 > m).sort((p, q) => p.z0 - q.z0); let zc = z0;
                cut.forEach(h => { piece(sa, sb, zc, h.z0); zc = h.z1; }); piece(sa, sb, zc, z1);
            }
            // each hole: a fine grid pushed into the wall where the chunk is missing; the broken part shows rough masonry
            holes.forEach(h => {
                const nu = Math.max(2, Math.ceil((h.s1 - h.s0) / 0.04)), nv = Math.max(2, Math.ceil((h.z1 - h.z0) / 0.04)), V = [];
                for (let j = 0; j <= nv; j++) { V.push([]); for (let i = 0; i <= nu; i++) { const sv = h.s0 + (h.s1 - h.s0) * i / nu, z = h.z0 + (h.z1 - h.z0) * j / nv, edge = i === 0 || j === 0 || i === nu || j === nv; V[j].push({ sv, z, dn: edge ? 0 : h.at(sv, z) }); } }
                for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
                    const q = [V[j][i], V[j][i + 1], V[j + 1][i + 1], V[j + 1][i]], broken = q.some(v => v.dn > 0.003), t = broken ? 'old_broken' : texAt((q[0].z + q[2].z) / 2);
                    [[0, 1, 2], [2, 3, 0]].forEach(tr => emitRaw(kind, group, t, tr.map(k => P(q[k].sv, q[k].z, q[k].dn)), tr.map(k => P(q[k].sv, q[k].z, 0))));
                }
            });
        }
        // Where chunks are knocked out of a wall face: a few per square metre (damage), never overlapping, kept off the edges. The same wall gets the
        // same holes every time (the random numbers start from the seed and the wall's place).
        function wallHoles(s0, s1, z0, z1, nx, ny, off) {
            const W = s1 - s0, Hh = z1 - z0; if (W < 0.5 || Hh < 0.5) return [];
            const r = rng(ATM.seed * 7919 + hashNums([nx, ny, off, s0, s1, z0, z1])), want = W * Hh * ATM.damage * 0.22; let n = Math.floor(want) + (r() < want % 1 ? 1 : 0);
            const out = [];
            for (let k = 0; k < n * 4 && out.length < n; k++) {
                const big = r() < 0.25, w = big ? 0.35 + r() * 0.35 : 0.12 + r() * 0.25, h = big ? 0.25 + r() * 0.3 : 0.08 + r() * 0.2;
                if (w > W - 0.1 || h > Hh - 0.25) continue;
                const sa = s0 + 0.05 + r() * (W - 0.1 - w), za = z0 + 0.1 + Math.pow(r(), 1.6) * (Hh - 0.25 - h);      // (more of them low down, where things hit the wall)
                if (out.some(o => sa < o.s1 + 0.05 && sa + w > o.s0 - 0.05 && za < o.z1 + 0.05 && za + h > o.z0 - 0.05)) continue;
                const cs = sa + w / 2, cz = za + h / 2, dep = (big ? 0.04 : 0.02) + r() * 0.035, p1 = r() * 6.28, p2 = r() * 6.28, p3 = r() * 6.28;
                out.push({ s0: sa, s1: sa + w, z0: za, z1: za + h, at: (sv, z) => {
                    const dx = (sv - cs) / (w / 2), dz = (z - cz) / (h / 2), d = Math.hypot(dx, dz), a = Math.atan2(dz, dx), rr = 0.72 + 0.12 * Math.sin(3 * a + p1) + 0.07 * Math.sin(7 * a + p2) + 0.05 * Math.sin(13 * a + p3);
                    return d < rr ? dep * (0.75 + 0.25 * Math.sin(sv * 53 + p1) * Math.sin(z * 47 + p2)) : 0;
                } });
            }
            return out;
        }
        function emitQuad0(kind, group, tex, glass, a, b, c, d) {
            const key = kind + '|' + group + '|' + tex + '|' + (glass ? 1 : 0);
            let m = acc.get(key);
            if (!m || m.pos.length / 3 + 4 > MAXV) { m = { level: 0, kind, group, tex, glass: !!glass, pos: [], nrm: [], uv: [], idx: [] }; acc.set(key, m); batches.push(m); }
            const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const l = Math.hypot(nx, ny, nz); if (l < 1e-12) return; nx /= l; ny /= l; nz /= l;
            const tile = glass ? 1 : TEX.tile(tex), ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz), base = m.pos.length / 3;
            [a, b, c, d].forEach(p => {
                m.pos.push(p[0], p[1], p[2]); m.nrm.push(nx, ny, nz);
                const uv = uvOf(p, nx, ny, nz, tile); m.uv.push(uv[0], uv[1]);
                for (let q = 0; q < 3; q++) { if (p[q] < bmn[q]) bmn[q] = p[q]; if (p[q] > bmx[q]) bmx[q] = p[q]; }
            });
            m.idx.push(base, base + 1, base + 2, base + 2, base + 3, base); stats.tris += 2;
        }
        // one triangle (a, b, c); the normal follows the winding
        function emitTri(kind, group, tex, a, b, c) {
            const key = kind + '|' + group + '|' + tex + '|0'; let m = acc.get(key);
            if (!m || m.pos.length / 3 + 3 > MAXV) { m = { level: 0, kind, group, tex, glass: false, pos: [], nrm: [], uv: [], idx: [] }; acc.set(key, m); batches.push(m); }
            const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz); if (l < 1e-12) return; nx /= l; ny /= l; nz /= l;
            const tile = TEX.tile(tex), ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz), base = m.pos.length / 3;
            [a, b, c].forEach(p => {
                m.pos.push(p[0], p[1], p[2]); m.nrm.push(nx, ny, nz);
                const uv = uvOf(p, nx, ny, nz, tile); m.uv.push(uv[0], uv[1]);
                for (let q = 0; q < 3; q++) { if (p[q] < bmn[q]) bmn[q] = p[q]; if (p[q] > bmx[q]) bmx[q] = p[q]; }
            });
            m.idx.push(base, base + 1, base + 2); stats.tris += 1;
        }
        // axis-aligned rectangle in the plane ax = f, ranges (p0,p1) x (q0,q1) over the cyclic pair of the other axes; sign = facing direction
        function pq(kind, group, tex, glass, ax, f, p0, p1, q0, q1, sign) {
            if (p1 - p0 < 1e-5 || q1 - q0 < 1e-5) return;
            const P = (p, q) => ax === 'x' ? [f, p, q] : (ax === 'y' ? [q, f, p] : [p, q, f]);
            const a = P(p0, q0), b = P(p1, q0), c = P(p1, q1), d = P(p0, q1);
            if (sign > 0) emitQuad(kind, group, tex, glass, a, b, c, d); else emitQuad(kind, group, tex, glass, a, d, c, b);
        }
        function box(kind, group, tex, x0, y0, z0, x1, y1, z1) {
            pq(kind, group, tex, false, 'x', x1, y0, y1, z0, z1, 1); pq(kind, group, tex, false, 'x', x0, y0, y1, z0, z1, -1);
            pq(kind, group, tex, false, 'y', y1, z0, z1, x0, x1, 1); pq(kind, group, tex, false, 'y', y0, z0, z1, x0, x1, -1);
            pq(kind, group, tex, false, 'z', z1, x0, x1, y0, y1, 1); pq(kind, group, tex, false, 'z', z0, x0, x1, y0, y1, -1);
        }
        function cbox(x0, y0, z0, x1, y1, z1, type, room) {
            if (z0 === 0 && z1 > 0.3) z0 = zLow;
            if (!wantBoxes) return;
            if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4 || z1 - z0 < 1e-4) return;
            const mk = type + '|' + room; let mi = matIdx.get(mk);
            if (mi === undefined) { mi = matList.length; matList.push([type, room]); matIdx.set(mk, mi); }
            boxes.push([x0, y0, z0, x1, y1, z1, mi]);
        }
        // a collision box that is turned about Z (the ones the user draws): the first six numbers are the box around it, the eighth says how it really stands
        function cboxO(cx, cy, z0, z1, hu, hn, yaw, type, room, id) {
            if (!wantBoxes) return;
            if (z0 === 0 && z1 > 0.3 && id == null) z0 = zLow;
            if (hu < 5e-5 || hn < 5e-5 || z1 - z0 < 1e-4) return;
            const mk = type + '|' + room; let mi = matIdx.get(mk);
            if (mi === undefined) { mi = matList.length; matList.push([type, room]); matIdx.set(mk, mi); }
            const c = Math.cos(yaw), s = Math.sin(yaw), square = Math.abs(s) < 1e-9 || Math.abs(c) < 1e-9;
            const ex = Math.abs(c) * hu + Math.abs(s) * hn, ey = Math.abs(s) * hu + Math.abs(c) * hn;
            boxes.push([cx - ex, cy - ey, z0, cx + ex, cy + ey, z1, mi, square ? { user: id } : { user: id, cx, cy, hu, hn, yaw }]);          // (square to the grid: the box around it is the box)
        }
        // a three-sided upright prism (floor and ceiling of an angled room): tri = three [x, y] corners
        function cprism(tri, z0, z1, type, room, zt) {
            if (!wantBoxes) return;
            const mk = type + '|' + room; let mi = matIdx.get(mk);
            if (mi === undefined) { mi = matList.length; matList.push([type, room]); matIdx.set(mk, mi); }
            const xs = tri.map(q => q[0]), ys = tri.map(q => q[1]);
            boxes.push([Math.min(...xs), Math.min(...ys), z0, Math.max(...xs), Math.max(...ys), zt ? Math.max(...zt) : z1, mi, zt ? { prism: tri.map(q => [q[0], q[1]]), zt } : { prism: tri.map(q => [q[0], q[1]]) }]);
        }

        // ---------------- region, floors, ceiling ----------------
        const fx = [], fy = [];
        (S.floors || []).forEach(f => { fx.push(f.r[0], f.r[2]); fy.push(f.r[1], f.r[3]); });
        const g = regionGrid(S, fx, fy);
        const inGrid = (x, y) => { for (let i = 0; i < g.nx; i++) if (x >= g.X[i] && x < g.X[i + 1]) { for (let j = 0; j < g.ny; j++) if (y >= g.Y[j] && y < g.Y[j + 1]) return g.mask[i][j]; } return false; };
        const polys = polysOf(S), inPolyAny = (x, y, skip) => polys.some((pg, i) => i !== skip && inPoly(pg.pts, x, y));
        const inRegion = (x, y) => inGrid(x, y) || inPolyAny(x, y, -1);
        // the parts of [u0, u1] where test(u) holds, edges found to 2 mm
        const runs = (u0, u1, test) => {
            const out = [], n = Math.max(1, Math.ceil((u1 - u0) / 0.05)), h = (u1 - u0) / n, edge = (a, b, va) => { for (let k = 0; k < 9; k++) { const m = (a + b) / 2; if (test(m) === va) a = m; else b = m; } return (a + b) / 2; };
            let prev = test(u0 + h / 2), start = prev ? u0 : null;
            for (let k = 1; k < n; k++) { const u = u0 + (k + 0.5) * h, v = test(u); if (v !== prev) { const e = edge(u - h, u, prev); if (v) start = e; else { out.push([start, e]); start = null; } prev = v; } }
            if (start != null) out.push([start, u1]);
            return out.filter(r => r[1] - r[0] > 0.01);
        };
        const floorTexAt = (cx, cy) => { let t = D.floor; (S.floors || []).forEach(f => { if (cx > f.r[0] && cx < f.r[2] && cy > f.r[1] && cy < f.r[3]) t = f.tex; }); return t; };
        {
            const cells = [], used = [];
            for (let i = 0; i < g.nx; i++) { used.push(new Array(g.ny).fill(false)); for (let j = 0; j < g.ny; j++) if (g.mask[i][j]) cells.push([i, j, floorTexAt((g.X[i] + g.X[i + 1]) / 2, (g.Y[j] + g.Y[j + 1]) / 2)]); }
            const texOf = (i, j) => g.mask[i][j] ? floorTexAt((g.X[i] + g.X[i + 1]) / 2, (g.Y[j] + g.Y[j + 1]) / 2) : null;
            cells.forEach(c => {
                const i = c[0], j = c[1]; if (used[i][j]) return; const tex = c[2];
                let i1 = i + 1; while (i1 < g.nx && !used[i1][j] && texOf(i1, j) === tex) i1++;
                let j1 = j + 1; for (; j1 < g.ny; j1++) { let ok = true; for (let x = i; x < i1; x++) if (used[x][j1] || texOf(x, j1) !== tex) { ok = false; break; } if (!ok) break; }
                for (let x = i; x < i1; x++) for (let y = j; y < j1; y++) used[x][y] = true;
                const x0 = g.X[i], x1 = g.X[i1], y0 = g.Y[j], y1 = g.Y[j1];
                pq('floor', 'int', tex, false, 'z', 0, x0, x1, y0, y1, 1);
                pq('roof', 'int', D.ceiling, false, 'z', H, x0, x1, y0, y1, -1);
                cbox(x0, y0, -0.35, x1, y1, 0, TEX.colType(tex), 1);
                cbox(x0, y0, H, x1, y1, H + 0.1, 101, 0);
            });
        }

        // ---------------- walls around the region ----------------
        const segs = boundary(g);
        const entranceOpen = (S.openings || []).find(o => o.entrance);
        (S.openings || []).forEach(op => {
            let best = null, bo = 0;
            segs.forEach(sg => {
                if (sg.o !== op.o || Math.abs(sg.c - op.c) > 0.3) return;
                const ov = Math.min(sg.u1, op.u1) - Math.max(sg.u0, op.u0); if (ov > bo + 1e-9 && ov > 0.04) { bo = ov; best = sg; }
            });
            if (best) best.ops.push({ u0: Math.max(op.u0, best.u0), u1: Math.min(op.u1, best.u1), z0: op.z0, z1: op.z1, type: op.type, id: op.id, entrance: !!op.entrance });
        });

        // cutters the user placed (imported-model projects) also open the interior walls they pass through
        const spans = [];
        const fitCut = M.FitModels ? M.FitModels.cutters(project) : [];                                    // placed window and door models (Models tool): they open the walls too
        (((project.import && project.import.cutters) || []).concat(fitCut)).forEach(k => {
            const q = (((k.yaw * 180 / Math.PI) % 360) + 360) % 360, r90 = q % 90; if (Math.min(r90, 90 - r90) > (k.face ? 6 : 1.5)) return;      // faces of the model can be a few degrees off the grid
            const horiz = Math.round(q / 90) % 2 === 0, cu = horiz ? k.cx : k.cy, cn = horiz ? k.cy : k.cx;
            const type = k.face ? k.type : (k.type === 'arch' ? 'arch' : ((k.type === 'window' || (k.type === 'door' && k.zb > 0.3)) ? 'window' : 'door'));
            // (a door with a frame that is bigger than its opening: the walls open to the frame, which is where the model's wall is cut out to as well)
            const fe = M.ImportModel && M.ImportModel.doorFrameExtent ? M.ImportModel.doorFrameExtent(k) : null, ju = fe ? fe.cu : k.w / 2, zTop = fe ? fe.ct : k.zb + k.h;
            spans.push({ o: horiz ? 'H' : 'V', u0: cu - ju, u1: cu + ju, n0: cn - k.d / 2, n1: cn + k.d / 2, z0: Math.max(0, k.zb), z1: Math.min(H, zTop), type, id: 'cut' + k.id, face: !!k.face });
        });
        spans.forEach(sp => segs.forEach(sg => {
            if (sg.o !== sp.o || sg.c < sp.n0 - 0.03 || sg.c > sp.n1 + 0.03) return;
            const u0 = Math.max(sp.u0, sg.u0), u1 = Math.min(sp.u1, sg.u1); if (u1 - u0 < 0.04 || sp.z1 - sp.z0 < 0.1) return;
            sg.ops.push({ u0, u1, z0: sp.z0, z1: sp.z1, type: sp.type, id: sp.id, entrance: false, face: sp.face });
        }));

        // Wall thickness (into the room): things of the building stick through the wall (frames and vents reach 5 to 10 cm past the wall surface into the room), so the
        // inner face of every wall moves `T` into the room, sg.ci. At a corner of the room the two walls meet at their moved faces: both end T shorter; round a
        // corner that sticks into the room they end T longer.
        const T = Math.max(0, Math.min(0.5, +cfg.wallThick || 0)), ciOf = (sg) => sg.ci != null ? sg.ci : sg.c;
        // The thickness only goes into the room: with one set, nothing of a wall (collision, sides of openings, portals) reaches past the room edge to the outside,
        // which is the building's own wall. Without one, the old "wall depth" still reaches out that far.
        const outD = T > 0.0005 ? 0 : depth, ext0 = T > 0.0005 ? T : depth;
        if (T > 0.0005) {
            const vk = (x, y) => Math.round(x * 1e4) + ',' + Math.round(y * 1e4), endsAt = new Map(), endKey = (sg, e) => { const u = e ? sg.u1 : sg.u0; return sg.o === 'H' ? vk(u, sg.c) : vk(sg.c, u); };
            segs.forEach(sg => [0, 1].forEach(e => { const k = endKey(sg, e); let l = endsAt.get(k); if (!l) endsAt.set(k, l = []); l.push({ sg, end: e }); }));
            const moves = [];
            segs.forEach(sg => {
                sg.ci = sg.c + sg.inward * T;
                [0, 1].forEach(e => {
                    const here = endsAt.get(endKey(sg, e)), perp = here.filter(o => o.sg.o !== sg.o); if (perp.length !== 1 || here.some(o => o.sg !== sg && o.sg.o === sg.o)) return;
                    const B = perp[0].sg, dB = perp[0].end === 0 ? 1 : -1, dA = e ? 1 : -1, sA = sg.inward, sB = B.inward;
                    if (dB === sA && sB === -dA) moves.push([sg, e, -T]); else if (dB === -sA && sB === dA) moves.push([sg, e, T]);
                });
            });
            moves.forEach(m => { if (m[1]) m[0].u1 += m[2]; else m[0].u0 -= m[2]; });
        }
        // a piece of wall: inner face over [u0,u1] x [z0,z1]; collision box reaches `depth` outward and `ext` past the ends
        function wallPiece(sg, u0, u1, z0, z1, extLo, extHi) {
            if (u1 - u0 < 1e-5 || z1 - z0 < 1e-5) return;
            // where an angled room lies behind the wall the rooms are one: no wall there
            if (polys.length) {
                const o = sg.c - sg.inward * 0.08, behind = (u) => sg.o === 'H' ? inPolyAny(u, o, -1) : inPolyAny(o, u, -1), gaps = runs(u0, u1, behind);
                if (gaps.length) { let cur = u0; gaps.forEach(r => { wallBit(sg, cur, r[0], z0, z1, cur === u0 ? extLo : 0, 0); cur = r[1]; }); wallBit(sg, cur, u1, z0, z1, 0, extHi); return; }
            }
            wallBit(sg, u0, u1, z0, z1, extLo, extHi);
        }
        function wallBit(sg, u0, u1, z0, z1, extLo, extHi) {
            if (u1 - u0 < 1e-5 || z1 - z0 < 1e-5) return;
            const tex = sg.tex || D.wallInt, ci = ciOf(sg);
            // (walls = 'skin' has no wall faces of its own, but still the collision: the building's collision is cleared out of the rooms, so the walls need it from here)
            if (!skin) { if (sg.o === 'H') pq('wall', 'int', tex, false, 'y', ci, z0, z1, u0, u1, sg.inward); else pq('wall', 'int', tex, false, 'x', ci, u0, u1, z0, z1, sg.inward); }
            const out = sg.c - sg.inward * outD, o0 = Math.min(ci, out), o1 = Math.max(ci, out), a = u0 - extLo, b = u1 + extHi;
            if (sg.o === 'H') cbox(a, o0, z0, b, o1, z1, TEX.colType(tex), 0); else cbox(o0, a, z0, o1, b, z1, TEX.colType(tex), 0);
        }
        function revealQuad(sg, plane, f, a0, a1, z0, z1, sign) {
            // plane: 'u' jamb at u = f (normal along the wall line), 'z' head/sill at z = f
            const ci = ciOf(sg), out = sg.c - sg.inward * outD, o0 = Math.min(ci, out), o1 = Math.max(ci, out);
            if (plane === 'u') { if (sg.o === 'H') pq('wall', 'int', D.trim, false, 'x', f, o0, o1, z0, z1, sign); else pq('wall', 'int', D.trim, false, 'y', f, z0, z1, o0, o1, sign); }
            else { if (sg.o === 'H') pq('wall', 'int', D.trim, false, 'z', f, a0, a1, o0, o1, sign); else pq('wall', 'int', D.trim, false, 'z', f, o0, o1, a0, a1, sign); }
        }
        function casing(sg, u0, u1, z0, z1, thick, group) {
            // thin trim plates on the room side around an opening
            const cw = 0.06, e0 = ciOf(sg), e1 = e0 + sg.inward * thick;
            const plate = (a0, a1, b0, b1) => {
                if (a1 - a0 < 1e-5 || b1 - b0 < 1e-5) return;
                if (sg.o === 'H') box('wall', 'int', D.trim, a0, Math.min(e0, e1), b0, a1, Math.max(e0, e1), b1); else box('wall', 'int', D.trim, Math.min(e0, e1), a0, b0, Math.max(e0, e1), a1, b1);
            };
            plate(u0 - cw, u0, z0, z1 + cw); plate(u1, u1 + cw, z0, z1 + cw); plate(u0, u1, z1, z1 + cw); if (z0 > 0.05) plate(u0, u1, z0 - cw, z0);
        }

        segs.forEach(sg => {
            sg.ops.sort((a, b) => a.u0 - b.u0);
            let cur = sg.u0, first = true;
            sg.ops.forEach(op => {
                op.u0 = Math.max(op.u0, sg.u0); op.u1 = Math.min(op.u1, sg.u1); if (op.u1 - op.u0 < 0.02) return;          // (a wall that was made shorter at a corner keeps the part of an opening that is left)
                if (op.u0 < cur - 1e-6) return;
                wallPiece(sg, cur, op.u0, 0, H, first ? ext0 : 0, 0); first = false;
                wallPiece(sg, op.u0, op.u1, op.z1, H, 0, 0);
                if (op.z0 > 1e-4) wallPiece(sg, op.u0, op.u1, 0, op.z0, 0, 0);
                // an opening made from the model's faces has no generated trim: it is only cut through the wall (glass or the door model fill it)
                // (with a wall thickness the hole has sides, so the reveals are made for those too)
                if (!op.face || T > 0.0005) {
                    revealQuad(sg, 'u', op.u0, 0, 0, op.z0, op.z1, 1); revealQuad(sg, 'u', op.u1, 0, 0, op.z0, op.z1, -1);
                    revealQuad(sg, 'z', op.z1, op.u0, op.u1, 0, 0, -1); if (op.z0 > 1e-4) revealQuad(sg, 'z', op.z0, op.u0, op.u1, 0, 0, 1);
                    if (!op.face) casing(sg, op.u0, op.u1, op.z0, op.z1, 0.02, 'int');
                }
                if (op.type === 'window' && !op.face) {
                    // frame, mullions and glass at the middle of the wall depth
                    const wc = sg.c - sg.inward * outD / 2 + sg.inward * T / 2, fb = 0.045, fd = 0.03, zc = (op.z0 + op.z1) / 2, uc = (op.u0 + op.u1) / 2;
                    const fbox = (a0, a1, b0, b1, h) => { if (sg.o === 'H') box('wall', 'int', D.trim, a0, wc - h, b0, a1, wc + h, b1); else box('wall', 'int', D.trim, wc - h, a0, b0, wc + h, a1, b1); };
                    fbox(op.u0, op.u0 + fb, op.z0, op.z1, fd); fbox(op.u1 - fb, op.u1, op.z0, op.z1, fd);
                    fbox(op.u0 + fb, op.u1 - fb, op.z0, op.z0 + fb, fd); fbox(op.u0 + fb, op.u1 - fb, op.z1 - fb, op.z1, fd);
                    if (op.u1 - op.u0 > 0.6) fbox(uc - 0.015, uc + 0.015, op.z0 + fb, op.z1 - fb, 0.025);
                    if (op.z1 - op.z0 > 0.7) fbox(op.u0 + fb, op.u1 - fb, zc - 0.015, zc + 0.015, 0.025);
                    const gu0 = op.u0 + fb, gu1 = op.u1 - fb, gz0 = op.z0 + fb, gz1 = op.z1 - fb;
                    if (sg.o === 'H') { pq('glass', 'glass', 'glass', true, 'y', wc + 0.003, gz0, gz1, gu0, gu1, 1); pq('glass', 'glass', 'glass', true, 'y', wc - 0.003, gz0, gz1, gu0, gu1, -1); cbox(gu0, wc - 0.015, gz0, gu1, wc + 0.015, gz1, 112, 0); }
                    else { pq('glass', 'glass', 'glass', true, 'x', wc + 0.003, gu0, gu1, gz0, gz1, 1); pq('glass', 'glass', 'glass', true, 'x', wc - 0.003, gu0, gu1, gz0, gz1, -1); cbox(wc - 0.015, gu0, gz0, wc + 0.015, gu1, gz1, 112, 0); }
                }
                // portal to the outside
                if (exportMode) {
                    const spec = OPEN[op.type] || OPEN.window, out = -sg.inward, wm = sg.c - sg.inward * outD / 2 + sg.inward * T / 2;
                    let a, b, c, d; const U0 = op.u0, U1 = op.u1, Z0 = op.z0, Z1 = op.z1;
                    if (sg.o === 'H') { if (out < 0) { a = [U0, wm, Z0]; b = [U1, wm, Z0]; c = [U1, wm, Z1]; d = [U0, wm, Z1]; } else { a = [U1, wm, Z0]; b = [U0, wm, Z0]; c = [U0, wm, Z1]; d = [U1, wm, Z1]; } }
                    else { if (out < 0) { a = [wm, U1, Z0]; b = [wm, U0, Z0]; c = [wm, U0, Z1]; d = [wm, U1, Z1]; } else { a = [wm, U0, Z0]; b = [wm, U1, Z0]; c = [wm, U1, Z1]; d = [wm, U0, Z1]; } }
                    const pr = { flags: spec.portal, corners: [].concat(a, b, c, d) };
                    if (op.type === 'window') portals.push(pr); else if (op.entrance) portals.unshift(pr); else portals.push(pr);
                }
                cur = op.u1;
            });
            wallPiece(sg, cur, sg.u1, 0, H, first ? ext0 : 0, ext0);
        });

        // ---------------- the building's own walls, turned inwards (walls = 'skin') ----------------
        if (skin && M.ImportModel && M.ImportModel.wallFaces) {
            const inRoom = inRegion;
            let n = 0;
            M.ImportModel.wallFaces().forEach(f => {
                const nh = Math.hypot(f.n[0], f.n[1]); if (nh < 0.5 || f.c[2] < -0.3 || f.c[2] > H + 0.3) return; const nx = f.n[0] / nh, ny = f.n[1] / nh;
                // the room is behind the face (a model's faces look outwards) and nothing of the room is in front of it
                let behind = false; for (const d of [0.05, 0.12, 0.25]) if (inRoom(f.c[0] - nx * d, f.c[1] - ny * d)) { behind = true; break; }
                if (!behind || inRoom(f.c[0] + nx * 0.1, f.c[1] + ny * 0.1)) return;
                const sx = -nx * T, sy = -ny * T;                                                                                    // wall thickness: moved into the room
                emitTri('wall', 'int', D.wallInt, [f.p[0] + sx, f.p[1] + sy, f.p[2]], [f.p[6] + sx, f.p[7] + sy, f.p[8]], [f.p[3] + sx, f.p[4] + sy, f.p[5]]); n++;        // turned round: it looks into the room
            });
            stats.skin = n;
        }

        // ---------------- partition walls ----------------
        (S.parts || []).forEach(pt => {
            const pops = (pt.open || []).slice();
            spans.forEach(sp => { if (sp.o !== pt.o || pt.c < sp.n0 - 0.03 || pt.c > sp.n1 + 0.03) return; const u0 = Math.max(sp.u0, pt.u0), u1 = Math.min(sp.u1, pt.u1); if (u1 - u0 >= 0.04 && sp.z1 - sp.z0 >= 0.1) pops.push({ u0, u1, z0: sp.z0, z1: sp.z1 }); });
            const ops = pops.sort((a, b) => a.u0 - b.u0), tex = pt.texA || D.wallInt, texB = pt.texB || D.wallInt;
            const lo = pt.c - PT / 2, hi = pt.c + PT / 2, ctype = TEX.colType(tex);
            const piece = (u0, u1, z0, z1) => {
                if (u1 - u0 < 1e-5 || z1 - z0 < 1e-5) return;
                if (pt.o === 'H') { pq('wall', 'int', texB, false, 'y', hi, z0, z1, u0, u1, 1); pq('wall', 'int', tex, false, 'y', lo, z0, z1, u0, u1, -1); cbox(u0, lo, z0, u1, hi, z1, ctype, 0); }
                else { pq('wall', 'int', texB, false, 'x', hi, u0, u1, z0, z1, 1); pq('wall', 'int', tex, false, 'x', lo, u0, u1, z0, z1, -1); cbox(lo, u0, z0, hi, u1, z1, ctype, 0); }
            };
            const cap = (u, sign) => { if (pt.o === 'H') pq('wall', 'int', D.trim, false, 'x', u, lo, hi, 0, H, sign); else pq('wall', 'int', D.trim, false, 'y', u, 0, H, lo, hi, sign); };
            const jamb = (u, sign, z0, z1) => { if (pt.o === 'H') pq('wall', 'int', D.trim, false, 'x', u, lo, hi, z0, z1, sign); else pq('wall', 'int', D.trim, false, 'y', u, z0, z1, lo, hi, sign); };
            const headsill = (z, u0, u1, sign) => { if (pt.o === 'H') pq('wall', 'int', D.trim, false, 'z', z, u0, u1, lo, hi, sign); else pq('wall', 'int', D.trim, false, 'z', z, lo, hi, u0, u1, sign); };
            let cur = pt.u0; cap(pt.u0, -1); cap(pt.u1, 1);
            ops.forEach(op => {
                if (op.u0 < cur - 1e-6) return;
                piece(cur, op.u0, 0, H); piece(op.u0, op.u1, op.z1, H); if (op.z0 > 1e-4) piece(op.u0, op.u1, 0, op.z0);
                jamb(op.u0, 1, op.z0, op.z1); jamb(op.u1, -1, op.z0, op.z1); headsill(op.z1, op.u0, op.u1, -1); if (op.z0 > 1e-4) headsill(op.z0, op.u0, op.u1, 1);
                cur = op.u1;
            });
            piece(cur, pt.u1, 0, H);
        });

        // ---------------- angled rooms (polygons) and angled partitions: walls at any angle ----------------
        // Every cutter and placed model is an opening in a straight wall it lies along (turned the same way, within 6 degrees) and passes through.
        const ksp = (((project.import && project.import.cutters) || []).concat(fitCut)).map(k => {
            const fe = M.ImportModel && M.ImportModel.doorFrameExtent ? M.ImportModel.doorFrameExtent(k) : null;
            const type = k.face ? k.type : (k.type === 'arch' ? 'arch' : ((k.type === 'window' || (k.type === 'door' && k.zb > 0.3)) ? 'window' : 'door'));
            return { cx: k.cx, cy: k.cy, ux: Math.cos(k.yaw), uy: Math.sin(k.yaw), ju: fe ? fe.cu : k.w / 2, hd: k.d / 2, z0: Math.max(0, k.zb), z1: Math.min(H, fe ? fe.ct : k.zb + k.h), type, face: !!k.face };
        });
        const lineOps = (A, t, ua, ub, reach) => {
            const out = [];
            ksp.forEach(k => {
                if (Math.abs(k.ux * t[1] - k.uy * t[0]) > 0.105) return;
                const dx = k.cx - A[0], dy = k.cy - A[1], n = -dx * t[1] + dy * t[0]; if (Math.abs(n) > k.hd + reach) return;
                const uc = dx * t[0] + dy * t[1], u0 = Math.max(ua, uc - k.ju), u1 = Math.min(ub, uc + k.ju);
                if (u1 - u0 >= 0.04 && k.z1 - k.z0 >= 0.1) out.push({ u0, u1, z0: k.z0, z1: k.z1, type: k.type, face: k.face });
            });
            return out;
        };
        // a straight wall from A along t, n = across it (towards nin), u = along it. faces: [[n, side texture, +1 looks towards nin / -1 away]]
        function slantWall(A, t, ops, ua, ub, n0, n1, faces, ctype, caps, portalsToo) {
            const nin = [-t[1], t[0]], Q = (u, n, z) => [A[0] + t[0] * u + nin[0] * n, A[1] + t[1] * u + nin[1] * n, z], yaw = Math.atan2(t[1], t[0]);
            const face = (n, tex, sd, u0, u1, z0, z1) => { if (sd > 0) emitQuad('wall', 'int', tex, false, Q(u1, n, z0), Q(u0, n, z0), Q(u0, n, z1), Q(u1, n, z1)); else emitQuad('wall', 'int', tex, false, Q(u0, n, z0), Q(u1, n, z0), Q(u1, n, z1), Q(u0, n, z1)); };
            const jamb = (u, sd, z0, z1) => { if (sd > 0) emitQuad('wall', 'int', D.trim, false, Q(u, n0, z0), Q(u, n1, z0), Q(u, n1, z1), Q(u, n0, z1)); else emitQuad('wall', 'int', D.trim, false, Q(u, n0, z0), Q(u, n0, z1), Q(u, n1, z1), Q(u, n1, z0)); };
            const flat = (z, sd, u0, u1) => { if (sd > 0) emitQuad('wall', 'int', D.trim, false, Q(u0, n0, z), Q(u1, n0, z), Q(u1, n1, z), Q(u0, n1, z)); else emitQuad('wall', 'int', D.trim, false, Q(u0, n0, z), Q(u0, n1, z), Q(u1, n1, z), Q(u1, n0, z)); };
            const piece = (u0, u1, z0, z1) => {
                if (u1 - u0 < 1e-4 || z1 - z0 < 1e-4) return;
                if (!skin) faces.forEach(f => face(f[0], f[1], f[2], u0, u1, z0, z1));
                const um = (u0 + u1) / 2, nm = (n0 + n1) / 2, c = Q(um, nm, 0);
                cboxO(c[0], c[1], z0, z1, (u1 - u0) / 2 + 0.01, Math.max(0.025, (n1 - n0) / 2), yaw, ctype, 0);
            };
            if (caps && !skin) { jamb(ua, -1, 0, H); jamb(ub, 1, 0, H); }
            let cur = ua;
            ops.sort((a, b) => a.u0 - b.u0).forEach(op => {
                if (op.u0 < cur - 1e-6) return;
                piece(cur, op.u0, 0, H);
                if (op.type !== 'gap') {
                    piece(op.u0, op.u1, op.z1, H); if (op.z0 > 1e-4) piece(op.u0, op.u1, 0, op.z0);
                    if (!skin && (!op.face || T > 0.0005 || caps)) { jamb(op.u0, 1, op.z0, op.z1); jamb(op.u1, -1, op.z0, op.z1); flat(op.z1, -1, op.u0, op.u1); if (op.z0 > 1e-4) flat(op.z0, 1, op.u0, op.u1); }
                    if (exportMode && portalsToo) {
                        const spec = OPEN[op.type] || OPEN.window, wm = (n0 + n1) / 2;
                        portals.push({ flags: spec.portal, corners: [].concat(Q(op.u0, wm, op.z0), Q(op.u1, wm, op.z0), Q(op.u1, wm, op.z1), Q(op.u0, wm, op.z1)) });         // (its normal looks out of the room)
                    }
                }
                cur = op.u1;
            });
            piece(cur, ub, 0, H);
        }
        polys.forEach((pg, pi) => {
            const p = pg.pts, ftex = pg.tex || D.floor, wtex = pg.wtex || D.wallInt, ft = TEX.colType(ftex);
            triangulate(p).forEach(tr => {
                const a = p[tr[0]], b = p[tr[1]], c = p[tr[2]];
                emitTri('floor', 'int', ftex, [a[0], a[1], 0], [b[0], b[1], 0], [c[0], c[1], 0]);
                emitTri('roof', 'int', D.ceiling, [a[0], a[1], H], [c[0], c[1], H], [b[0], b[1], H]);
                cprism([a, b, c], -0.35, 0, ft, 1); cprism([a, b, c], H, H + 0.1, 101, 0);
            });
            const inner = T > 0.0005 ? inset(p, T) : p, n = p.length;
            const E = p.map((A, i) => {
                const B = p[(i + 1) % n], L = Math.hypot(B[0] - A[0], B[1] - A[1]), t = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
                // where another room lies behind this wall, the rooms are one: no wall there
                return { A, L, t, behind: (u) => { const uu = Math.min(L - 0.02, Math.max(0.02, u)), x = A[0] + t[0] * uu + t[1] * 0.08, y = A[1] + t[1] * uu - t[0] * 0.08; return inGrid(x, y) || inPolyAny(x, y, pi); } };
            });
            E.forEach((e, i) => {
                const j = (i + 1) % n, A = e.A, L = e.L, t = e.t, behind = e.behind; if (L < 0.02) return;
                const along = (P) => (P[0] - A[0]) * t[0] + (P[1] - A[1]) * t[1], pe = E[(i + n - 1) % n], ne = E[j];
                // next to an open corner (the wall before or after is open there) the face runs on past the corner, to meet the other room's wall
                const ua = pe.behind(pe.L - 0.03) ? -T : along(inner[i]), ub = ne.behind(0.03) ? L + T : along(inner[j]);
                const ops = lineOps(A, t, ua, ub, Math.max(T, outD) + 0.03).concat(runs(ua, ub, behind).map(r => ({ u0: r[0], u1: r[1], z0: 0, z1: H, type: 'gap' })));
                slantWall(A, t, ops, ua, ub, Math.min(-outD, T - 0.05), T, [[T, wtex, 1]], TEX.colType(wtex), false, true);
            });
        });
        (S.aparts || []).forEach(pt => {
            const A = pt.a, B = pt.b, L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (!A || !B || L < 0.2) return;
            const t = [(B[0] - A[0]) / L, (B[1] - A[1]) / L], tex = pt.texA || D.wallInt, texB = pt.texB || D.wallInt;
            const ops = lineOps(A, t, 0, L, PT / 2 + 0.03).concat((pt.open || []).map(o => ({ u0: Math.max(0, o.u0), u1: Math.min(L, o.u1), z0: o.z0, z1: o.z1, type: o.type || 'door' })));
            slantWall(A, t, ops, 0, L, -PT / 2, PT / 2, [[PT / 2, texB, 1], [-PT / 2, tex, -1]], TEX.colType(tex), true, false);
        });

        // ---------------- openings cut out of the model's faces: glass in windows, a frame around windows and doors ----------------
        // An oriented box of a frame: u = ua..ub across the opening (from its centre), z = za..zb, bd deep, centred dn along the outward normal.
        const frameBar = (k, dn, bd, ua, ub, za, zb) => {
            const ux = Math.cos(k.yaw), uy = Math.sin(k.yaw), nx = -uy, ny = ux, uc = (ua + ub) / 2, hu = (ub - ua) / 2, hn = bd / 2, cx0 = k.cx + uc * ux + dn * nx, cy0 = k.cy + uc * uy + dn * ny;
            if (hu < 1e-4 || zb - za < 1e-4) return;
            const P = (su, sn2, z) => [cx0 + su * hu * ux + sn2 * hn * nx, cy0 + su * hu * uy + sn2 * hn * ny, z], T = D.trim;
            emitQuad('wall', 'int', T, false, P(1, -1, za), P(1, 1, za), P(1, 1, zb), P(1, -1, zb));      // +u
            emitQuad('wall', 'int', T, false, P(-1, 1, za), P(-1, -1, za), P(-1, -1, zb), P(-1, 1, zb));  // -u
            emitQuad('wall', 'int', T, false, P(1, 1, za), P(-1, 1, za), P(-1, 1, zb), P(1, 1, zb));      // outside
            emitQuad('wall', 'int', T, false, P(-1, -1, za), P(1, -1, za), P(1, -1, zb), P(-1, -1, zb));  // inside
            emitQuad('wall', 'int', T, false, P(-1, -1, zb), P(1, -1, zb), P(1, 1, zb), P(-1, 1, zb));    // top
            emitQuad('wall', 'int', T, false, P(-1, -1, za), P(-1, 1, za), P(1, 1, za), P(1, -1, za));    // bottom
        };
        // collision of a box like that (turned like the opening, at any angle)
        const frameCol = (k, dn, bd, ua, ub, za, zb, type) => {
            const ux = Math.cos(k.yaw), uy = Math.sin(k.yaw), uc = (ua + ub) / 2;
            cboxO(k.cx + uc * ux - dn * uy, k.cy + uc * uy + dn * ux, za, zb, Math.abs(ub - ua) / 2, bd / 2, k.yaw, type, 0);
        };
        (((project.import && project.import.cutters) || []).concat(fitCut)).forEach(k => {
            if (!k.face) return;
            // a placed model brings its own frame, glass and door; the pane of a window still stops you (collision across the opening)
            if (k.fit) { if (k.type === 'window' && !k.noglass) frameCol(k, 0, 0.03, -k.w / 2, k.w / 2, k.zb, k.zb + k.h, 112); return; }
            const cs = Math.cos(k.yaw), sn = Math.sin(k.yaw), dd = M.ImportModel.depthOf(k), hw = k.w / 2, zt = k.zb + k.h;
            // Gaps in the model's wall beside the cut-out (see-through slits the cut-out faces used to cover) are closed with trim boxes that reach the wall.
            const IMg = M.ImportModel; let gp = k.fill !== false && (k.type === 'window' || k.type === 'door') && IMg && IMg.gapAround ? IMg.gapAround(k) : null;
            // the model's wall is cut out to a door's frame when that is bigger than the opening, so that much of a gap is gone (the frame covers the rest)
            const fex = IMg && IMg.doorFrameExtent ? IMg.doorFrameExtent(k) : null;
            if (gp && fex) { const ex = Math.max(0, fex.cu - fex.hw), et = Math.max(0, fex.ct - fex.zt); gp = { l: Math.max(0, gp.l - ex), r: Math.max(0, gp.r - ex), b: gp.b, t: Math.max(0, gp.t - et), dw: gp.dw }; if (!gp.l && !gp.r && !gp.b && !gp.t) gp = null; }
            if (gp) {
                const lo = Math.min(dd - 0.035, gp.dw - 0.02), hi = Math.max(dd + 0.035, gp.dw + 0.02), dnc = (lo + hi) / 2, bdf = hi - lo, z0 = k.zb - gp.b, z1 = zt + gp.t;
                if (gp.l) frameBar(k, dnc, bdf, -hw - gp.l, -hw, z0, z1);
                if (gp.r) frameBar(k, dnc, bdf, hw, hw + gp.r, z0, z1);
                if (gp.b) frameBar(k, dnc, bdf, -hw, hw, z0, k.zb);
                if (gp.t) frameBar(k, dnc, bdf, -hw, hw, zt, z1);
            }
            if (k.type === 'window') {
                // The model's window is one painted picture (frame, bars and glass together) on a single face, so cutting it out takes the frame away too.
                // A plain frame is put back inside the opening, at the depth of the frame: bars all round, and a cross when asked for.
                // (k.vframe: the model's own frame is used: nothing is built, the glass goes behind what the model has left around the opening)
                const framed = k.frame !== false && !k.vframe, bw = k.bw || 0.055, bd = 0.07;
                if (framed) {
                    frameBar(k, dd, bd, -hw, hw, zt - bw, zt); frameBar(k, dd, bd, -hw, hw, k.zb, k.zb + bw);                                  // head and sill
                    frameBar(k, dd, bd, -hw, -hw + bw, k.zb + bw, zt - bw); frameBar(k, dd, bd, hw - bw, hw, k.zb + bw, zt - bw);                // the two sides
                    if (k.bars) {
                        if (k.w > 0.9) frameBar(k, dd, bd, -bw / 2, bw / 2, k.zb + bw, zt - bw);
                        if (k.h > 1.3) { const zm = (k.zb + zt) / 2; frameBar(k, dd, bd, -hw + bw, -bw / 2, zm - bw / 2, zm + bw / 2); frameBar(k, dd, bd, bw / 2, hw - bw, zm - bw / 2, zm + bw / 2); }
                    }
                }
                // The pane sits at the depth of the window's own frame (dd, behind the faces that were cut out) and is only as large as the frame's inner
                // opening plus 1 cm that is tucked into the bars; without a frame it is the opening plus 1 cm into the wall.
                const ov = 0.01, gu = framed ? Math.max(0.02, hw - bw + ov) : hw + ov, gz0 = framed ? k.zb + bw - ov : k.zb - ov, gz1 = framed ? zt - bw + ov : zt + ov;
                const Pt = (du, z, dn) => [k.cx + du * cs - (dn + dd) * sn, k.cy + du * sn + (dn + dd) * cs, z];
                emitQuad('glass', 'glass', 'glass', true, Pt(-gu, gz0, 0.003), Pt(-gu, gz1, 0.003), Pt(gu, gz1, 0.003), Pt(gu, gz0, 0.003));
                emitQuad('glass', 'glass', 'glass', true, Pt(-gu, gz0, -0.003), Pt(gu, gz0, -0.003), Pt(gu, gz1, -0.003), Pt(-gu, gz1, -0.003));
                frameCol(k, dd, 0.03, -hw, hw, k.zb, zt, 112);                                                                              // collision for the pane
            } else if (k.type === 'door' && k.leaf && k.frame !== false && !k.vframe) {
                // The door model keeps its own size (the game ignores the scale of an entity), so its frame is built to the door: the jambs and the head
                // run from the edges of the door out to the edges of the opening (at least bw wide, the rest is inside the wall) and close the gap.
                const IMod = M.ImportModel, dg = IMod && IMod.doorGroup ? IMod.doorGroup(k) : null; if (!dg) return;
                const bw = k.bw || 0.05, bd = 0.1, dn = dd + (k.lo || 0), dw = dg.w / 2, ju = Math.max(hw, dw + bw), dt = k.zb + dg.h, top = Math.max(zt, dt + bw), ct = TEX.colType(D.trim);
                [[-ju, -dw, k.zb, top], [dw, ju, k.zb, top], [-dw, dw, dt, top]].forEach(b => { frameBar(k, dn, bd, b[0], b[1], b[2], b[3]); frameCol(k, dn, bd, b[0], b[1], b[2], b[3], ct); });
            }
        });

        // ---------------- collision boxes the user built (Collision box tool): they only make collision, nothing is drawn ----------------
        // (a box whose centre is inside the interior belongs to its room, like the floor)
        ((project.import && project.import.cboxes) || []).forEach(k => {
            const m = COLMAT[k.mat] || COLMAT.concrete;
            cboxO(k.cx, k.cy, k.zb, k.zb + k.h, k.w / 2, k.d / 2, k.yaw || 0, m.type, inRegion(k.cx, k.cy) ? 1 : 0, k.id);
        });

        // ---------------- doors of the Window / door models tool that are made solid: a box of collision the size of the leaf ----------------
        (M.FitModels ? M.FitModels.solidBoxes(project) : []).forEach(b => cboxO(b.cx, b.cy, b.zb, b.zb + b.h, b.hu, b.hn, b.yaw, COLMAT.wood.type, inRegion(b.cx, b.cy) ? 1 : 0, b.id));          // (a doorway sits in the wall: its room is the walls' room unless its middle is inside)

        // ---------------- lights: one per ~3.5 m of every room (rooms are cut apart by partitions, doors and arches stay open) ----------------
        if (exportMode && opts.autoLights !== false) {
            const LSP = ATM.on && (S.atmos.lights || 'warm') !== 'warm' ? 4.5 : 3.5;          // (a warehouse: lights further apart)
            const px = [], py = [];
            (S.parts || []).forEach(pt => { if (pt.o === 'H') { py.push(pt.c); px.push(pt.u0, pt.u1); } else { px.push(pt.c); py.push(pt.u0, pt.u1); } });
            const g2 = regionGrid(S, px, py), comp = [], blockedH = (i, j) => false;
            for (let i = 0; i < g2.nx; i++) comp.push(new Array(g2.ny).fill(-1));
            const blockedBetween = (i, j, i2, j2) => {
                // moving from cell (i,j) to (i2,j2): crosses a partition line?
                const vertical = i2 !== i, line = vertical ? g2.X[Math.max(i, i2)] : g2.Y[Math.max(j, j2)];
                const mid = vertical ? (g2.Y[j] + g2.Y[j + 1]) / 2 : (g2.X[i] + g2.X[i + 1]) / 2;
                return (S.parts || []).some(pt => {
                    if (vertical ? pt.o !== 'V' : pt.o !== 'H') return false;
                    if (Math.abs(pt.c - line) > PT / 2 + 0.02 || mid < pt.u0 || mid > pt.u1) return false;
                    return !(pt.open || []).some(op => mid > op.u0 && mid < op.u1);
                });
            };
            let nid = 0;
            for (let i = 0; i < g2.nx; i++) for (let j = 0; j < g2.ny; j++) {
                if (!g2.mask[i][j] || comp[i][j] >= 0) continue; const id = nid++, st = [[i, j]]; comp[i][j] = id;
                while (st.length) {
                    const [ci, cj] = st.pop();
                    [[ci + 1, cj], [ci - 1, cj], [ci, cj + 1], [ci, cj - 1]].forEach(n => {
                        if (n[0] < 0 || n[1] < 0 || n[0] >= g2.nx || n[1] >= g2.ny || !g2.mask[n[0]][n[1]] || comp[n[0]][n[1]] >= 0 || blockedBetween(ci, cj, n[0], n[1])) return;
                        comp[n[0]][n[1]] = id; st.push([n[0], n[1]]);
                    });
                }
            }
            const byId = new Map();
            for (let i = 0; i < g2.nx; i++) for (let j = 0; j < g2.ny; j++) if (comp[i][j] >= 0) { if (!byId.has(comp[i][j])) byId.set(comp[i][j], []); byId.get(comp[i][j]).push([i, j]); }
            byId.forEach(cs => {
                let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, area = 0;
                cs.forEach(c => { x0 = Math.min(x0, g2.X[c[0]]); x1 = Math.max(x1, g2.X[c[0] + 1]); y0 = Math.min(y0, g2.Y[c[1]]); y1 = Math.max(y1, g2.Y[c[1] + 1]); area += (g2.X[c[0] + 1] - g2.X[c[0]]) * (g2.Y[c[1] + 1] - g2.Y[c[1]]); });
                if (area < 1.0) return;
                const nx = Math.max(1, Math.round((x1 - x0) / LSP)), ny = Math.max(1, Math.round((y1 - y0) / LSP)), seen = new Set();
                for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) {
                    const cx = x0 + (a + 0.5) * (x1 - x0) / nx, cy = y0 + (b + 0.5) * (y1 - y0) / ny;
                    // the grid point itself when it lies in the room, else the middle of the nearest piece of the room (an L-shaped room)
                    if (cs.some(c => cx >= g2.X[c[0]] && cx < g2.X[c[0] + 1] && cy >= g2.Y[c[1]] && cy < g2.Y[c[1] + 1])) { lights.push({ x: cx, y: cy, z: H - 0.15 }); continue; }
                    let best = null, bd = 1e9;
                    cs.forEach(c => { const mx = (g2.X[c[0]] + g2.X[c[0] + 1]) / 2, my = (g2.Y[c[1]] + g2.Y[c[1] + 1]) / 2, d = Math.hypot(mx - cx, my - cy); if (d < bd) { bd = d; best = [mx, my]; } });
                    const lk = best[0].toFixed(2) + ',' + best[1].toFixed(2); if (seen.has(lk)) continue; seen.add(lk);
                    lights.push({ x: best[0], y: best[1], z: H - 0.15 });
                }
            });
            // angled rooms: one per ~3.5 m on a grid square to their longest wall
            polys.forEach(pg => {
                const p = pg.pts; let la = 0, ang = 0; p.forEach((a, i) => { const b = p[(i + 1) % p.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > la) { la = l; ang = Math.atan2(b[1] - a[1], b[0] - a[0]); } });
                const c = Math.cos(ang), s = Math.sin(ang), loc = p.map(q => [q[0] * c + q[1] * s, -q[0] * s + q[1] * c]); let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
                loc.forEach(q => { u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1]); });
                const nu = Math.max(1, Math.round((u1 - u0) / LSP)), nv = Math.max(1, Math.round((v1 - v0) / LSP)); let n = 0;
                for (let a = 0; a < nu; a++) for (let b = 0; b < nv; b++) { const u = u0 + (a + 0.5) * (u1 - u0) / nu, v = v0 + (b + 0.5) * (v1 - v0) / nv, x = u * c - v * s, y = u * s + v * c; if (inPoly(p, x, y)) { lights.push({ x, y, z: H - 0.15 }); n++; } }
                if (!n) { const tr = triangulate(p)[0]; if (tr) lights.push({ x: (p[tr[0]][0] + p[tr[1]][0] + p[tr[2]][0]) / 3, y: (p[tr[0]][1] + p[tr[1]][1] + p[tr[2]][1]) / 3, z: H - 0.15 }); }
            });
        }
        if (exportMode) (S.lights || []).forEach(l => lights.push({ x: l.x, y: l.y, z: H - 0.15 }));

        batches.forEach(b => { b.pos = new Float32Array(b.pos); b.nrm = new Float32Array(b.nrm); b.uv = new Float32Array(b.uv); b.idx = new Uint16Array(b.idx); });
        stats.boxes = boxes.length; stats.portals = portals.length; stats.lights = lights.length;
        const resolved = []; segs.forEach(sg => sg.ops.forEach(op => resolved.push({ o: sg.o, c: sg.c, inward: sg.inward, u0: op.u0, u1: op.u1, z0: op.z0, z1: op.z1, type: op.type, entrance: op.entrance })));
        // ---------------- the floor: raised, lowered, sloped by the height points, with potholes ----------------
        if (FL.base !== 0 || FL.pts.length || (ATM.on && ATM.potholes > 0.01)) {
            const old = batches.filter(m => m.kind === 'floor' && m.group === 'int'), tris = [];
            old.forEach(m => { for (let i = 0; i < m.idx.length; i += 3) { const P = (k) => [m.pos[m.idx[i + k] * 3], m.pos[m.idx[i + k] * 3 + 1]]; tris.push({ tex: m.tex, p: [P(0), P(1), P(2)] }); } stats.tris -= m.idx.length / 3; });
            for (let i = batches.length - 1; i >= 0; i--) if (old.indexOf(batches[i]) >= 0) batches.splice(i, 1);
            acc.forEach((m, k) => { if (old.indexOf(m) >= 0) acc.delete(k); });
            // potholes: each sits in its own 0.5 m square of the floor (or a block of 2 x 2), well inside the rooms
            const SC = 0.5, pots = new Map();
            if (ATM.on && ATM.potholes > 0.01 && tris.length) {
                const r = rng(ATM.seed * 104729 + 17), areas = tris.map(t => Math.abs((t.p[1][0] - t.p[0][0]) * (t.p[2][1] - t.p[0][1]) - (t.p[2][0] - t.p[0][0]) * (t.p[1][1] - t.p[0][1])) / 2), total = areas.reduce((a, b) => a + b, 0);
                const n = Math.round(total * ATM.potholes * 0.08), free = (i, j) => !pots.has(i + ',' + j) && [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]].every(o => inRegion((i + o[0]) * SC, (j + o[1]) * SC));
                for (let k = 0, made = 0; k < n * 6 && made < n; k++) {
                    let pick = r() * total, ti = 0; while (ti < areas.length - 1 && pick > areas[ti]) { pick -= areas[ti]; ti++; }
                    const t = tris[ti].p; let a = r(), b = r(); if (a + b > 1) { a = 1 - a; b = 1 - b; }
                    const x = t[0][0] + (t[1][0] - t[0][0]) * a + (t[2][0] - t[0][0]) * b, y = t[0][1] + (t[1][1] - t[0][1]) * a + (t[2][1] - t[0][1]) * b;
                    const big = r() < 0.25, i = Math.floor(x / SC), j = Math.floor(y / SC);
                    const cells = big ? [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]] : [[i, j]];
                    if (!cells.every(c => free(c[0], c[1]))) continue;
                    const half = big ? SC : SC / 2, rad = big ? 0.2 + r() * 0.12 : 0.08 + r() * 0.08, room = half - rad * 1.42 - 0.01;
                    const P = { cx: (big ? (i + 1) * SC : (i + 0.5) * SC) + (r() * 2 - 1) * room, cy: (big ? (j + 1) * SC : (j + 0.5) * SC) + (r() * 2 - 1) * room, rad, depth: (big ? 0.045 : 0.025) + r() * 0.04, p1: r() * 6.28, p2: r() * 6.28, p3: r() * 6.28 };
                    cells.forEach(c => pots.set(c[0] + ',' + c[1], P)); made++;
                }
            }
            // every floor triangle cut into the 0.5 m squares (finer in a pothole's square); the cut points of an edge are the same for the triangles on
            // both sides of it, so the floor stays closed when it bends. In a pothole square the points on its edges follow the square's straight edge.
            const hAt = (x, y) => heightAt(FL, x, y), hc = new Map(), hCorner = (i, j) => { const k = i + ',' + j; let v = hc.get(k); if (v === undefined) { v = hAt(i * SC, j * SC); hc.set(k, v); } return v; };
            tris.forEach(t => {
                const xs = t.p.map(q => q[0]), ys = t.p.map(q => q[1]);
                for (let i = Math.floor(Math.min(...xs) / SC - 1e-9); i * SC < Math.max(...xs) - 1e-9; i++) for (let j = Math.floor(Math.min(...ys) / SC - 1e-9); j * SC < Math.max(...ys) - 1e-9; j++) {
                    const piece = clipRect(t.p, i * SC, j * SC, (i + 1) * SC, (j + 1) * SC); if (!piece) continue;
                    const P = pots.get(i + ',' + j);
                    const fan = (poly, zf) => { for (let k = 1; k + 1 < poly.length; k++) { const q = [poly[0], poly[k], poly[k + 1]]; emitRaw('floor', 'int', t.tex, q.map(v => [v[0], v[1], zf(v[0], v[1])]), q.map(v => [v[0], v[1], 0])); } };
                    if (!P) { fan(piece, hAt); continue; }
                    const x0 = i * SC, y0 = j * SC, x1 = x0 + SC, y1 = y0 + SC, NF = 7, f = SC / NF;
                    const zf = (x, y) => {
                        const ex = Math.abs(x - x0) < 1e-7 || Math.abs(x - x1) < 1e-7, ey = Math.abs(y - y0) < 1e-7 || Math.abs(y - y1) < 1e-7;
                        if (ex || ey) {                                                                                   // on the square's edge: straight between its corners
                            const ci = Math.abs(x - x1) < 1e-7 ? i + 1 : i, cj = Math.abs(y - y1) < 1e-7 ? j + 1 : j;
                            if (ex && ey) return hCorner(ci, cj);
                            if (ex) { const t2 = (y - y0) / SC; return hCorner(ci, j) * (1 - t2) + hCorner(ci, j + 1) * t2; }
                            const t2 = (x - x0) / SC; return hCorner(i, cj) * (1 - t2) + hCorner(i + 1, cj) * t2;
                        }
                        return hAt(x, y) - potDepth(P, x, y);
                    };
                    for (let a = 0; a < NF; a++) for (let b = 0; b < NF; b++) { const q = clipRect(piece, x0 + a * f, y0 + b * f, x0 + (a + 1) * f, y0 + (b + 1) * f); if (q) fan(q, zf); }
                }
            });
            // collision of the floor: the old flat boxes go; the floor as prisms 1 m across that follow its heights (not into the potholes), or the
            // boxes moved up or down when the floor is only raised or lowered
            if (wantBoxes) {
                const isFloor = (b) => b[2] === -0.35 && b[5] === 0, kept = boxes.filter(b => !isFloor(b)), flat = boxes.filter(isFloor);
                boxes.length = 0; kept.forEach(b => boxes.push(b));
                if (!FL.pts.length) flat.forEach(b => { const c = b.slice(); c[2] += FL.base; c[5] += FL.base; boxes.push(c); });
                else tris.forEach(t => {
                    const xs = t.p.map(q => q[0]), ys = t.p.map(q => q[1]), C = 1.0;
                    for (let i = Math.floor(Math.min(...xs) / C - 1e-9); i * C < Math.max(...xs) - 1e-9; i++) for (let j = Math.floor(Math.min(...ys) / C - 1e-9); j * C < Math.max(...ys) - 1e-9; j++) {
                        const q = clipRect(t.p, i * C, j * C, (i + 1) * C, (j + 1) * C); if (!q) continue;
                        for (let k = 1; k + 1 < q.length; k++) { const tri = [q[0], q[k], q[k + 1]], zt = tri.map(v => hAt(v[0], v[1])); cprism(tri, Math.min(...zt) - 0.35, 0, TEX.colType(t.tex), 1, zt); }
                    }
                });
            }
        }

        return { batches, boxes, matList, portals, lights, entrance: null, bounds: { mn: bmn, mx: bmx }, stats, shell: { grid: g, segs, resolved } };
    }

    // the final region as a few rectangles (used to tell the patcher where the walkable interior is)
    // (with the angled rooms as thin square-to-the-grid strips, for what only understands rectangles)
    function regionRects(shell) {
        const out = gridRects(shell);
        polysOf(shell).forEach(pg => stripBoxes(pg.pts, 0, 0.1).forEach(b => out.push([b.cx - b.w / 2, b.cy - b.d / 2, b.cx + b.w / 2, b.cy + b.d / 2])));
        return out;
    }
    const hasRooms = (shell) => !!shell && ((shell.ops || []).some(o => o.op === 'add') || polysOf(shell).length > 0);
    function gridRects(shell) {
        const g = regionGrid(shell), used = [], out = [];
        for (let i = 0; i < g.nx; i++) used.push(new Array(g.ny).fill(false));
        for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
            if (!g.mask[i][j] || used[i][j]) continue;
            let i1 = i + 1; while (i1 < g.nx && g.mask[i1][j] && !used[i1][j]) i1++;
            let j1 = j + 1; for (; j1 < g.ny; j1++) { let ok = true; for (let x = i; x < i1; x++) if (!g.mask[x][j1] || used[x][j1]) { ok = false; break; } if (!ok) break; }
            for (let x = i; x < i1; x++) for (let y = j; y < j1; y++) used[x][y] = true;
            out.push([g.X[i], g.Y[j], g.X[i1], g.Y[j1]]);
        }
        return out;
    }

    M.Shell = { build, heightAt: (shell, x, y) => heightAt(floorCfg(shell), x, y), floorCfg, atmosCfg, regionGrid, regionRects, gridRects, roomBoxes, polyBoxes, stripBoxes, polysOf, cleanPoly, inPoly, inset, triangulate, hasRooms, boundary, OPEN, uniq };
})(window.MLO);

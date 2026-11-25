// Procedural, tileable, flat/muted materials. The same pixels feed the 3D preview and the exported .ytd.
window.MLO = window.MLO || {};
(function (M) {
    'use strict';
    const SIZE = 256;

    function hash(x, y, s) {
        let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
        return ((h >>> 0) & 0xFFFFFF) / 0x1000000;
    }
    function vnoise(x, y, per, seed) {
        const xi = Math.floor(x), yi = Math.floor(y); let fx = x - xi, fy = y - yi;
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
        const x0 = ((xi % per) + per) % per, x1 = (x0 + 1) % per, y0 = ((yi % per) + per) % per, y1 = (y0 + 1) % per;
        const a = hash(x0, y0, seed), b = hash(x1, y0, seed), c = hash(x0, y1, seed), d = hash(x1, y1, seed);
        return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }
    // value noise that repeats every px across and py down (streaks: many across, few down)
    function vn2(x, y, px, py, seed) {
        const xi = Math.floor(x), yi = Math.floor(y); let fx = x - xi, fy = y - yi;
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
        const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px, y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
        const a = hash(x0, y0, seed), b = hash(x1, y0, seed), c = hash(x0, y1, seed), d = hash(x1, y1, seed);
        return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }
    // cells (Worley), repeating every n: distance to the nearest and second nearest point; their difference is small along the cracks between cells
    function worley(u, v, n, seed) {
        const x = u * n, y = v * n, xi = Math.floor(x), yi = Math.floor(y); let f1 = 9, f2 = 9;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const cx = xi + dx, cy = yi + dy, wx = ((cx % n) + n) % n, wy = ((cy % n) + n) % n, d = Math.hypot(cx + hash(wx, wy, seed) - x, cy + hash(wx, wy, seed + 1) - y);
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
        return f2 - f1;
    }
    const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const mix = (c, d, t) => [c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t, c[2] + (d[2] - c[2]) * t];
    // Age on top of a material: w = { dirt, stains, streaks, cracks, eff (salt), rust, oil, chips, seed }, each 0..1
    function weather(u, v, c, w) {
        const s = w.seed || 7;
        if (w.dirt) { const k = 1 - w.dirt * Math.max(0, fbm(u, v, 2, s) - 0.3) * 1.5; c = mix(c, [c[0] * k + 10 * (1 - k), c[1] * k + 7 * (1 - k), c[2] * k], 1); }
        if (w.stains) c = mix(c, [c[0] * 0.5 + 20, c[1] * 0.5 + 14, c[2] * 0.45 + 6], sstep(0.55, 0.72, fbm(u + 0.37, v + 0.11, 3, s + 5)) * w.stains);
        if (w.streaks) { const m = sstep(0.55, 0.85, vn2(u * 28, v * 2, 28, 2, s + 9)) * sstep(0.3, 0.7, fbm(u, v, 2, s + 3)) * w.streaks; c = mix(c, [c[0] * 0.55 + 8, c[1] * 0.55 + 8, c[2] * 0.55 + 6], m); }
        if (w.eff) c = mix(c, [206, 202, 192], sstep(0.62, 0.78, fbm(u, v, 4, s + 17)) * w.eff * 0.7);
        if (w.rust) { const m = sstep(0.52, 0.75, fbm(u, v, 3, s + 19) * 0.7 + vn2(u * 20, v * 3, 20, 3, s + 21) * 0.3) * w.rust, g = fbm(u, v, 8, s + 25); c = mix(c, [86 + 40 * g, 48 + 18 * g, 30 + 8 * g], m * 0.85); }
        if (w.oil) c = mix(c, [c[0] * 0.3, c[1] * 0.3, c[2] * 0.32], sstep(0.64, 0.7, fbm(u + 0.5, v + 0.2, 2, s + 23)) * w.oil);
        if (w.chips) { const m = sstep(0.8, 0.86, vnoise(u * 40, v * 40, 40, s + 29)) * w.chips; c = mix(c, [c[0] * 0.6, c[1] * 0.58, c[2] * 0.56], m * 0.7); }
        if (w.cracks) {
            // the crack lines wander (the position is pushed around by noise) and only show where a second noise lets them: broken, not a net
            const wu = u + (fbm(u, v, 4, s + 31) - 0.5) * 0.08, wv = v + (fbm(u, v, 4, s + 33) - 0.5) * 0.08, e = worley(((wu % 1) + 1) % 1, ((wv % 1) + 1) % 1, 4, s + 11);
            const m = sstep(1 - w.cracks * 0.55, 1.05 - w.cracks * 0.55, fbm(u, v, 3, s + 13)), k = sstep(0.03, 0.006, e) * m; c = mix(c, [c[0] * 0.3, c[1] * 0.3, c[2] * 0.3], k);
        }
        return c;
    }

    function fbm(u, v, cells, seed) {
        let s = 0, amp = 0.5, tot = 0, per = cells;
        for (let o = 0; o < 4; o++) { s += amp * vnoise(u * per, v * per, per, seed + o * 17); tot += amp; amp *= 0.5; per *= 2; }
        return s / tot;
    }

    // ---------- pattern functions: (u, v in 0..1) -> [r,g,b] ----------
    const K = {
        flat(u, v, p) {
            const n = fbm(u, v, 3, p.seed || 5), g = vnoise(u * SIZE / 2, v * SIZE / 2, SIZE / 2, (p.seed || 5) + 3);
            let k = 1 + (n - 0.5) * (p.amp != null ? p.amp : 0.05) + (g - 0.5) * (p.grain != null ? p.grain : 0.03);
            if (p.pits && hash(Math.floor(u * SIZE), Math.floor(v * SIZE), 91) < p.pits) k *= 0.8;
            return [p.base[0] * k, p.base[1] * k, p.base[2] * k];
        },
        carpet(u, v, p) {
            const g = vnoise(u * SIZE, v * SIZE, SIZE, 17), g2 = vnoise(u * SIZE / 3, v * SIZE / 3, SIZE / 3, 21), n = fbm(u, v, 4, 33);
            const k = 1 + (g - 0.5) * 0.16 + (g2 - 0.5) * 0.06 + (n - 0.5) * 0.06;
            return [p.base[0] * k, p.base[1] * k, p.base[2] * k];
        },
        brick(u, v, p) {
            const ry = v * p.rows, r = Math.floor(ry), fv = ry - r;
            const off = p.shuffle ? hash(r, 3, 17) : (r % 2) * (p.shift != null ? p.shift : 0.5);
            const cx = u * p.cols + off, c = Math.floor(cx), fu = cx - c;
            const cw = ((c % p.cols) + p.cols) % p.cols, rw = ((r % p.rows) + p.rows) % p.rows;
            const bw = SIZE / p.cols, bh = SIZE / p.rows, mw = (p.mw || 2) * 0.5;
            const du = Math.min(fu, 1 - fu) * bw, dv = Math.min(fv, 1 - fv) * bh;
            const g = vnoise(u * SIZE / 2, v * SIZE / 2, SIZE / 2, 7);
            if (du < mw || dv < mw) { const k = 1 + (g - 0.5) * 0.08; return [p.mortar[0] * k, p.mortar[1] * k, p.mortar[2] * k]; }
            const vary = p.vary != null ? p.vary : 0.12;
            let k = 1 + (hash(cw, rw, 41) - 0.5) * 2 * vary + (fbm(u, v, 4, 13) - 0.5) * 0.10 + (g - 0.5) * 0.06;
            if (du < mw + 1.2 || dv < mw + 1.2) k *= 0.93;
            return [p.base[0] * k, p.base[1] * k, p.base[2] * k];
        },
        plank(u, v, p) {
            const n = p.n || 6, pu = u * n, pi = Math.floor(pu), fu = pu - pi;
            const segs = p.segs || 2, seg = v * segs + hash(pi, 0, 41) * segs, sj = Math.floor(seg), fv = seg - sj;
            const sid = ((sj % segs) + segs) % segs;
            const tone = 0.90 + hash(pi, sid, 43) * 0.20;
            const grain = vnoise(u * 14, v * 14, 14, 7 + pi), streak = vnoise(u * 30, v * 30, 30, 61 + pi);
            let k = tone * (0.95 + (grain - 0.5) * 0.10 + (streak - 0.5) * 0.06);
            if (fu < 0.03 || fu > 0.97 || fv < 0.012 || fv > 0.988) k *= 0.66;
            return [p.base[0] * k, p.base[1] * k, p.base[2] * k];
        },
        tile(u, v, p) {
            const n = p.n || 4, tu = u * n, tv = v * n, ti = Math.floor(tu), tj = Math.floor(tv), fu = tu - ti, fv = tv - tj;
            const edge = (p.grout || 3) / (SIZE / n) * 0.5;
            const g = vnoise(u * SIZE / 3, v * SIZE / 3, SIZE / 3, 13);
            const colr = p.b && ((ti + tj) & 1) ? p.b : p.base;
            const vari = 0.97 + hash(ti % n, tj % n, 77) * 0.06;
            const k = vari * (1 + (g - 0.5) * 0.03);
            if (fu < edge || fu > 1 - edge || fv < edge || fv > 1 - edge) return [p.groutCol[0] * k, p.groutCol[1] * k, p.groutCol[2] * k];
            return [colr[0] * k, colr[1] * k, colr[2] * k];
        },
        shingle(u, v, p) {
            const rows = p.rows || 10, rv = v * rows, ri = Math.floor(rv), fv = rv - ri;
            const cols = p.cols || 5, ru = u * cols + (ri % 2) * 0.5, ci = Math.floor(ru), fu = ru - ci;
            const cw = ((ci % cols) + cols) % cols;
            const vari = 0.88 + hash(cw, ri % rows, 91) * 0.24, g = vnoise(u * SIZE / 3, v * SIZE / 3, SIZE / 3, 31);
            let k = vari * (0.95 + (g - 0.5) * 0.10);
            k *= fv < 0.12 ? 0.62 : (fv > 0.9 ? 1.05 : 1.0);
            if (fu < 0.03 || fu > 0.97) k *= 0.7;
            return [p.base[0] * k, p.base[1] * k, p.base[2] * k];
        },
        corrugated(u, v, p) {
            const ribs = p.ribs || 16, s = Math.sin(u * ribs * Math.PI * 2);
            const g = vnoise(u * SIZE / 2, v * SIZE / 2, SIZE / 2, 35), n = fbm(u, v, 3, 37);
            const k = (0.86 + 0.14 * s) * (1 + (g - 0.5) * 0.05 + (n - 0.5) * 0.08);
            return [p.base[0] * k, p.base[1] * k, p.base[2] * k];
        },
        // paint peeling off what is under it (p.under: [kind, params]); its edges curl and darken
        peel(u, v, p) {
            const n = fbm(u, v, 4, p.seed || 71) + (vnoise(u * 32, v * 32, 32, (p.seed || 71) + 1) - 0.5) * 0.12, t = p.peel || 0.5;
            if (n > t + 0.03) return K[p.under[0]](u, v, p.under[1]);
            const paint = K.flat(u, v, p); return n > t ? mix(paint, [paint[0] * 0.6, paint[1] * 0.6, paint[2] * 0.6], 0.9) : paint;
        },
        // broken masonry: a chunk is knocked out, the rough inside shows (the damage in walls)
        rubble(u, v, p) {
            const e = worley(u, v, 9, 41), n = fbm(u, v, 6, 43), g = vnoise(u * SIZE / 2, v * SIZE / 2, SIZE / 2, 45);
            const k = (0.7 + n * 0.5) * (0.92 + (g - 0.5) * 0.25) * (e < 0.06 ? 0.6 : 1);
            const c = mix(p.base, p.b, sstep(0.45, 0.6, fbm(u, v, 3, 47)));
            return [c[0] * k, c[1] * k, c[2] * k];
        },
        panel(u, v, p) {
            const base = K.flat(u, v, p), np = p.n || 2, fu = (u * np) % 1, fv = (v * np) % 1;
            const du = Math.min(fu, 1 - fu) * SIZE / np, dv = Math.min(fv, 1 - fv) * SIZE / np;
            let k = 1;
            if (du < 1.6 || dv < 1.6) k = 0.72;
            // tie holes
            const hx = (fu - 0.12) * SIZE / np, hy = (fv - 0.12) * SIZE / np;
            if (hx * hx + hy * hy < 5) k = 0.65;
            return [base[0] * k, base[1] * k, base[2] * k];
        }
    };

    const C = (r, g, b) => [r, g, b];
    // id, name, category, tile (metres per repeat), kind, params
    const LIST = [
        ['brick_red', 'Red Brick', 'Brick', 0.9, 'brick', { cols: 4, rows: 12, base: C(150, 82, 66), mortar: C(184, 178, 168) }],
        ['brick_brown', 'Brown Brick', 'Brick', 0.9, 'brick', { cols: 4, rows: 12, base: C(116, 82, 62), mortar: C(176, 170, 160) }],
        ['brick_cream', 'Cream Brick', 'Brick', 0.9, 'brick', { cols: 4, rows: 12, base: C(198, 182, 150), mortar: C(196, 192, 184), vary: 0.08 }],
        ['brick_london', 'London Stock', 'Brick', 0.9, 'brick', { cols: 4, rows: 12, base: C(172, 148, 106), mortar: C(190, 184, 172) }],
        ['brick_grey', 'Grey Brick', 'Brick', 0.9, 'brick', { cols: 4, rows: 12, base: C(126, 127, 125), mortar: C(168, 166, 160) }],
        ['brick_charcoal', 'Charcoal Brick', 'Brick', 0.9, 'brick', { cols: 4, rows: 12, base: C(72, 74, 78), mortar: C(138, 136, 130) }],
        ['stone_ash', 'Ashlar Stone', 'Stone', 1.0, 'brick', { cols: 3, rows: 6, base: C(150, 148, 140), mortar: C(112, 110, 104), mw: 3, shuffle: true, vary: 0.10 }],
        ['stone_sand', 'Sandstone', 'Stone', 1.0, 'brick', { cols: 3, rows: 6, base: C(192, 174, 138), mortar: C(150, 136, 108), mw: 3, shuffle: true, vary: 0.09 }],
        ['stone_slate', 'Slate Flags', 'Stone', 1.0, 'brick', { cols: 2, rows: 4, base: C(88, 92, 96), mortar: C(60, 62, 66), mw: 4, shuffle: true, vary: 0.10 }],
        ['concrete', 'Smooth Concrete', 'Concrete', 1.0, 'flat', { base: C(166, 165, 160), amp: 0.10, grain: 0.06, pits: 0.003, seed: 51 }],
        ['concrete_dark', 'Dark Concrete', 'Concrete', 1.0, 'flat', { base: C(112, 112, 110), amp: 0.10, grain: 0.06, pits: 0.003, seed: 53 }],
        ['concrete_panel', 'Concrete Panels', 'Concrete', 1.0, 'panel', { base: C(170, 168, 162), amp: 0.08, grain: 0.05, n: 2, seed: 57 }],
        ['concrete_block', 'Concrete Block', 'Concrete', 1.0, 'brick', { cols: 2, rows: 5, base: C(158, 157, 150), mortar: C(128, 127, 122), mw: 3, vary: 0.05 }],
        ['plaster_white', 'White Plaster', 'Plaster', 1.0, 'flat', { base: C(232, 230, 224), amp: 0.03, grain: 0.015, seed: 3 }],
        ['plaster_cream', 'Cream Plaster', 'Plaster', 1.0, 'flat', { base: C(214, 205, 188), amp: 0.04, grain: 0.02, seed: 11 }],
        ['plaster_grey', 'Light Grey', 'Plaster', 1.0, 'flat', { base: C(190, 190, 188), amp: 0.03, grain: 0.02, seed: 23 }],
        ['plaster_warm', 'Warm Beige', 'Plaster', 1.0, 'flat', { base: C(200, 186, 168), amp: 0.04, grain: 0.02, seed: 13 }],
        ['plaster_sage', 'Sage Green', 'Plaster', 1.0, 'flat', { base: C(150, 168, 146), amp: 0.04, grain: 0.02, seed: 29 }],
        ['plaster_blue', 'Dusty Blue', 'Plaster', 1.0, 'flat', { base: C(146, 162, 178), amp: 0.04, grain: 0.02, seed: 31 }],
        ['plaster_terra', 'Terracotta', 'Plaster', 1.0, 'flat', { base: C(184, 124, 98), amp: 0.05, grain: 0.02, seed: 37 }],
        ['plaster_char', 'Charcoal', 'Plaster', 1.0, 'flat', { base: C(84, 86, 90), amp: 0.04, grain: 0.02, seed: 41 }],
        ['plaster_navy', 'Navy', 'Plaster', 1.0, 'flat', { base: C(56, 66, 86), amp: 0.04, grain: 0.02, seed: 43 }],
        ['tile_white', 'White Tile', 'Tile', 0.8, 'tile', { n: 4, grout: 3, base: C(198, 200, 198), groutCol: C(146, 148, 146) }],
        ['tile_grey', 'Grey Tile', 'Tile', 0.8, 'tile', { n: 4, grout: 3, base: C(138, 142, 144), groutCol: C(98, 100, 102) }],
        ['tile_black', 'Black Tile', 'Tile', 0.8, 'tile', { n: 4, grout: 3, base: C(58, 60, 62), groutCol: C(100, 100, 98) }],
        ['tile_check', 'Checker Tile', 'Tile', 0.8, 'tile', { n: 4, grout: 2, base: C(218, 218, 214), b: C(52, 54, 56), groutCol: C(120, 120, 118) }],
        ['tile_terra', 'Terracotta Tile', 'Tile', 0.8, 'tile', { n: 3, grout: 4, base: C(166, 104, 76), groutCol: C(128, 118, 108) }],
        ['wood_oak', 'Oak Planks', 'Wood', 1.2, 'plank', { n: 6, base: C(168, 130, 92) }],
        ['wood_walnut', 'Walnut Planks', 'Wood', 1.2, 'plank', { n: 6, base: C(98, 68, 48) }],
        ['wood_pine', 'Pine Planks', 'Wood', 1.2, 'plank', { n: 6, base: C(196, 164, 118) }],
        ['wood_ash', 'Grey Ash', 'Wood', 1.2, 'plank', { n: 6, base: C(170, 160, 146) }],
        ['wood_dark', 'Ebony Planks', 'Wood', 1.2, 'plank', { n: 6, base: C(60, 46, 38) }],
        ['wood_white', 'Painted Boards', 'Wood', 1.2, 'plank', { n: 8, base: C(220, 218, 210) }],
        ['roof_slate', 'Slate Roof', 'Roof', 1.0, 'shingle', { base: C(92, 92, 96) }],
        ['roof_terra', 'Clay Roof', 'Roof', 1.0, 'shingle', { base: C(150, 84, 62) }],
        ['roof_brown', 'Brown Shingle', 'Roof', 1.0, 'shingle', { base: C(100, 82, 66) }],
        ['roof_metal', 'Metal Sheet', 'Roof', 1.0, 'corrugated', { base: C(120, 126, 130) }],
        ['carpet_grey', 'Grey Carpet', 'Carpet', 1.0, 'carpet', { base: C(120, 120, 122) }],
        ['carpet_beige', 'Beige Carpet', 'Carpet', 1.0, 'carpet', { base: C(176, 162, 140) }],
        ['carpet_blue', 'Blue-Grey Carpet', 'Carpet', 1.0, 'carpet', { base: C(96, 110, 128) }],
        ['carpet_red', 'Wine Carpet', 'Carpet', 1.0, 'carpet', { base: C(124, 70, 72) }],
        ['metal_sheet', 'Corrugated Steel', 'Metal', 1.0, 'corrugated', { base: C(150, 154, 156), ribs: 12 }],
        ['trim_white', 'White Trim', 'Trim', 1.0, 'flat', { base: C(236, 236, 232), amp: 0.01, grain: 0.015, seed: 61 }],
        ['trim_dark', 'Dark Trim', 'Trim', 1.0, 'flat', { base: C(60, 56, 52), amp: 0.02, grain: 0.02, seed: 63 }],
        ['trim_wood', 'Wood Trim', 'Trim', 1.0, 'flat', { base: C(112, 80, 56), amp: 0.06, grain: 0.04, seed: 65 }],
        // old and left to rot: warehouses, lock-ups, basements
        ['old_brick', 'Grimy Brick', 'Abandoned', 0.9, 'brick', { cols: 4, rows: 12, base: C(128, 70, 54), mortar: C(150, 142, 128), vary: 0.18, w: { dirt: 0.7, stains: 0.5, streaks: 0.5, eff: 0.35, chips: 0.8, seed: 81 } }],
        ['old_brick_dark', 'Sooty Brick', 'Abandoned', 0.9, 'brick', { cols: 4, rows: 12, base: C(92, 60, 50), mortar: C(110, 104, 96), vary: 0.2, w: { dirt: 0.9, stains: 0.6, streaks: 0.7, chips: 1, seed: 83 } }],
        ['old_brick_paint', 'Peeling Paint on Brick', 'Abandoned', 0.9, 'peel', { base: C(196, 192, 176), amp: 0.06, grain: 0.04, peel: 0.52, seed: 85, under: ['brick', { cols: 4, rows: 12, base: C(130, 72, 56), mortar: C(150, 142, 128), vary: 0.18 }], w: { dirt: 0.6, stains: 0.5, streaks: 0.6, seed: 86 } }],
        ['old_block', 'Stained Block Wall', 'Abandoned', 1.0, 'brick', { cols: 2, rows: 5, base: C(140, 138, 130), mortar: C(112, 110, 104), mw: 3, vary: 0.08, w: { dirt: 0.7, stains: 0.6, streaks: 0.8, eff: 0.2, chips: 0.6, seed: 87 } }],
        ['old_concrete_wall', 'Streaked Concrete', 'Abandoned', 1.0, 'flat', { base: C(146, 145, 140), amp: 0.14, grain: 0.08, pits: 0.01, seed: 89, w: { dirt: 0.8, stains: 0.6, streaks: 1, cracks: 0.5, seed: 90 } }],
        ['old_concrete', 'Cracked Concrete Floor', 'Abandoned', 1.5, 'flat', { base: C(128, 126, 120), amp: 0.16, grain: 0.09, pits: 0.012, seed: 91, w: { dirt: 0.9, stains: 0.7, cracks: 1, oil: 0.8, chips: 0.6, seed: 92 } }],
        ['old_concrete_dark', 'Oily Concrete Floor', 'Abandoned', 1.5, 'flat', { base: C(96, 95, 92), amp: 0.16, grain: 0.09, pits: 0.012, seed: 93, w: { dirt: 0.8, stains: 0.8, cracks: 0.8, oil: 1, chips: 0.8, seed: 94 } }],
        ['old_metal', 'Rusted Steel Sheet', 'Abandoned', 1.0, 'corrugated', { base: C(122, 124, 120), ribs: 12, w: { dirt: 0.6, rust: 0.9, streaks: 0.7, seed: 95 } }],
        ['old_ceiling', 'Water-stained Ceiling', 'Abandoned', 1.0, 'panel', { base: C(176, 172, 160), amp: 0.08, grain: 0.05, n: 2, seed: 97, w: { dirt: 0.6, stains: 0.9, streaks: 0.2, seed: 98 } }],
        ['old_broken', 'Broken Masonry', 'Abandoned', 0.6, 'rubble', { base: C(118, 74, 60), b: C(132, 128, 120) }]
    ];
    // collision surface type by category (values the game's own pack uses)
    const COL = { Brick: 1, Stone: 1, Concrete: 1, Plaster: 101, Tile: 81, Wood: 72, Roof: 1, Carpet: 101, Metal: 1, Trim: 101, Abandoned: 1 };

    const byId = {}, cache = {};
    const cats = [];
    LIST.forEach(function (d) {
        const o = { id: d[0], name: d[1], cat: d[2], tile: d[3], kind: d[4], params: d[5], col: COL[d[2]] || 1 };
        byId[o.id] = o; if (cats.indexOf(o.cat) < 0) cats.push(o.cat);
    });

    function clamp8(v) { return v < 0 ? 0 : (v > 255 ? 255 : Math.round(v)); }

    function generate(id) {
        const d = byId[id]; if (!d) return null;
        const data = new Uint8ClampedArray(SIZE * SIZE * 4); let r = 0, g = 0, b = 0;
        if (d.kind === 'low') return lowVariant(d);
        const fn = K[d.kind], w = d.params.w;
        for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
            const u = (x + 0.5) / SIZE, v = (y + 0.5) / SIZE; let c = fn(u, v, d.params); if (w) c = weather(u, v, c, w); const o = (y * SIZE + x) * 4;
            data[o] = clamp8(c[0]); data[o + 1] = clamp8(c[1]); data[o + 2] = clamp8(c[2]); data[o + 3] = 255;
            r += data[o]; g += data[o + 1]; b += data[o + 2];
        }
        const n = SIZE * SIZE;
        return { id, def: d, size: SIZE, data, avg: [r / n / 255, g / n / 255, b / n / 255] };
    }

    // The bottom of a wall gone dirty: the texture with grime rising from its lower edge (splashes, damp, scuffs). Exactly one repeat high, so on a wall
    // it fills the band from the floor to one tile up and lines up with the clean texture above it.
    function lowVariant(d) {
        const src = TEX.pixels(d.of), n = src.size, data = new Uint8ClampedArray(src.data); let r = 0, g = 0, b = 0;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
            const u = (x + 0.5) / n, v = (y + 0.5) / n, rise = 0.45 + 0.35 * vn2(u * 6, 0, 6, 1, 101) + 0.12 * vn2(u * 40, 0, 40, 1, 103);
            let m = sstep(1 - rise, 1 - rise * 0.25, v) * (0.7 + 0.3 * fbm(u, v, 4, 105));
            const o = (y * n + x) * 4, k = 1 - 0.68 * m;
            data[o] = clamp8(data[o] * k + 10 * m); data[o + 1] = clamp8(data[o + 1] * k + 8 * m); data[o + 2] = clamp8(data[o + 2] * k + 3 * m);
            r += data[o]; g += data[o + 1]; b += data[o + 2];
        }
        const t = n * n; return { id: d.id, def: d, size: n, data, avg: [r / t / 255, g / t / 255, b / t / 255] };
    }

    const TEX = {
        SIZE, list: LIST.map(d => byId[d[0]]), cats, byId,
        def(id) { return byId[id] || byId.plaster_cream; },
        tile(id) { return (byId[id] || byId.plaster_cream).tile; },
        colType(id) { return (byId[id] || byId.plaster_cream).col; },
        pixels(id) { if (!byId[id]) id = 'plaster_cream'; return cache[id] || (cache[id] = generate(id)); },
        // swatch canvas for the palette
        swatch(id, px) {
            const t = TEX.pixels(id), c = document.createElement('canvas'); c.width = c.height = px || 64;
            const full = document.createElement('canvas'); full.width = full.height = t.size;
            full.getContext('2d').putImageData(new ImageData(t.data, t.size, t.size), 0, 0);
            const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.drawImage(full, 0, 0, c.width, c.height); return c;
        },
        gl: {},
        glTexture(gl, id) {
            if (!byId[id]) id = 'plaster_cream';
            const key = id; if (TEX.gl[key]) return TEX.gl[key];
            const t = TEX.pixels(id), tx = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tx);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, t.size, t.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength));
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
            const ext = gl.getExtension('EXT_texture_filter_anisotropic');
            if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
            return (TEX.gl[key] = tx);
        },
        resetGL() { TEX.gl = {}; },
        // the dirty-bottom version of a texture (registered on first use; its own name, so it exports as its own texture)
        low(id) {
            const base = byId[id] ? id : 'plaster_cream', lid = base + '_low';
            if (!byId[lid]) { const d = byId[base]; byId[lid] = { id: lid, name: d.name + ' (dirty bottom)', cat: d.cat, tile: d.tile, kind: 'low', of: base, params: {}, col: d.col }; }
            return lid;
        },
        // Photographs that ship with the program (ui\tex\*.png): square tiles that repeat, 512 x 512 (twice the size of the generated ones), listed first under "Wood".
        // `tile` is how many metres one tile covers.
        PHOTOS: [
            { id: 'photo_oak_grey', name: 'Grey Oak Planks (photo)', file: 'photo_oak_grey.png', tile: 1.4 },
            { id: 'photo_oak_natural', name: 'Natural Oak Strips (photo)', file: 'photo_oak_natural.png', tile: 1.0 }
        ],
        addPhoto(p, source) {
            const w = source.naturalWidth || source.width, c = document.createElement('canvas'); c.width = c.height = w; const x = c.getContext('2d');
            x.drawImage(source, 0, 0, w, w); const img = x.getImageData(0, 0, w, w), d = img.data; let r = 0, g = 0, b = 0;
            for (let i = 0; i < d.length; i += 4) { d[i + 3] = 255; r += d[i]; g += d[i + 1]; b += d[i + 2]; }
            const n = w * w, o = { id: p.id, name: p.name, cat: 'Wood', tile: p.tile, kind: 'photo', params: null, col: COL.Wood };
            if (!byId[p.id]) { const at = TEX.list.findIndex(t => t.cat === 'Wood' && t.kind !== 'photo'); TEX.list.splice(at < 0 ? TEX.list.length : at, 0, o); }          // (after the other photos, before the generated woods)
            byId[p.id] = o; cache[p.id] = { id: p.id, def: o, size: w, data: d, avg: [r / n / 255, g / n / 255, b / n / 255] };
            if (TEX.gl[p.id]) delete TEX.gl[p.id]; return o;
        },
        loadPhotos() {
            // all the pictures are read first, then listed in the order of PHOTOS
            return Promise.all(TEX.PHOTOS.map(p => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = 'tex/' + p.file; })))
                .then(ims => { TEX.PHOTOS.forEach((p, i) => { if (ims[i]) { try { TEX.addPhoto(p, ims[i]); } catch (e) { M.Errors.report('textures', e, { quiet: true }); } } }); });
        },
        // images the user brought: drawn to the same size as the built-in textures, listed under "Mine"
        addUser(id, name, tile, source) {
            const c = document.createElement('canvas'); c.width = c.height = SIZE; const x = c.getContext('2d');
            x.drawImage(source, 0, 0, SIZE, SIZE); const img = x.getImageData(0, 0, SIZE, SIZE), d = img.data; let r = 0, g = 0, b = 0;
            for (let i = 0; i < d.length; i += 4) { d[i + 3] = 255; r += d[i]; g += d[i + 1]; b += d[i + 2]; }
            const n = SIZE * SIZE, o = { id, name, cat: 'Mine', tile: tile || 1, kind: 'user', params: null, col: 1 };
            if (!byId[id]) TEX.list.push(o); byId[id] = o; if (cats.indexOf('Mine') < 0) cats.push('Mine');
            cache[id] = { id, def: o, size: SIZE, data: d, avg: [r / n / 255, g / n / 255, b / n / 255] };
            if (TEX.gl[id]) delete TEX.gl[id]; return o;
        },
        clearUser() {
            for (let i = TEX.list.length - 1; i >= 0; i--) if (TEX.list[i].kind === 'user') { delete byId[TEX.list[i].id]; delete cache[TEX.list[i].id]; TEX.list.splice(i, 1); }
            const k = cats.indexOf('Mine'); if (k >= 0) cats.splice(k, 1); TEX.gl = {};
        },
        loadUser(list) {
            TEX.clearUser();
            return Promise.all((list || []).map(t => new Promise(res => { const im = new Image(); im.onload = () => { TEX.addUser(t.id, t.name, t.tile, im); res(); }; im.onerror = () => res(); im.src = t.url; })));
        },
        // the 256 x 256 picture as a PNG for saving with the project
        userUrl(id) {
            const t = cache[id]; if (!t) return ''; const c = document.createElement('canvas'); c.width = c.height = SIZE; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.data), SIZE, SIZE), 0, 0); return c.toDataURL('image/png');
        }
    };
    M.TEX = TEX;
})(window.MLO);

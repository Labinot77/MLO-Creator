// Baked ambient light for the exported interior (vertex colour 0), the way the game's own interiors are lit. C# 5.
// GTA lights map and interior models with the ambient light stored per vertex: red = natural (sky light coming in through
// the windows and doors), green = artificial (the interior's own ambient). Full white everywhere makes every surface evenly
// bright and lets the sky light reach the back of every room, so a shell glows at night.
// Here the interior is split finer and ambient occlusion is traced against the interior itself (corners and the meeting
// of walls, floor and ceiling get darker). The natural light comes in through the portals (windows and doors): bright by
// them, falling off into the room, down to `naturalMin` deep inside, like a native MLO. Door props are baked the same way
// where they stand (their outside face gets the sky light). The ceiling lights are made interior-only and the first few
// cast shadows, like the game's own interior lights.
// Settings: "ambient" in settings.json, e.g. { "enabled": true, "strength": 0.7, "natural": 0.55, "naturalMin": 0.12, "artificial": 0.85,
// "door": 0.55, "portalReach": 1.0, "shadowLights": 8, "interiorOnly": true }.
using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;

namespace MloCreator
{
    public static partial class Exporter
    {
        class AmbientSettings
        {
            public bool Enabled = true;
            public double Grid = 0.25, Distance = 1.5, Strength = 0.7, Natural = 0.55, NaturalMin = 0.12, Artificial = 0.85, Min = 0.3, Door = 0.55, PortalReach = 1.0;
            public int Rays = 32, ShadowLights = 8;
            public bool InteriorOnly = true;
        }

        static AmbientSettings LoadAmbientSettings()
        {
            AmbientSettings a = new AmbientSettings();
            try
            {
                string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "settings.json");
                if (!File.Exists(path)) return a;
                Dictionary<string, object> d = J.O(J.G(J.O(new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path))), "ambient"));
                if (d == null) return a;
                a.Enabled = J.B(J.G(d, "enabled"), a.Enabled);
                a.Grid = Clamp(J.D(J.G(d, "grid"), a.Grid), 0.1, 2);
                a.Distance = Clamp(J.D(J.G(d, "distance"), a.Distance), 0.2, 5);
                a.Strength = Clamp(J.D(J.G(d, "strength"), a.Strength), 0, 1);
                a.Natural = Clamp(J.D(J.G(d, "natural"), a.Natural), 0, 1);
                a.Artificial = Clamp(J.D(J.G(d, "artificial"), a.Artificial), 0, 1);
                a.Min = Clamp(J.D(J.G(d, "min"), a.Min), 0, 1);
                a.Door = Clamp(J.D(J.G(d, "door"), a.Door), 0, 1);
                a.Rays = (int)Clamp(J.I(J.G(d, "rays"), a.Rays), 8, 128);
                a.NaturalMin = Clamp(J.D(J.G(d, "naturalMin"), a.NaturalMin), 0, 1);
                a.PortalReach = Clamp(J.D(J.G(d, "portalReach"), a.PortalReach), 0, 4);
                a.ShadowLights = (int)Clamp(J.I(J.G(d, "shadowLights"), a.ShadowLights), 0, 48);
                a.InteriorOnly = J.B(J.G(d, "interiorOnly"), a.InteriorOnly);
            }
            catch { }
            return a;
        }

        static double Clamp(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

        // A window or door the sky light comes in through: its middle, the way it looks out (unit), its area.
        class SkyHole { public V3 C, N; public double A; }

        static List<SkyHole> SkyHoles(List<PortalData> portals)
        {
            List<SkyHole> list = new List<SkyHole>();
            if (portals == null) return list;
            foreach (PortalData p in portals)
            {
                V3 a = new V3(p.C[0], p.C[1], p.C[2]), b = new V3(p.C[3], p.C[4], p.C[5]), c = new V3(p.C[6], p.C[7], p.C[8]), d = new V3(p.C[9], p.C[10], p.C[11]);
                V3 n = Cross(b - a, c - a) + Cross(c - a, d - a); double l = n.Len(); if (l < 1e-6) continue;
                SkyHole h = new SkyHole(); h.C = (a + b + c + d) * 0.25; h.N = n * (1 / l); h.A = l / 2; list.Add(h);
            }
            return list;
        }

        // the old call (an Exporter.cs patched by install-ambient.ps1): no portals, doors one even value
        static void BakeAmbient(List<GroupData> groups, List<GroupData> doors, List<string> log)
        {
            AmbientSettings s = LoadAmbientSettings();
            BakeInterior(groups, null, s, log);
            if (!s.Enabled) return;
            byte door = (byte)Math.Round(255 * s.Door);
            foreach (GroupData g in doors)
                foreach (MatData m in g.Mats)
                {
                    if (m.Glass) continue;
                    m.Col = new byte[m.Pos.Length / 3 * 4];
                    for (int i = 0; i < m.Col.Length; i += 4) { m.Col[i] = door; m.Col[i + 1] = door; m.Col[i + 2] = 255; m.Col[i + 3] = 255; }
                }
        }

        // Interior parts and door props get traced shading with the sky light from the portals; the lights get the game's interior flags.
        // doorAt: where each door prop stands in the interior (its geometry is relative to that point).
        static void BakeAmbient(List<GroupData> groups, List<GroupData> doors, List<V3> doorAt, List<PortalData> portals, List<string> log)
        {
            AmbientSettings s = LoadAmbientSettings();
            List<float[]> tris = BakeInterior(groups, portals, s, log);
            LightFlags(groups, s, log);
            if (!s.Enabled) return;
            List<SkyHole> holes = SkyHoles(portals);
            V3[] dirs = HemisphereDirs(s.Rays);
            for (int i = 0; i < doors.Count; i++)
                foreach (MatData m in doors[i].Mats)
                {
                    if (m.Glass) continue;
                    m.Col = Occlusion(m, tris, dirs, s, holes, i < doorAt.Count ? doorAt[i] : new V3(0, 0, 0), true);
                }
            if (doors.Count > 0) log.Add("ambient: " + doors.Count + " door prop(s) baked where they stand");
        }

        // the lights: interior-only (no light through the walls to the outside) and the first few cast shadows, as in the game's interiors
        static void LightFlags(List<GroupData> groups, AmbientSettings s, List<string> log)
        {
            int n = 0, shadows = 0;
            foreach (GroupData g in groups)
                foreach (LightData l in g.Lights)
                {
                    int f = s.InteriorOnly ? 1 : 0;
                    if (n < s.ShadowLights) { f |= 64 | 128 | 256; shadows++; }          // CAST_SHADOWS, CAST_STATIC_GEOM_SHADOWS, CAST_DYNAMIC_GEOM_SHADOWS
                    l.Flags = f; n++;
                }
            if (n > 0) log.Add("lights: " + n + (s.InteriorOnly ? " interior-only" : "") + ", " + shadows + " cast shadows");
        }

        static List<float[]> BakeInterior(List<GroupData> groups, List<PortalData> portals, AmbientSettings s, List<string> log)
        {
            // occluders: every solid triangle of the interior, before splitting (fewer triangles to trace against)
            List<float[]> tris = new List<float[]>();
            if (!s.Enabled) { log.Add("ambient: off (settings.json)"); return tris; }
            foreach (GroupData g in groups)
                foreach (MatData m in g.Mats)
                    if (!m.Glass)
                        for (int i = 0; i + 2 < m.Idx.Length; i += 3)
                        {
                            float[] t = new float[12];   // 3 corners + the side the face looks at (its normal)
                            for (int k = 0; k < 3; k++)
                            {
                                Array.Copy(m.Pos, m.Idx[i + k] * 3, t, k * 3, 3);
                                for (int c = 0; c < 3; c++) t[9 + c] += m.Nrm[m.Idx[i + k] * 3 + c];
                            }
                            tris.Add(t);
                        }

            List<SkyHole> holes = SkyHoles(portals);
            V3[] dirs = HemisphereDirs(s.Rays);
            int verts = 0;
            foreach (GroupData g in groups)
                foreach (MatData m in g.Mats)
                {
                    if (m.Glass) continue;
                    Subdivide(m, s.Grid);
                    m.Col = Occlusion(m, tris, dirs, s, holes, new V3(0, 0, 0), false);
                    verts += m.Pos.Length / 3;
                }
            log.Add("ambient: baked shading on " + verts + " vertices (natural " + s.NaturalMin + " deep inside to " + s.Natural + " at " + holes.Count + " window(s) / door(s), artificial " + s.Artificial + ")");
            return tris;
        }

        // How much sky light reaches a point inside through the portals: 0 (none) .. 1 (standing in one). Each portal is a lit area light:
        // its view factor from the point (area x the two cosines / pi r^2), so it falls off with the distance and the angle. Points outside a portal
        // (the outer face of a door, a window frame on the outside) get the full sky light.
        static double SkyAt(V3 p, V3 n, List<SkyHole> holes, double reach)
        {
            double sum = 0;
            foreach (SkyHole h in holes)
            {
                V3 d = h.C - p; double r = d.Len();
                double side = Dot(p - h.C, h.N);
                if (side > -0.02 && r < 1.6) { if (Dot(n, h.N) > 0.2) return 1; continue; }        // on the outside of it, facing out
                if (r < 1e-3) return 1;
                V3 w = d * (1 / r);
                double cv = Dot(n, w), cp = -side / r;                                           // the point looks at the portal; the portal's inside looks at the point
                if (cv <= 0 || cp <= 0) continue;
                double rr = r * r + h.A * 0.25;                                                  // (no blow-up right at the portal)
                sum += h.A * cv * cp / (Math.PI * rr);
            }
            return Math.Min(1, sum * (1 + reach * 2));
        }
        // Splits every triangle whose longest edge is longer than grid (shared edges split once, uv / normal interpolated).
        static void Subdivide(MatData m, double grid)
        {
            List<float> pos = new List<float>(m.Pos), nrm = new List<float>(m.Nrm), uv = new List<float>(m.Uv);
            List<int> idx = new List<int>(m.Idx);
            for (int pass = 0; pass < 12; pass++)
            {
                Dictionary<long, int> mids = new Dictionary<long, int>();
                List<int> next = new List<int>(idx.Count * 2);
                bool split = false;
                for (int i = 0; i < idx.Count; i += 3)
                {
                    int a = idx[i], b = idx[i + 1], c = idx[i + 2];
                    double ab = Dist(pos, a, b), bc = Dist(pos, b, c), ca = Dist(pos, c, a);
                    double longest = Math.Max(ab, Math.Max(bc, ca));
                    if (longest <= grid * 1.5 || pos.Count / 3 > 60000) { next.Add(a); next.Add(b); next.Add(c); continue; }
                    split = true;
                    // split the longest edge: two triangles
                    if (bc == longest) { int t = a; a = b; b = c; c = t; }
                    else if (ca == longest) { int t = a; a = c; c = b; b = t; }
                    int mid = Mid(a, b, pos, nrm, uv, mids);
                    next.Add(a); next.Add(mid); next.Add(c);
                    next.Add(mid); next.Add(b); next.Add(c);
                }
                idx = next;
                if (!split) break;
            }
            m.Pos = pos.ToArray(); m.Nrm = nrm.ToArray(); m.Uv = uv.ToArray(); m.Idx = idx.ToArray();
        }

        static double Dist(List<float> p, int a, int b)
        {
            double x = p[a * 3] - p[b * 3], y = p[a * 3 + 1] - p[b * 3 + 1], z = p[a * 3 + 2] - p[b * 3 + 2];
            return Math.Sqrt(x * x + y * y + z * z);
        }

        static int Mid(int a, int b, List<float> pos, List<float> nrm, List<float> uv, Dictionary<long, int> mids)
        {
            long key = a < b ? ((long)a << 32) | (uint)b : ((long)b << 32) | (uint)a;
            int m;
            if (mids.TryGetValue(key, out m)) return m;
            m = pos.Count / 3;
            for (int k = 0; k < 3; k++) pos.Add((pos[a * 3 + k] + pos[b * 3 + k]) / 2);
            float nx = nrm[a * 3] + nrm[b * 3], ny = nrm[a * 3 + 1] + nrm[b * 3 + 1], nz = nrm[a * 3 + 2] + nrm[b * 3 + 2];
            float nl = (float)Math.Sqrt(nx * nx + ny * ny + nz * nz); if (nl < 1e-6f) nl = 1;
            nrm.Add(nx / nl); nrm.Add(ny / nl); nrm.Add(nz / nl);
            for (int k = 0; k < 2; k++) uv.Add((uv[a * 2 + k] + uv[b * 2 + k]) / 2);
            mids[key] = m;
            return m;
        }

        // Evenly spread directions over the upper half of a sphere (z up), cosine weighted.
        static V3[] HemisphereDirs(int n)
        {
            V3[] d = new V3[n];
            double golden = Math.PI * (3 - Math.Sqrt(5));
            for (int i = 0; i < n; i++)
            {
                double r = Math.Sqrt((i + 0.5) / n), phi = i * golden;
                d[i] = new V3(r * Math.Cos(phi), r * Math.Sin(phi), Math.Sqrt(1 - r * r));
            }
            return d;
        }

        static byte[] Occlusion(MatData m, List<float[]> tris, V3[] dirs, AmbientSettings s, List<SkyHole> holes, V3 off, bool door)
        {
            int nv = m.Pos.Length / 3;
            byte[] col = new byte[nv * 4];
            List<float[]> near = new List<float[]>();
            double reach = s.Distance;
            for (int v = 0; v < nv; v++)
            {
                V3 p = new V3(m.Pos[v * 3] + off.X, m.Pos[v * 3 + 1] + off.Y, m.Pos[v * 3 + 2] + off.Z);
                V3 n = new V3(m.Nrm[v * 3], m.Nrm[v * 3 + 1], m.Nrm[v * 3 + 2]);
                double nl = n.Len(); n = nl > 1e-6 ? n * (1 / nl) : new V3(0, 0, 1);

                // triangles within reach of this vertex
                near.Clear();
                foreach (float[] t in tris)
                {
                    if (Math.Min(t[0], Math.Min(t[3], t[6])) > p.X + reach || Math.Max(t[0], Math.Max(t[3], t[6])) < p.X - reach) continue;
                    if (Math.Min(t[1], Math.Min(t[4], t[7])) > p.Y + reach || Math.Max(t[1], Math.Max(t[4], t[7])) < p.Y - reach) continue;
                    if (Math.Min(t[2], Math.Min(t[5], t[8])) > p.Z + reach || Math.Max(t[2], Math.Max(t[5], t[8])) < p.Z - reach) continue;
                    near.Add(t);
                }

                // local frame around the normal
                V3 tan = Math.Abs(n.Z) < 0.9 ? Cross(new V3(0, 0, 1), n) : Cross(new V3(1, 0, 0), n);
                tan = tan * (1 / tan.Len());
                V3 bit = Cross(n, tan);
                V3 o = p + n * 0.01;

                double occ = 0;
                foreach (V3 d in dirs)
                {
                    V3 w = tan * d.X + bit * d.Y + n * d.Z;
                    double hit = reach;
                    foreach (float[] t in near)
                    {
                        double h = RayTri(o, w, t);
                        if (h < 0 || h >= hit) continue;
                        // a vertex on a corner or edge lies on the wall next to it: that wall only blocks rays going into it
                        if (h < 0.02 && w.X * t[9] + w.Y * t[10] + w.Z * t[11] >= 0) continue;
                        hit = h;
                    }
                    if (hit < reach) occ += 1 - hit / reach;
                }
                double light = Math.Max(s.Min, 1 - s.Strength * occ / dirs.Length);
                double sky = holes != null && holes.Count > 0 ? SkyAt(p, n, holes, s.PortalReach) : (door ? s.Door / Math.Max(1e-3, s.Natural) : 1);
                double nat = holes != null && holes.Count > 0 ? s.NaturalMin + (s.Natural - s.NaturalMin) * sky : s.Natural * Math.Min(1, sky);
                col[v * 4] = (byte)Math.Round(255 * Clamp(nat * light, 0, 1));
                col[v * 4 + 1] = (byte)Math.Round(255 * s.Artificial * light);
                col[v * 4 + 2] = 255;
                col[v * 4 + 3] = 255;
            }
            return col;
        }

        static V3 Cross(V3 a, V3 b) { return new V3(a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X); }
        static double Dot(V3 a, V3 b) { return a.X * b.X + a.Y * b.Y + a.Z * b.Z; }

        // Möller-Trumbore, both sides; distance along the ray or -1.
        static double RayTri(V3 o, V3 d, float[] t)
        {
            V3 a = new V3(t[0], t[1], t[2]), e1 = new V3(t[3], t[4], t[5]) - a, e2 = new V3(t[6], t[7], t[8]) - a;
            V3 pv = Cross(d, e2);
            double det = Dot(e1, pv);
            if (Math.Abs(det) < 1e-9) return -1;
            double inv = 1 / det;
            V3 tv = o - a;
            double u = Dot(tv, pv) * inv;
            if (u < 0 || u > 1) return -1;
            V3 qv = Cross(tv, e1);
            double v = Dot(d, qv) * inv;
            if (v < 0 || u + v > 1) return -1;
            return Dot(e2, qv) * inv;
        }
    }
}

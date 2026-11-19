// Baked ambient light for the exported interior (vertex colour 0). C# 5.
// GTA lights map and interior models with the ambient light stored per vertex: red = natural (sky, windows),
// green = artificial (the interior's own ambient). Full white everywhere makes every surface evenly bright.
// Here the interior is split finer, ambient occlusion is traced against the interior itself (corners and the
// meeting of walls, floor and ceiling get darker) and written into those channels. Doors get one even, lower value.
// Settings: "ambient" in settings.json, e.g. { "enabled": true, "strength": 0.7, "natural": 0.55, "artificial": 0.85, "door": 0.55 }.
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
            public double Grid = 0.25, Distance = 1.5, Strength = 0.7, Natural = 0.55, Artificial = 0.85, Min = 0.3, Door = 0.55;
            public int Rays = 32;
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
            }
            catch { }
            return a;
        }

        static double Clamp(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

        // Interior parts get traced shading, doors one even value. Called right before the drawables are written.
        static void BakeAmbient(List<GroupData> groups, List<GroupData> doors, List<string> log)
        {
            AmbientSettings s = LoadAmbientSettings();
            if (!s.Enabled) { log.Add("ambient: off (settings.json)"); return; }

            // occluders: every solid triangle of the interior, before splitting (fewer triangles to trace against)
            List<float[]> tris = new List<float[]>();
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

            V3[] dirs = HemisphereDirs(s.Rays);
            int verts = 0;
            foreach (GroupData g in groups)
                foreach (MatData m in g.Mats)
                {
                    if (m.Glass) continue;
                    Subdivide(m, s.Grid);
                    m.Col = Occlusion(m, tris, dirs, s);
                    verts += m.Pos.Length / 3;
                }

            byte door = (byte)Math.Round(255 * s.Door);
            foreach (GroupData g in doors)
                foreach (MatData m in g.Mats)
                {
                    if (m.Glass) continue;
                    m.Col = new byte[m.Pos.Length / 3 * 4];
                    for (int i = 0; i < m.Col.Length; i += 4) { m.Col[i] = door; m.Col[i + 1] = door; m.Col[i + 2] = 255; m.Col[i + 3] = 255; }
                }
            log.Add("ambient: baked shading on " + verts + " vertices (natural " + s.Natural + ", artificial " + s.Artificial + "), doors " + s.Door);
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

        static byte[] Occlusion(MatData m, List<float[]> tris, V3[] dirs, AmbientSettings s)
        {
            int nv = m.Pos.Length / 3;
            byte[] col = new byte[nv * 4];
            List<float[]> near = new List<float[]>();
            double reach = s.Distance;
            for (int v = 0; v < nv; v++)
            {
                V3 p = new V3(m.Pos[v * 3], m.Pos[v * 3 + 1], m.Pos[v * 3 + 2]);
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
                col[v * 4] = (byte)Math.Round(255 * s.Natural * light);
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

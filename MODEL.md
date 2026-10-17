# Ostium — model documentation

> **Educational simulation — not for clinical use.** Every number here is a modeling choice meant to be
> physiologically plausible for teaching. None of it is validated for clinical decisions.

This document lists every modeling assumption, equation, and parameter in the simulator. Each
milestone adds its own section. Sections marked *(planned)* are not implemented yet.

- [1. Anatomy](#1-anatomy) — implemented (M1)
- [2. Electrophysiology engine](#2-electrophysiology-engine) — *(planned, M2)*
- [3. Catheters and signals](#3-catheters-and-signals) — *(planned, M3)*
- [4. Mapping](#4-mapping) — *(planned, M4)*
- [5. Ablation](#5-ablation) — *(planned, M5)*
- [6. Pacing and scenarios](#6-pacing-and-scenarios) — *(planned, M6)*
- [7. Autonomic module and dataset export](#7-autonomic-module-and-dataset-export) — *(planned, M7)*
- [Known limitations](#known-limitations)
- [References](#references)

---

## 1. Anatomy

### 1.1 Frame and units

All geometry is in **millimetres** in a patient **LPS** frame:

| Axis | Positive direction |
|---|---|
| +x | patient **Left** |
| +y | **Posterior** |
| +z | **Superior** |

The LA body centre is at the origin. Standard views (`src/render/views.ts`) are defined in this frame.
Each view is given by the direction from the heart to the camera, plus a screen-up vector.

| View | Camera direction | Up |
|---|---|---|
| AP | −y (anterior) | +z |
| PA | +y | +z |
| LAO θ | (sin θ, −cos θ, 0) | +z |
| RAO θ | (−sin θ, −cos θ, 0) | +z |
| Left / right lateral | +x / −x | +z |
| Superior / inferior | +z / −z | −y (anterior at the top of the screen) |

θ defaults to 30°. The AP view shows the patient's left on screen right, which matches fluoroscopy.

### 1.2 Procedural shape (implicit surface)

The endocardial (blood–tissue) surface is the zero level set of a scalar function *f* (*f* < 0 inside the
blood pool). It is assembled from simple primitives (`src/core/mesh/sdf-atrium.ts`):

- **Body.** An ellipsoid with radii (r<sub>x</sub>, r<sub>y</sub>, r<sub>z</sub>), using the distance bound
  f<sub>E</sub>(p) = k<sub>0</sub>(k<sub>0</sub> − 1)/k<sub>1</sub>, where k<sub>0</sub> = ‖p/r‖ and
  k<sub>1</sub> = ‖p/r²‖ (Quílez).
- **Pulmonary veins.** A tube along a + t·d for t ∈ [−6, L<sub>cut</sub> + 8] mm:
  f<sub>V</sub>(p) = ‖p − a − t*·d‖ − r(t*), where t* is the clamped projection of p onto the axis.
  - The radius tapers linearly from the ostial radius r<sub>0</sub> at t = 0 to the distal radius
    r<sub>1</sub> at t = 10 mm, then stays constant.
  - The attachment point a lies on the ellipsoid in a prescribed direction from the centre.
- **LAA.** Two tapered tubes, a proximal neck and a bent distal lobe, joined with a smooth minimum
  (k = 3 mm). The LAA is closed: it has no opening.
- **Blending.** Components are combined with the polynomial smooth minimum
  smin(a, b, k) = min(a, b) − h²k/4, with h = max(k − |a − b|, 0)/k.
  - Body–vein blending uses k = 7 mm. This creates the funnel-shaped **antra**.
  - Body–LAA blending uses k = 4 mm, which gives a narrower, better-defined LAA neck.
- **Openings.** Each PV is cut by a plane perpendicular to its axis, 20 mm from the attachment point.
  The **mitral valve** is cut by a plane with outward normal n<sub>MV</sub> (anterior–inferior–leftward).
  - The MV plane offset is 0.83 × the ellipsoid's support distance along n<sub>MV</sub>.
  - Each cut removes only the geometry its own primitive owns (the vein for a PV cut, the body for the
    MV cut) inside a cylinder around the cut axis. A cut therefore never opens a neighbouring structure.
  - All openings are left open. They become **no-flux boundaries** in the solver, which happens
    naturally with the FEM Neumann condition in M2.

**Default parameters** (`DEFAULT_ATRIUM`):

| Parameter | Value | Rationale |
|---|---|---|
| Body radii (L–R, A–P, S–I) | 35, 24, 27 mm | Ellipsoid volume ≈ 95 mL. This is a moderately dilated LA, typical of an AF ablation population. Upper normal LA volume index is ≈ 34 mL/m² (Lang 2015), i.e. ≈ 65 mL at a body surface area of 1.9 m². |
| PV ostial radius | 8.5–9 mm | Ostial diameters of roughly 15–20 mm. The superior veins are slightly larger (Kato 2003). |
| PV distal radius | 6–6.5 mm | |
| PV length to the open end | 20 mm from the attachment point | The ostium sits about 4 mm out. This leaves about 16 mm of sleeve, within the reported range of myocardial sleeve extension (Saito 2000). |
| Body–PV blend k | 7 mm | Sets the size of the antral funnel. |
| LAA neck radius / lobe | 8 → 6.5 → 4 mm, 11 + 11 mm long | A hooked appendage at the anterolateral roof. |
| MV cut fraction | 0.83 | Annulus radius ≈ 15–16 mm (diameter ≈ 31 mm, circumference ≈ 10 cm). |

**Anatomical variability.** `jitterAtrium(seed, amount)` multiplies or perturbs parameters with seeded
Gaussian noise, scaled by `amount`. With `amount = 1`:

| Parameter | Perturbation (SD) |
|---|---|
| Body radii | ±6 % |
| PV attachment directions | ±0.05 (vector components) |
| PV axes | ±0.08 |
| PV radii | ±8 % |
| LAA axis | ±0.08 |
| LAA lobe direction | ±0.15 |
| MV normal | ±0.04 |

`amount = 0` returns the canonical anatomy exactly. These are rough, educational ranges, not fitted to a
population atlas.

### 1.3 Meshing

`src/core/mesh/atrium.ts` runs these steps:

1. **Polygonize.** Run naive surface nets (one vertex per sign-changing cell, at the mean of the edge
   crossings) on a 1 mm grid (Gibson 1998). The result is closed and consistently oriented.
2. **Cut openings.**
   - Delete triangles whose centroid lies beyond a cut.
   - Remove bow-tie vertices, then keep the largest connected component.
   - Fan-fill holes of ≤ 8 vertices left by the cleanup.
   - Assign each boundary loop to its cut plane, then snap the loop onto the exact surface ∩ plane curve
     by alternating projections.
3. **Isotropic remeshing** (Botsch & Kobbelt 2004), 8 iterations at target edge L = 0.95 mm. Each
   iteration:
   - splits edges longer than 4L/3;
   - collapses edges shorter than 4L/5, subject to the link condition, valence ≥ 4, no new edges longer
     than 4L/3, and no normal flips;
   - flips edges to equalize valence (target 6 inside, 4 on the boundary);
   - applies area-weighted tangential relaxation (λ = 0.8).

   After every move, vertices are projected back onto f = 0 by Newton steps
   p ← p − f ∇f / ‖∇f‖², with a central-difference gradient. Boundary vertices are kept on their cut curve.
4. **Delaunay flips.** Flip an edge if its two opposite angles sum to more than π and the adjacent pair
   of triangles is near-planar (normal dot product > 0.985). This reduces negative cotangent weights
   for the M2 Laplacian.

Typical result for the default anatomy (checked by `tests/mesh.test.ts`):

| Metric | Value |
|---|---|
| Vertices / triangles | ≈ 16.5 k / ≈ 32.8 k |
| Mean edge length | 0.955 mm |
| Minimum triangle angle | ≈ 28° |
| Obtuse triangles | < 0.5 % |
| Endocardial area | ≈ 128 cm² |
| Topology | 2-manifold, consistently oriented, Euler characteristic χ = −3 (a sphere with 5 holes) |
| Fold-overs | none (every triangle normal agrees with ∇f) |

Generation takes about 8–10 s in a browser worker. The result is cached in IndexedDB, keyed by the
options and `GENERATOR_VERSION`.

### 1.4 Region labels

Each vertex gets one `Region` label (`src/core/mesh/regions.ts`). The numeric ids are part of the export
format. `labelAtrium` applies these rules in precedence order (the first match wins):

1. **PV sleeve (LSPV/LIPV/RSPV/RIPV).** Axial position t ≥ t<sub>ost</sub> along the vein axis, and radial
   distance < r(t) + 3 mm.
   - The ostium position t<sub>ost</sub> is found by ray-marching the surface radius around the axis.
   - The ostium is the first t where the antral funnel has narrowed to within 0.75 mm of the tube radius.
   - The **ostium ring** is the set of sleeve vertices that border non-sleeve vertices. It is stored in
     `mesh.anatomy.pvs[k].ostiumRing`.
2. **LAA.** The LAA primitive is the closest primitive to the vertex: f<sub>LAA</sub> < f<sub>body</sub>
   and f<sub>LAA</sub> < every f<sub>V</sub>.
3. **Mitral isthmus.** The vertex satisfies d(LIPV ostium ring) + d(MV loop) ≤ D<sub>min</sub> + 2 mm,
   where d is the edge-graph geodesic distance and D<sub>min</sub> is the shortest such path. This is an
   elliptical band, about 10–12 mm wide, around the shortest LIPV-to-lateral-annulus line.
4. **Mitral annulus.** Within 6 mm (geodesic) of the MV opening.
5. **PV antrum.** Within 10 mm (geodesic) of an ostium ring. The vertex goes to the nearest vein's
   antrum (a geodesic Voronoi partition).
6. **Body wall.** Use the dominant component of q = (p − c)/r (the ellipsoid-normalized position):
   - **Lateral:** +q<sub>x</sub>
   - **Septum:** −q<sub>x</sub>
   - **Posterior:** +q<sub>y</sub>
   - **Anterior:** −q<sub>y</sub>
   - **Roof:** +q<sub>z</sub>
   - **Inferior / floor:** −q<sub>z</sub>

   Because rules 1 and 5 take precedence, the "posterior wall" label ends up on the box between the four
   antra.

Geodesic distances come from multi-source Dijkstra on mesh edges. On isotropic meshes this overestimates
the true geodesic distance by ≤ 9 % (`tests/geodesic.test.ts`). An exact fast-marching geodesic will
replace it in M2/M4 where accuracy matters.

### 1.5 Wall thickness

Each vertex stores a wall thickness in mm (`src/core/mesh/thickness.ts`):

1. Start from a per-region default, which can be overridden (table below).
2. Blend region boundaries with 8 Jacobi smoothing passes over the vertex graph.
3. Taper the PV sleeves: thickness × max(0.6, 1 − depth/25 mm).
4. Multiply by (1 + 0.12·(2n − 1)), where n is seeded fractal value noise with a 15 mm feature size.
5. Clamp to [0.5, 4] mm.

| Region | Default (mm) | Region | Default (mm) |
|---|---|---|---|
| Anterior wall | 2.0 | PV sleeves | 1.0 (tapering) |
| Roof | 1.8 | PV antra | 1.6 |
| Posterior wall | 1.5 | LAA | 1.2 |
| Inferior wall | 1.8 | Mitral annulus | 2.6 |
| Septum | 2.0 | Mitral isthmus | 2.4 |
| Lateral wall | 1.9 | | |

These values lie within the roughly 1–3 mm range reported in autopsy and CT series. Those series also
report substantial inter-patient and regional variability:

- PV sleeves are thin (≈ 1 mm) and taper distally (Saito 2000).
- The posterior wall is relatively thin (Platonov 2008).
- The mitral isthmus and the anterior wall are thicker (Wittkampf 2005; Ho 1999; Beinart 2011).

The table gives our defaults. It does **not** quote values from those papers. Wall thickness is used
later for lesion transmurality (M5), fibrosis depth (M2/M3), and EGM attenuation.

### 1.6 Imported meshes

The importer (`src/core/mesh/io/`) reads Wavefront **.obj**, Stanford **.ply** (ASCII or binary, with
scalar vertex properties as point data), and legacy **.vtk** in ASCII encoding (POLYDATA, or
UNSTRUCTURED_GRID with triangle, polygon, or quad cells). Polygons are fan-triangulated, duplicate
vertices are welded, and unreferenced vertices are dropped.

An optional **labels sidecar** (`ostium-labels/1`) supplies:

- `units` (mm, cm, or m);
- an optional 4×4 `transform` into the LPS mm frame;
- a per-vertex `region`, as ids or keys;
- a per-vertex `wallThickness`.

Openings are named from the majority region of their loop vertices. Triangle winding is flipped if the
signed volume is negative. Imported meshes are **not** remeshed: the importer warns when the mean edge is
far from the ~1 mm that the solver is calibrated for.

## 2. Electrophysiology engine
*(planned, M2.)* Monodomain reaction–diffusion on the surface with a cotangent-Laplacian P1 FEM
(lumped mass), Mitchell–Schaeffer ionic model by default, auto-calibrated conduction velocity, and an
eikonal fast-marching mode.

## 3. Catheters and signals
*(planned, M3.)*

## 4. Mapping
*(planned, M4.)*

## 5. Ablation
*(planned, M5.)*

## 6. Pacing and scenarios
*(planned, M6.)*

## 7. Autonomic module and dataset export
*(planned, M7.)*

---

## Known limitations

These apply as of M1.

- **Single surface.** The atrium is a single surface with no wall volume. Wall thickness is a per-vertex
  attribute, not geometry. Transmural effects (lesion depth, fibrosis depth, epicardial structures) are
  modeled phenomenologically, not resolved.
- **Idealized anatomy.**
  - The LA body is an ellipsoid. Real atria have pectinate muscles in the LAA, the left lateral ridge,
    septal folds, and much more shape variation.
  - PV variants (common ostia, right middle veins) are not generated. A smooth-min blend can merge
    ipsilateral antra, but only coincidentally.
- **Imported meshes are not resampled.** Very coarse or very fine imported meshes will need remeshing
  before the M2 solver calibration holds. Projection-based remeshing onto an imported surface is planned.
- **Geodesic error.** Edge-graph Dijkstra overestimates geodesic distance by up to about 9 %. This is
  acceptable for labelling but not for conduction velocity estimates.

## References

1. Botsch M, Kobbelt L. A remeshing approach to multiresolution modeling. *Proc. Eurographics/ACM SIGGRAPH Symposium on Geometry Processing* 2004:185–192.
2. Gibson SFF. Constrained elastic surface nets: generating smooth surfaces from binary segmented data. *MICCAI 1998*, LNCS 1496:888–898.
3. Quílez I. Distance functions; Smooth minimum. iquilezles.org/articles (accessed 2026).
4. Lang RM, Badano LP, Mor-Avi V, et al. Recommendations for cardiac chamber quantification by echocardiography in adults: an update from the ASE and EACVI. *J Am Soc Echocardiogr* 2015;28:1–39.
5. Kato R, Lickfett L, Meininger G, et al. Pulmonary vein anatomy in patients undergoing catheter ablation of atrial fibrillation: lessons learned by use of magnetic resonance imaging. *Circulation* 2003;107:2004–2010.
6. Saito T, Waki K, Becker AE. Left atrial myocardial extension onto pulmonary veins in humans: anatomic observations relevant for atrial arrhythmias. *J Cardiovasc Electrophysiol* 2000;11:888–894.
7. Ho SY, Sánchez-Quintana D, Cabrera JA, Anderson RH. Anatomy of the left atrium: implications for radiofrequency ablation of atrial fibrillation. *J Cardiovasc Electrophysiol* 1999;10:1525–1533.
8. Ho SY, Cabrera JA, Sánchez-Quintana D. Left atrial anatomy revisited. *Circ Arrhythm Electrophysiol* 2012;5:220–228.
9. Beinart R, Abbara S, Blum A, et al. Left atrial wall thickness variability measured by CT scans in patients undergoing pulmonary vein isolation. *J Cardiovasc Electrophysiol* 2011;22:1232–1236.
10. Platonov PG, Ivanov V, Ho SY, Mitrofanova L. Left atrial posterior wall thickness in patients with and without atrial fibrillation: data from 298 consecutive autopsies. *J Cardiovasc Electrophysiol* 2008;19:689–692.
11. Wittkampf FHM, van Oosterhout MF, Loh P, et al. Where to draw the mitral isthmus line in catheter ablation of atrial fibrillation: histological analysis. *Eur Heart J* 2005;26:689–695.

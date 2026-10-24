# Ostium — model documentation

> **Educational simulation — not for clinical use.** Every number here is a modeling choice meant to be
> physiologically plausible for teaching. None of it is validated for clinical decisions.

This document lists every modeling assumption, equation, and parameter in the simulator. Each
milestone adds its own section. Sections marked *(planned)* are not implemented yet.

- [1. Anatomy](#1-anatomy) — implemented (M1)
- [2. Electrophysiology engine](#2-electrophysiology-engine) — implemented (M2)
- [3. Catheters and signals](#3-catheters-and-signals) — implemented (M3)
- [4. Mapping](#4-mapping) — implemented (M4)
- [5. Ablation](#5-ablation) — implemented (M5)
- [6. Pacing and scenarios](#6-pacing-and-scenarios) — implemented (M6)
- [7. Autonomic module and dataset export](#7-autonomic-module-and-dataset-export) — implemented (M7)
- [8. Right atrium and typical flutter](#8-right-atrium-and-typical-flutter-stretch-goal) — implemented (stretch goal)
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

Code lives in `src/core/ep/` (framework-free) and is hosted by `src/engine/` inside a Web Worker.

### 2.1 Monodomain equation and discretization

Transmembrane potential is represented by a normalized variable v ∈ [0, 1], with
Vm = −80 mV + 100 mV · v (§2.2). On the atrial surface S:

∂v/∂t = ∇·(D(x) ∇v) + f_ion(v, g) + I_stim,  with no-flux boundaries at the PV and MV openings.

- **Space (P1 FEM, lumped mass).** For vertex i with lumped area M_i (one third of the incident
  triangle areas):

  M_i dv_i/dt = Σ_j w_ij D_ij (v_j − v_i),  with w_ij = ½ (cot α_ij + cot β_ij)

  This is the cotangent formula (Pinkall & Polthier 1993). Its no-flux (Neumann) condition at open
  boundaries is built into the weak form.
  - Cotangent weights are clamped at 0. On the remeshed atrium none are negative, because the final
    Delaunay flips (§1.3) remove them (`tests/ep-fem.test.ts`).
- **Per-edge diffusivity.** D_ij = D₀ · HM(σ_i, σ_j) · s_ij, where:
  - HM is the harmonic mean;
  - σ is the per-vertex conductivity scale (later also multiplied by a lesion factor);
  - s_ij ∈ {0, 1} is structural coupling (interstitial fibrosis, lesions);
  - D_ij = 0 if either endpoint is inexcitable.
- **Time (Godunov operator splitting; Qu & Garfinkel 1999).** Each step dt runs three sub-steps in
  this order:
  1. Diffusion: n_sub forward-Euler substeps, with n_sub = ⌈dt / Δt_stable⌉.
  2. Stimulus current.
  3. Reaction: forward Euler for v; exact exponential (Rush & Larsen 1978) for gating variables.
- **Stability bound.** Δt_stable = 0.9 · 2/ρ, where ρ is the Gershgorin bound 2·max_i Σ_j w_ij D_ij / M_i.
  With the defaults n_sub = 1 everywhere (Mitchell–Schaeffer: Δt_stable ≈ 0.4 ms at D₀ = 0.51).
- **Activation and repolarization times.** These are recorded where v crosses 0.5 upward and 0.1
  downward, linearly interpolated within the step. They are ground truth, visible only in the
  teacher view and in tests.

Both backends implement exactly this scheme:

- **CPU:** typed arrays in a worker (`solver-cpu.ts`).
- **WebGPU** (`solver-gpu.ts`):
  - One fused compute pass per step: last diffusion substep, stimulus, reaction, and crossing
    detection.
  - Per-step uniforms use dynamic offsets, so a batch of up to 512 steps goes into one command buffer.
  - Storage is packed into the default limit of 8 buffers per stage.
  - Validated against the CPU backend by the browser self-test (`selftest.html`). On the 16.5k-vertex
    LA, activation times agree within 2·10⁻⁴ ms; on the Fenton–Karma sheet, within 0.03 ms.

### 2.2 Ionic models (`IonicModel` interface)

Each model provides a vectorized CPU kernel and a WGSL kernel with an identical update rule.
`apdScale` (per vertex) multiplies the model's repolarization time constant.

**Mitchell–Schaeffer (default; Mitchell & Schaeffer 2003).**

dv/dt = h v²(1−v)/τ_in − v/τ_out

dh/dt = (1−h)/τ_open if v < v_gate, else −h/τ_close

Default parameters: τ_in = 0.3, τ_out = 6, τ_open = 120, τ_close = 130 ms, v_gate = 0.13.
dt = 0.1 ms. Measured against dt = 0.02 ms, CV changes by < 1 % and APD90 and ERP are unchanged.

The analytic maximal APD τ_close ln(τ_out/4τ_in) = 209 ms underestimates the single-cell APD90 by
about 20 %, because the formula ignores the repolarization downstroke.

**Aliev–Panfilov (Aliev & Panfilov 1996).**

du/dτ = k u(1−u)(u−a) − u r

dr/dτ = (ε₀ + μ₁ r/(u+μ₂)) (−r − k u(u−a−1))

Parameters: k = 8, a = 0.15, ε₀ = 0.002, μ₁ = 0.2, μ₂ = 0.3, τ = t/9 ms. dt = 0.05 ms.

**Fenton–Karma 3V (Fenton & Karma 1998).** Uses parameter set 1 of Fenton et al. 2002 as transcribed
here, with τ_w⁺ and τ_r scaled by 0.94 to bring APD90 into the atrial range. dt = 0.05 ms.

- These transcribed values should be **checked against the source** before any research use.
- APD is very sensitive to the scale: 0.85 gives 129 ms and 0.90 gives 169 ms.

### 2.3 Substrate (`Substrate`, `tissue.ts`)

| Field (per vertex) | Meaning |
|---|---|
| `conductivity` σ | multiplies D₀ (CV ∝ √σ) |
| `apdScale` | multiplies the repolarization time constant (ERP/APD heterogeneity; used by the autonomic module in M7) |
| `fibrosisDensity` 0..1 | expected fraction of affected nodes (diffuse, patchy) or edges (interstitial) |
| `fibrosisDepth` 0..1 | transmural extent; default 0.3 + 0.7·density where fibrotic. Used for EGM attenuation (M3). |
| `lesionCore`, `lesionConductivity` | written by ablation (M5) |

**Fibrosis patterns** (`tests/ep-substrate.test.ts`):

- **Diffuse:** each node becomes fibrotic independently with probability = density.
- **Patchy:** seeded fractal value noise (feature size 6 mm) is rank-transformed to a uniform
  percentile. A node is fibrotic where its percentile < the local density. This produces clustered
  patches whose local area fraction tracks the density field. The realized fraction is within ±3 % of
  the target.
- **Interstitial:** each edge is uncoupled with probability min(1, 2ρ sin²φ), where φ is its angle
  to the local fibre direction. Transverse coupling is lost; nodes stay excitable.

Fibrotic nodes are **inexcitable and electrically isolated**: all incident edges have zero conductance.
This "structural block" representation follows common discrete-fibrosis atrial models.

**Fibre field.** The direction is circumferential around each PV within 12 mm of the ostium, and
otherwise horizontal-circumferential. It is used only for interstitial fibrosis; conduction is
isotropic (see limitations).

**Tissue presets.** Values were measured by the tissue lab on a flat strip at h = 0.955 mm (S1 = 600 ms):

| Preset | Ionic parameters | dt (ms) | Target CV (m/s) | D₀ (mm²/ms) | Measured CV | APD90 (ms) | ERP (ms) | Shortest S2: DI / APD90 / CV | λ = CV·APD90 (cm) |
|---|---|---|---|---|---|---|---|---|---|
| Healthy | MS, τ_close 130, τ_open 120 | 0.1 | 0.75 | 0.515 | 0.750 | 251 | 260 | 67 / 157 / 0.41 | 18.8 |
| Paroxysmal | MS, τ_close 95, τ_open 110; 5 % patchy fibrosis | 0.1 | 0.70 | 0.454 | 0.700 | 190 | 210 | 67 / 125 / 0.40 | 13.3 |
| Persistent | MS, τ_close 55, τ_open 90; 20 % patchy fibrosis | 0.1 | 0.50 | 0.243 | 0.500 | 120 | 140 | 69 / 88 / 0.32 | 6.0 |
| (alt.) Aliev–Panfilov | defaults | 0.05 | 0.75 | 2.55 | 0.748 | 221 | 320 | 205 / 94 / 0.64 | 16.5 |
| (alt.) Fenton–Karma | set 1, scale 0.94 | 0.05 | 0.75 | 0.327 | 0.748 | 209 | 210 | 20 / 154 / 0.56 | 15.6 |

How the presets map to the literature:

- **Healthy CV.** 0.75 m/s lies in the commonly cited range of about 0.6–1.0 m/s for atrial myocardium
  (Dössel et al. 2012).
- **Remodeled presets.** These reproduce the qualitative effects of AF-induced electrical remodeling:
  shortened APD and ERP, with loss of rate adaptation (Wijffels et al. 1995).
- **Wavelength.** The wavelength concept (Rensma et al. 1988) explains why rotors need the persistent
  substrate: λ ≈ 6 cm fits on the atrium, while λ ≈ 19 cm does not.
- **Fibrosis distribution.** The posterior wall and antra are weighted up (×1.3–1.8). These weights
  are an educational choice, not fitted to imaging data.

**Anatomical reentry in healthy tissue.** Macro-reentry around a large obstacle still sustains with
healthy parameters, because APD shortens at short diastolic intervals. The ring tests show this for a
12.6 cm circuit with cycle length ≈ 260 ms, which is consistent with flutter occurring in
non-remodeled atria.

### 2.4 Calibration and measurement tools (`calibrate.ts`)

All measurements use a 40 × 5 mm equilateral-lattice strip with the same edge length as the atrial
mesh.

- **CV.** A plane wave from the left edge; CV is measured between x = L/4 and 3L/4, averaging all
  vertices in each column.
- **APD90.** Time from the 0.5 upward crossing to the 0.1 downward crossing, at the strip centre.
- **Auto-calibration.** D ← D·(CV_target/CV)², which follows from the near-square-root scaling
  CV ∝ √D. It converges to < 0.5 % in 3 iterations. Calibration absorbs the remaining discretization
  error of the lattice, so the target CV holds at h ≈ 1 mm.
- **Restitution (S1–S2).**
  - Six S1 beats at 600 ms are delivered. The state is snapshotted 5 ms after the last S1, then each S2
    is replayed from that snapshot.
  - DI is the S2 activation time minus the S1 repolarization time, at the strip centre.
  - ERP is the longest S1–S2 coupling interval that fails to propagate (10 ms steps).
- **Checked on the atrium.** The median local CV, computed from per-triangle activation gradients
  (`cv.ts`, CV = 1/|∇T|), is within 15 % of the target. Lattice isotropy (x vs y) is within 10 %.

### 2.5 Sinus rhythm

The right atrium is not modelled, so left-atrial breakthroughs are driven directly at the sinus cycle
length (default 800 ms). There are three sites, each a 4 mm-radius vertex patch:

| Site | Location | Delay |
|---|---|---|
| Bachmann's bundle | anterosuperior septal roof | 0 ms |
| Fossa-ovalis region | mid septum | +15 ms |
| Coronary-sinus musculature | inferior septum near the annulus | +30 ms |

This sequence follows the principal LA input routes described in endocardial and epicardial mapping
studies (Markides et al. 2003; Lemery et al. 2007). The delays are representative values chosen here.

Resulting activation, which is checked by tests:

| Substrate | Total LA activation | Earliest site | Latest region |
|---|---|---|---|
| Healthy | ≈ 113–115 ms | BB patch | lateral wall / LAA / left inferior vein |
| Persistent | ≈ 190 ms | — | — |

### 2.6 Eikonal mode (`eikonal.ts`)

This mode solves |∇T| = 1/F with fast marching on triangles (Kimmel & Sethian 1998).

- **Triangle update.** Solve the quadratic for T_C from the linear interpolant, accepted only if the
  characteristic enters through the triangle; otherwise use edge updates.
- **Sources.** The two vertex rings around each source are initialized with straight-line times. This
  removes most of the first-order source error: < 3 % on a flat sheet.
- **Speed.** F = CV_target · √σ, zero at inexcitable nodes. Uncoupled interstitial edges are
  approximated by slowing each node in proportion to its fraction of removed edges.
- **Agreement with reaction–diffusion** in sinus rhythm (16.5k vertices):

  | Substrate | Pearson r | Mean absolute difference |
  |---|---|---|
  | Healthy | 0.9998 | 2.1 ms |
  | Persistent | 0.9989 | 6.7 ms |

  Run time is 0.1–0.3 s.
- **Voltage display.** For animation and later EGMs, Vm(t) is synthesized as
  template(t − T_i mod CL), using a single-cell action-potential template from the active ionic
  model. Eikonal mode cannot represent reentry, refractoriness interactions, or pacing; use
  reaction–diffusion for those.

### 2.7 Simulation clock

Simulation time is independent of wall time. A scheduler tick spends up to 30 ms of wall time
advancing the simulation in sub-chunks:

- The sub-chunk size adapts so each costs 5–15 ms.
- With a speed target, only the time owed is advanced (speed × elapsed wall time, capped at 50 ms).
- Frames are posted at ≤ 30 Hz.
- The displayed speed is measured over 0.5 s windows: simulated ms per wall ms.
- Pause and single-step (+10 ms) are exact: whole time steps.

Measured throughput on the 16.5k-vertex LA:

| Environment | Speed |
|---|---|
| CPU backend in Node | ≈ 0.13× real time |
| CPU in a browser worker in this development container | ≈ 0.03–0.06× |
| WebGPU on SwiftShader (software emulation) | ≈ 0.03× |

The WebGPU target is ≥ 0.25× on a real GPU. It must be checked with `selftest.html` on real
hardware; the container has no GPU.

## 3. Catheters and signals

Code: `src/core/signals/` (lead fields, filters, noise, recording, detection), `src/core/catheter/`
(CS and roving geometry, motion, surface navigation), and `src/render/catheters.ts` (graphics only).

### 3.1 Extracellular potentials: dipole-source lead fields

In an infinite homogeneous volume conductor, the extracellular potential at an electrode at x is a
sum of current dipoles p = −σ_i ∇Vm:

φ(x) = −K ∫ ∇Vm(y) · ∇_y(1/|x − y|) dV = −K ∫ ∇Vm(y) · (x − y)/|x − y|³ dV,  with K = σ_i / (4π σ_e).

- **Per-triangle sources.** ∇Vm is constant on each P1 triangle. Each triangle is one dipole source:
  - Location: at mid-wall, y = centroid + n·t/2, where n is the outward (epicardial) normal and t
    the mean wall thickness of the triangle.
  - Volume: area × viable thickness × source scale, where viable thickness = t·(1 − fibrosis depth).
  - Zero volume if any corner is inexcitable: no intracellular coupling crosses a fibrotic node or a
    lesion core, so scar produces no impressed current.
- **Lead fields.** ∇Vm on a triangle is Σ_k Vm_k ∇φ_k (barycentric basis gradients), so the
  potential is linear in the vertex potentials: **φ(x) = Σ_k c_k(x) v_k**. Each electrode gets a
  precomputed sparse lead-field vector c.
  - Vm = −80 + 100·v mV; the constant offset has no gradient.
  - Sampling an electrogram is a sparse dot product. The CPU backend runs it inside the solver loop;
    on WebGPU a reduction kernel runs once per sample in the same command buffer, so no voltage
    readback is needed.
  - The two backends agree within 2.4·10⁻⁵ mV against signals peaking at 2 mV (`selftest.html`).
- **Constants.** σ_i = 0.17 S/m (longitudinal intracellular conductivity; Clerc 1976) and
  σ_blood = 0.7 S/m (Geddes & Baker 1967), so **K = 0.019** for intracardiac electrodes.
  - Contributions are summed over triangles within a **30 mm cutoff** of the electrode, as the spec
    requires; this truncates part of the distant far field.
  - Body-surface electrodes use σ_torso = 0.2 S/m, no cutoff, and a lumped `TORSO_GAIN` of 2.5
    (§3.4).
- **Checks** (`tests/signals.test.ts`):
  - Lead fields equal an independently computed dipole sum.
  - An approaching wavefront gives positive potential and a receding one negative.
  - Inexcitable tissue contributes nothing.
- **Sampling.** Electrograms are sampled at **2 kHz** (every 5 steps at dt = 0.1 ms). In eikonal
  mode, the same lead fields are applied to Vm synthesized from the action-potential template.
  - The ECG and CS electrodes are fixed, so their signals for one sinus cycle are precomputed and
    replayed.
  - The roving catheter's signals are evaluated per sample.

### 3.2 Catheters

**CS reference (decapolar).** The catheter is built from the mitral-annulus loop:

- The centreline runs in the annulus plane, displaced 5 mm radially outward and 6 mm towards the
  atrium.
- Every point is pushed outside the epicardium of the nearest wall: wall thickness + 1.5 mm.
- The arc runs from the posteroseptal side (CS ostium, 55° septal from the posterior-inferior
  direction) round the inferior/posterior annulus towards the lateral wall.
- Electrodes are placed by arc length with **2-8-2 mm** spacing. CS 10 is proximal and septal;
  CS 1 is distal and lateral.
- Bipoles are CS 9-10 … CS 1-2.

**Roving catheter.** A 3.5 mm tip and three 1 mm rings, with selectable edge-to-edge spacing
(default 2-5-2 mm; also 1-6-1, 2-2-2, 1-4-1). Diameter is 2.4 mm.

- **Placement:** click or shift-drag onto the shell (raycast to the nearest vertex). Arrow keys walk
  2 mm (0.5 mm with Shift) across the surface in the screen direction. `[` and `]` change force by
  5 g.
- **Axis:** tilted from the inward normal by the contact angle (0° perpendicular, 90° parallel),
  towards an azimuth in the tangent plane.
- **Contact model:** the gap between the tip end and the tissue is g(F) = 3 mm · e^(−F/4 g). That
  is 3 mm when floating, 0.9 mm at 5 g, and under 0.05 mm at 20 g. A tilted tip touches with its
  edge, so it is lifted by r·sin θ.
  - Electrode centres lie along the axis. With good perpendicular contact the tip electrode centre
    is about 1.75 mm from the endocardium, and about 1.2 mm when parallel.
  - The 30 mm cutoff and mid-wall sources give the expected behaviour: poor contact lowers local
    amplitude and relatively increases far-field content (floating vs 15 g: bipolar 0.62 vs
    1.62 mV).
- **Motion and stability (phenomenological).** The tip is displaced by:
  - a cardiac component at the sinus cycle length, amplitude 1.2·e^(−F/20) + 0.2 mm;
  - a respiratory component (0.25 Hz), amplitude 2.0·e^(−F/15) + 0.3 mm;
  - Ornstein–Uhlenbeck drift (τ 2 s, SD 0.6·e^(−F/15) + 0.1 mm).

  Force fluctuates by ±30 % (cardiac) and ±15 % (respiratory), plus OU noise (τ 0.5 s). The pose and
  the roving lead fields are updated every **20 ms** of simulated time.
- **Stability readout.** The SD of tip position over the last second, and the force mean and range.
  "Stable" means SD < 1 mm and force within 5–40 g throughout. M4 auto-acquisition will use the same
  criteria.

### 3.3 Recording chain

Each processing step is applied in this order, mirroring an EP amplifier (`recording.ts`):

1. **Artifacts**, added to each electrode's raw potential (`noise.ts`):
   - Mains interference (50 or 60 Hz): 0.15 mV common-mode, with a 3 % per-electrode amplitude
     mismatch and ±0.02 rad phase spread.
   - Baseline wander: 0.3 mV, mostly at 0.25 Hz respiration.
   - Colored noise: an AR(2) process, coefficients (1.2, −0.36), SD 0.012 mV.

   Body-surface electrodes get 10 % of these amplitudes.
2. **Referencing.**
   - Bipolar channels are electrode differences: MAP 1-2, MAP 3-4, CS pairs.
   - Unipolar channels and V1 are referenced to the Wilson central terminal, (RA + LA + LL)/3.
   - Limb leads: I = LA − RA, II = LL − RA.

   Because mains pickup is nearly common-mode, the bipolar residual is < 15 % of the unipolar
   (tested).
3. **Causal band-pass filters.** Each is a 2nd-order Butterworth high-pass and low-pass, each applied
   twice (4th order; −6 dB at each corner).
   - Defaults: **bipolar 30–500 Hz**, **unipolar 1–240 Hz**, ECG 0.5–100 Hz.
   - An optional mains notch (Q = 30) is available.
   - All corners are adjustable in the Signals panel.

### 3.4 Surface ECG

Electrodes sit at fixed torso points relative to the LA (LPS mm):

| Electrode | Position |
|---|---|
| RA | (−260, −60, 220) |
| LA | (260, −60, 220) |
| LL | (90, −60, −420) |
| V1 | (−35, −150, 10) |

The potentials are computed in an infinite homogeneous medium (σ = 0.2 S/m) with a lumped gain of
2.5. The gain stands in for the missing right atrium and torso inhomogeneity; it is an educational
calibration, not a forward model.

Result in sinus rhythm: the LA component in lead II is ≈ 0.05 mV peak-to-peak, and V1 has a
terminal negative deflection (≈ −0.11 mV), the left-atrial signature.

### 3.5 EGM panel

- **Channels**, top to bottom: I, II, V1; CS 9-10 → CS 1-2; MAP 1-2, MAP 3-4; MAP 1 and MAP 2
  unipolar.
- **Sweep speed:** 25 / 50 / 100 / 200 mm/s, at 96 CSS px per inch.
- **Gains:** per group, in mm/mV. Defaults: ECG 60, CS 6, MAP bipolar 6, unipolar 3.
- **Drawing:** each pixel column shows the min/max of its samples, so spikes are never aliased away.
- **Freeze** stops the sweep. **Calipers:** drag on the traces to read Δt and rate; click to clear.
- **Cycle length:** the median of the last six intervals between activations on a selectable CS
  reference bipole.
  - Activations are detected as local maxima of |x| above 40 % of the 6 s peak, with a 120 ms
    refractory window.

### 3.6 Validation

Checked by `tests/egm.test.ts` on reaction–diffusion sinus beats:

| Check | Result |
|---|---|
| Healthy bipolar amplitude | 1.4–1.7 mV at posterior, anterior and lateral sites (normal is > 0.5 mV) |
| Bipolar in scar | 70 % diffuse fibrosis on the posterior wall drops the same sites to 0.14–0.23 mV, 10–16 % of healthy. Anterior sites in the same atrium change by < 25 %. |
| Persistent-AF substrate | median bipolar 1.06 vs 1.72 mV healthy |
| Unipolar morphology | **QS** at the earliest site (Bachmann's bundle): −2.46 mV with ≤ +0.16 mV positive. **RS** where the wave passes the lateral wall: +1.50 / −0.64 mV, R before S. |
| CS activation sequence | proximal → distal in sinus rhythm (CS 9-10 ≈ 50 ms, CS 1-2 ≈ 95 ms after onset) |

## 4. Mapping

Code: `src/core/mapping/` (annotation, session, interpolation, types), `src/core/signals/beats.ts`
(reference beats), `src/core/catheter/grid.ts`, and `src/ui/map-compute.ts` (colours, CV arrows).

**Ground-truth firewall.** The mapping module sees only what a recording system provides:
electrogram windows aligned to a reference, plus catheter positions and readouts. It never reads
simulated voltages or activation times. A test fails if any file in `src/core/mapping/` imports
anything outside the mesh, math, filter, or detection utilities. Ground truth is used only by tests
and the teacher view.

### 4.1 Mapping catheters

- **Ablation catheter (4-pole):** one point per beat, taken at the tip end. LAT comes from the tip
  unipolar (MAP 1); voltage from the distal bipole (MAP 1-2).
- **HD grid (generic, 16 electrodes):**
  - Electrodes: 4 × 4, 1 mm each, 3 mm centre to centre.
  - Placement: the grid lies flat in the tangent plane at the contact point, oriented by the
    "direction" control. Each electrode snaps to the nearest surface vertex of its in-plane position
    and sits off the wall by the contact gap plus 0.6 mm.
  - Signals: each electrode yields one point per beat, with its own unipolar signal and a bipolar
    signal formed with its row neighbour (the last column pairs backwards).
  - Lead fields: grid electrodes use a 20 mm cutoff instead of 30 mm. Being in contact, their near
    field dominates, and 16 moving lead fields stay affordable.

### 4.2 Reference beats and acquisition

The recording system (worker) detects the **reference** on a selectable CS bipole (default CS 7-8):

- A sample is a candidate when |x| ≥ 40 % of the peak over the last 3 s (from 100 ms block maxima).
- A candidate is confirmed after 15 ms with no larger value, with a 150 ms refractory window.

For each reference it sends a **beat window**:

- Content: ±350 ms of the reference, ECG II, and every mapping electrode's filtered unipolar and
  bipolar signal.
- Catheter state at that moment: electrode positions, force, and stability.
- Cycle length: the interval from the previous reference.

**Settling rule.** After the catheter is relocated, or its type changed, it counts as unstable for
**1 s** of simulated time. That is longer than a 700 ms window, so no window can mix signals from two
sites.

**Manual acquisition** (button or `P`) takes every electrode of the latest beat.

**Auto-acquisition** takes only electrodes that pass all of these (defaults, adjustable):

| Criterion | Default |
|---|---|
| Catheter settled | required |
| Tip-position SD over the last second | ≤ 1 mm |
| Contact force throughout the last second | 5–40 g |
| Beat CL vs reference CL (median of the last 8 beats) | within ±10 % |
| Distance from the shell | ≤ 6 mm (projection cutoff) |
| Distance from existing points | ≥ 2 mm |

Each point is stored with its location, nearest shell vertex, projection distance, force, stability,
CL, and its electrogram window. Re-annotation is always possible later.

### 4.3 Annotation

All times are relative to the reference, refined to the peak |ref| within ±20 ms of the nominal
reference.

- **Window of interest (WOI):** default −100 to +150 ms relative to the reference (adjustable). Only
  samples inside it are annotated.
- **LAT, default method:** the time of the steepest negative unipolar slope, max(−dV/dt), within the
  WOI. The slope is the 5-point derivative
  (−u_{i+2} + 8u_{i+1} − 8u_{i−1} + u_{i−2}) / (12 Δt) at 2 kHz, refined to sub-sample precision by
  a parabola.
- **LAT, optional method:** the time of peak |bipolar| within the WOI.
- **Voltages:** bipolar and unipolar peak-to-peak within the WOI.
- **Deflections:** alternating extrema of the bipolar signal, counted with hysteresis
  h = max(10 % of bipolar peak-to-peak, 0.03 mV).
- **Fractionation and double potentials.** Activity is the set of samples with |bip| above 15 % of
  its peak.
  - **Fractionated:** ≥ 6 deflections, or ≥ 50 ms of activity.
  - **Double potential:** exactly two activity clusters, each ≥ 30 % of the maximum, separated by an
    isoelectric gap of ≥ 30 ms.

  These are simple, documented heuristics, not a vendor algorithm.
- **Manual re-annotation:** click the point's electrogram in the inspector. The automatic annotation
  is kept, and *Auto LAT* restores it. Changing the WOI or method re-annotates every automatic point.
- **Point list:** points can be tagged (`scar`, `review`, `gap`), excluded, or deleted, with undo
  (Ctrl+Z).

### 4.4 Interpolation

Inverse-distance weighting over **geodesic** distance:

v(i) = Σ_p w_p v_p / Σ_p w_p,  with w_p = 1/(d_g(i, p) + 0.5 mm)²

The sum runs over points with d_g ≤ the **fill threshold** (default 12 mm). Vertices beyond every
point's fill radius stay gray ("no data").

- **Geodesic distances:** each point's local distance field comes from truncated fast marching
  (`GeodesicFmm`, unit speed; §2.6). It starts from the catheter location projected onto the tangent
  plane of the nearest vertex, and is cached per point.
- **Excluded from maps:** points farther than the **projection cutoff** (default 6 mm) from the
  shell, and user-excluded points. Both are drawn as small gray markers.
- **Colour ranges:**
  - LAT: automatic range = 2nd–98th percentile of point LATs (robust to stray points); can be set
    manually.
  - Bipolar voltage: gray below the scar threshold, red → purple up to the normal threshold, purple
    above. Defaults are 0.1 / 0.5 mV, the commonly used atrial dense-scar and low-voltage cut-offs
    (e.g. Rolf et al. 2014).
  - Unipolar voltage: defaults 0.5 / 2.5 mV. This is an educational choice; atrial unipolar
    thresholds are less standardized.
  - Fractionation: the deflection count, purple (≤ 2) → red (≥ 8).

### 4.5 Derived displays

- **Conduction-velocity vectors.** The gradient of the interpolated LAT on each triangle gives
  direction and speed (CV = 1/|∇T|), shown as arrows.
  - Thinned to about one arrow per 5 mm cell.
  - Only 0.05–2.5 m/s is shown. Higher apparent speeds occur at breakthroughs and wavefront
    collisions.
- **Propagation.** The interpolated LAT map is dimmed, and a bright band sweeps through the LAT
  range (2.5 s per cycle), marking vertices activated within the last 15 ms of the phase.
- **Anatomy build.** The shell is revealed only where the catheter electrodes have passed (within
  7 mm), imitating catheter-based geometry acquisition. The underlying mesh is the procedural one;
  the geometry is not reconstructed from catheter positions.

### 4.6 Validation

`tests/mapping.test.ts`:

- **Annotation (synthetic):**
  - LAT within ±0.5 ms (unipolar) and ±2.5 ms (bipolar peak).
  - WOI respected.
  - Double potentials and fractionation detected; normal electrograms are not flagged.
- **Interpolation:** reproduces a linear field between points; vertices beyond the fill threshold
  stay unmapped.
- **Session:** each auto-acquire filter rejects what it should, and manual acquire bypasses them.
  Re-annotation, tags, delete, undo, and WOI changes all work.
- **Dense map vs ground truth.** One reaction–diffusion sinus beat, with 250 ablation-catheter sites
  from farthest-point sampling, the full noise and filter chain, CS 7-8 reference, and fill 15 mm.
  It maps 100 % of the surface:

  | Measure | Result | Requirement |
  |---|---|---|
  | Interpolated LAT vs true activation | **r = 0.998** | r > 0.95 |
  | Earliest mapped site to the true origin | **2.6 mm** | ≤ 5 mm |
  | Bipolar-peak annotation | r = 0.994 | — |
- **End to end** (engine beat windows → auto-acquisition):
  - Beats spanning a relocation are refused.
  - Ablation-catheter LAT errors against eikonal ground truth: median < 2 ms, maximum < 6 ms.
  - Grid catheter, 640 points (manual run): median 0.5 ms, maximum 1.7 ms.

## 5. Ablation

Code: `src/core/ablation/` (`lesion.ts`, `rf.ts`, `controller.ts`, `esophagus.ts`, `rings.ts`), wired
into the engine in `src/engine/engine.ts`. The lesion model is **empirical and phenomenological**. It
reproduces the qualitative dependences reported in ex-vivo and clinical studies [30–34], not a
thermal (bioheat) simulation. Every constant below is configurable in `DEFAULT_LESION_MODEL` and
`RF_CONSTANTS`.

### 5.1 Lesion size

Contact force couples power into tissue through a saturating factor. The delivered dose is the
coupled energy:

  c(F) = 1 − exp(−F / F_c)                    F_c = 10 g
  E = ∫ P(t) · c(F(t)) dt                     (J; F(t) is the live, motion-modulated force)

Depth and diameter saturate with dose. Higher power widens the lesion more than it deepens it, a
qualitative high-power short-duration effect [33]:

  D = D_max · (1 − exp(−E / E_D))                      D_max = 6 mm, E_D = 900 J
  W = W_max · (1 − exp(−E · √(P / P_ref) / E_W))      W_max = 10 mm, E_W = 600 J, P_ref = 30 W

| Settings | Depth | Diameter |
|---|---|---|
| 30 W · 30 s · 15 g | 3.2 mm | 6.9 mm |
| 35 W · 20 s · 15 g | 2.7 mm | 6.2 mm |
| 50 W · 6 s · 15 g | 1.4 mm | 3.9 mm |
| 30 W · 30 s · 3 g | 1.4 mm | 3.2 mm |

Low force (< 5 g) gives small, often non-transmural lesions, which matches the association between
low contact force and PV reconnection [31, 32].

### 5.2 RF readouts and the lesion quality index

- **Force–time integral** FTI = ∫ F dt (g·s) [30].
- **Impedance.** Baseline Z₀ = 110 Ω − 0.3 Ω/g · min(F, 30). It drops as
  ΔZ = 15 Ω · (1 − exp(−E / 350 J)), so a good lesion shows a 10–15 Ω fall, the usual clinical range.
- **Lesion quality index (LQI).** An open index of our own: **LQI = 10 · D / t_wall**, where D is
  the predicted depth from §5.1 and t_wall is the local wall thickness. LQI 10 means the predicted
  lesion is just transmural. Because D comes from coupled energy, the index combines power, time and
  force. It is deliberately different from proprietary indices [35] and is not calibrated to them.
- **Lesion tags** are coloured by LQI: green ≥ 10, amber 8–10, red < 8.

### 5.3 Lesion raster and tissue effect

Each lesion is an oblate half-ellipsoid of radius R = W/2 and depth D, centred on the contact
vertex. At geodesic surface distance s from the centre (truncated fast marching, §4.4), its depth is
d(s) = D · √(1 − (s/R)²). Each vertex v, with wall thickness t_v, falls into one of these zones:

| Zone | Condition | Conductivity σ | EGM source | Excitable |
|---|---|---|---|---|
| Transmural core | d(s) ≥ t_v | 0 | 0 | no |
| Partial thickness | 0 < d(s) < t_v | × (1 − 0.6·d/t) | × (1 − d/t) | yes |
| Border | R < s ≤ R + 2 mm | × 0.6 | × 0.8 | yes |

Overlapping lesions take the most severe value at each vertex. Cores set `Substrate.lesionCore`
(isolating the node like fibrosis, §2.3), and the σ factor multiplies `lesionConductivity`. The
engine then updates the solver's edge diffusivities and excitability, recomputes the eikonal map,
and rebuilds the EGM lead fields with the source factor, so electrograms over ablated tissue shrink
or disappear.

- **Transmurality is decided per vertex.** A ring blocks only where the cores join into a closed
  barrier. Non-transmural segments leave a conducting isthmus, so gaps and later reconnection
  emerge from the same physics as block.
- **Growth.** In reaction–diffusion mode, the lesion is re-rasterized every 2 s of RF while it grows.
  In eikonal mode, it is re-rasterized when the application ends.
- **Interlesion distance.** The centre-to-centre distance to the previous lesion is shown. Distances
  above the gap threshold (default 6 mm [34]) are flagged and drawn as red segments. A jump of more
  than 20 mm counts as the start of a new lesion set, not a gap.

### 5.4 Edema (optional)

Reversible injury around a fresh lesion can produce acute block that is later lost [36]. While
edema is active, R grows by 2 mm and D by × 1.5, so a marginal lesion can be transiently
transmural. Edema resolves after a configurable simulated time (default 30 s, compressed for
teaching; in reality it lasts tens of minutes or more). At that point the lesion set is
re-rasterized. Lesions survive a tissue rebuild, and their remaining edema time is preserved.

### 5.5 RF clock

Real RF applications last 5–60 s. At reaction–diffusion speeds that would mean minutes of waiting,
so the RF clock runs at a configurable multiple of simulated time (1–20×, default 10×). The
**Instant** option delivers the whole application at once at the set force. The scaling is
labelled in the UI as an educational simplification. RF stops when the catheter is moved or the
catheter type changes.

### 5.6 Esophagus

The esophagus is a vertical tube of radius 6 mm, 2 mm behind the posterior epicardium. Its lateral
position is seeded at x = (0.12 ± 0.08) · r_x, usually slightly left of the midline [37]. Posterior,
inferior, roof and antral vertices facing posteriorly (n_y > 0.5) within 9 mm of its axis form the
**esophageal zone**.

During RF in the zone, the luminal temperature is estimated as:

  T = 37 °C + 0.11 · P · c(F) · exp(−g / 1.2 mm) · (1 − exp(−t / 12 s))
  g = max(0, t_wall + 2 mm − D)                  (tissue left between the lesion and the lumen)

A warning appears at 39 °C, within the 38.5–39 °C range used in clinical luminal-temperature
monitoring [38]. With a 1.5 mm posterior wall and 15 g, a 40 W application crosses the warning after about 20 s,
while 20–25 W applications of 10 s stay below it.

### 5.7 Validation

`tests/ablation.test.ts`:

- **Lesion size and readouts.**
  - Size is monotonic in power, time and force, and saturates.
  - Standard settings give 2.5–4.5 mm depth and 5–8.5 mm diameter.
  - Impedance falls monotonically, FTI integrates force exactly, and the esophageal warning
    triggers only at high power in the zone.
- **Interlesion distances.** A 4 mm-spaced ring raises no gap warning; removing two lesions does.
- **Conduction (reaction–diffusion, healthy LA).** A 30-lesion ring placed 5 mm outside the LSPV
  ostium is tested with sinus rhythm and with pacing inside the vein:

  | Lesion set | Result |
  |---|---|
  | Complete ring, 35 W · 20 s · 15 g (LQI ≈ 16) | **Entrance block** (0 % of the LSPV sleeve activated) and **exit block** (0 % of the LA body activated by pacing inside the vein) |
  | Same ring, two lesions removed (≈ 12 mm gap) | Conduction preserved (> 95 % of the sleeve activated) |
  | Low force, 20 W · 10 s · 3 g (LQI < 10) | No transmural core; conduction preserved |
  | Marginal ring with edema, 25 W · 16 s · 10 g | Acute block, then reconnection after the edema resolves |
- **Engine.** RF on the accelerated clock reports live readouts, ends at the set duration, and
  updates the lesion list. A ring completed with instant applications removes the vein from the
  eikonal activation map. Resetting lesions restores the tissue.

## 6. Pacing and scenarios

Code: `src/core/pacing/` (`capture.ts`, `protocols.ts`, `analysis.ts`), `src/core/scenarios/`
(`scenarios.ts`, `topology.ts`, `geometry.ts`, `report.ts`), and the engine runtime in
`src/engine/drivers.ts` and `src/engine/case.ts`.

Pacing, ectopy and arrhythmias need the reaction–diffusion engine. The eikonal mode remains a
sinus-rhythm-only map generator.

### 6.1 Pacing

**Sites.** Pacing can be delivered from:

- the ablation catheter tip (cathode = tip electrode);
- CS 1-2 (cathode CS 1, distal/lateral);
- CS 9-10 (cathode CS 9, proximal/septal).

**Capture model** (phenomenological). Current density from a small cathode falls roughly as
1/r² [27]. The threshold therefore rises with the electrode–tissue gap d and falls with the viable
fraction v of the myocardium under the electrode (mean over 1.5 mm):

  I_th(d) = I₀ · (1 + (d / d₀)²) / v           I₀ = 0.4 mA, d₀ = 1 mm (2 ms pulse)

- **Gap.** For the tip, d is the contact gap of §3.2 (3 mm at 0 g, 0.25 mm at 10 g). For the CS
  electrodes it is their distance to the nearest endocardial vertex minus the catheter radius,
  so CS pacing needs a few mA.
- **Viable fraction.** v is 0 over lesion cores and fibrotic nodes, so dense scar never captures.
  Partial-thickness lesions raise the threshold.
- **Above threshold:**
  - vertices within r = 1.5 mm · √(I/I_th) (≤ 5 mm) receive a 2 ms current pulse;
  - the pulse amplitude scales with √(I/I_th), so a higher output captures earlier in the relative
    refractory period.
- **Propagation.** Whether a stimulus propagates is decided by the tissue state in the solver, so
  loss of capture in refractory tissue, latency and fusion all emerge.
- **Motion.** The tip footprint is updated with catheter motion every 20 ms.

**Protocols.** Each one is converted to stimulus trains:

| Protocol | Delivery |
|---|---|
| Fixed rate | Continuous, or N beats |
| Burst | N beats at a short cycle length |
| S1–S2 | N S1 beats, then a premature S2 (and optional S3) |
| Entrainment | N beats, then a post-pacing-interval measurement |

Stimulus markers are drawn on the EGM panel. There is no stimulus artifact on the signals.

**Measurements** (recorded, filtered electrograms only). Each stimulus is analysed once 400 ms of
signal after it has been recorded. The median over the three most recent paced beats is reported;
the first two beats of a long train are skipped while it settles.

- **Stimulus-to-electrogram interval.** For every CS bipole and the ablation catheter's bipoles:
  the first local maximum of |x| above max(0.05 mV, 0.3 × the window peak), within [4 ms,
  min(400 ms, CL − 5 ms)] after the stimulus. The distance from the cathode to each bipole is
  reported alongside.
- **Local capture.** Either the neighbouring bipole (MAP 3-4, CS 3-4 or CS 7-8) activates within
  60 ms, or the pacing bipole itself shows an electrogram within 3–30 ms. The second check is
  possible only because no stimulus artifact is simulated.
- **CS follows 1:1** (tip pacing). Every recent stimulus is followed by an activation on the CS
  reference within the pacing cycle. Local capture without CS follow is **exit block** [43].
- **Entrainment.**
  - TCL is the median CS-reference cycle length over the 3 s before pacing.
  - PPI is the time from the last stimulus to the first activation on the pacing bipole. The search
    starts max(80 ms, half the pacing CL) after the stimulus: the paced site was just captured and
    is refractory, so earlier deflections belong to the last captured beat.
  - PPI − TCL ≤ 30 ms marks a site in the circuit [39, 40].

Measured on the perimitral case (seed 1, TCL 276 ms):

| Pacing site | PPI − TCL |
|---|---|
| Annulus | 4 ms |
| Septum | 57 ms |
| LAA tip | 108 ms |

**Sinus node with reset.** The LA breakthrough sites (§2.5) are driven by a sinus "node". The next
beat is due one sinus cycle after the last activation of the Bachmann-bundle site, whatever
caused that activation [44]. Faster rhythms (tachycardia or pacing) therefore suppress sinus
beats, and sinus rhythm resumes when they stop. Activation is read by a **probe**: an internal
lead-field row of weight 1 at one vertex, sampled at 2 kHz with the electrograms. Probes are
hidden-state sensors used only by the rhythm drivers and for ground truth, never shown as
signals.

**Ectopic sources.**

- **Automatic foci** fire at their own cycle length and are reset in the same way as the sinus
  node.
- **Triggered sources** (PV triggers) fire runs of 3–8 beats at 170–230 ms, every 3.5–8 s
  (seeded) [45].
- A source is **eliminated** once ≥ 50 % of its vertices lie in a lesion core. Edema can suppress
  it temporarily. An isolated source keeps firing but cannot exit.

**Cardioversion** resets every cell to the resting state. Sinus rhythm resumes 300 ms later.

### 6.2 Scenarios

Each scenario derives its ground truth from a seed (`buildScenario`). The case information shown
to the learner (presentation, goal, criteria) contains no ground truth. Lesions from a previous
procedure are drawn as grey tags and survive **Reset lesions**.

| Scenario | Substrate | Ground truth (seeded) | Initiation |
|---|---|---|---|
| Sinus rhythm | healthy | sinus CL 750–950 ms | — |
| Paroxysmal AF | paroxysmal preset (§2.3) | triggers in 1 (60 %) or 2 random PVs, 4–8 mm into the sleeve | spontaneous bursts |
| Persistent AF | persistent preset, fibrosis × 0.9–1.2 | fibrosis pattern, S2 patch | cross-field S1–S2 |
| Perimitral flutter | paroxysmal ionic model, CV 0.56–0.64 m/s, no fibrosis; prior wide-area rings around each ipsilateral pair (7 mm, 35 W × 20 s × 15 g) | direction | transient line block |
| Roof-dependent flutter | as perimitral | CV | transient line block |
| Focal AT | healthy or paroxysmal | focus at the LAA base, mitral annulus, septum, RSPV or LSPV antrum, or roof; CL 320–420 ms | automatic focus |
| Redo PVI | paroxysmal; prior per-vein rings (5 mm) | one vein with two consecutive lesions missing (an 8–12 mm gap); trigger in that vein | spontaneous bursts |

**Induction.** This is a numerical stand-in for clinical induction, so that every case starts in
its arrhythmia.

- **Line induction (macro-reentry).** A transient line of block (all its edges at zero
  conductance) runs from the mitral annulus to the left ring (perimitral), or across the mid
  posterior wall between the rings (roof). A stimulus beside the line launches a wave in one
  direction. The line is released at 230 ms, once the stimulated side has recovered (APD ≈ 190
  ms), and the wave re-enters. The first sinus beat waits until 600 ms, and is then reset by the
  tachycardia.
  - Perimitral flutter runs at TCL ≈ 260–290 ms.
  - Roof-dependent flutter is a figure-of-eight around both PV isolation lines, ascending the
    posterior wall, at TCL ≈ 330–340 ms. The descending launch does not sustain on this anatomy
    and is not used.
- **Cross-field S1–S2 (AF)** [47]. S1 is the sinus beat. S2 is a 15 mm patch centred ≈ 30 mm
  (≈ 60 ms at 0.5 m/s) from the breakthrough, delivered APD90 + 5–20 ms after the patch centre
  activates. The S2 wave can only propagate back into recovered tissue, so it breaks and forms
  rotors. On the fibrotic substrate this produces sustained, irregular activity with a dominant
  CS cycle length of 150–200 ms and many phase singularities.
- **Re-induction.** If the arrhythmia stops before the learner has delivered any lesion,
  cardioverted, or paced, it is re-induced (up to 6 times).

The validation experiments behind these choices (`flutter`/`AF` scripts) showed two things:

- Without prior PVI, a transient mitral-isthmus line launched reentry around a single PV sleeve.
  With isolated veins, the intended circuits form.
- The same mitral line (or roof line) terminates only its own circuit:
  - A mitral-isthmus line terminates perimitral flutter but not roof flutter.
  - A roof line terminates roof flutter but not perimitral flutter.

**Automatic reference choice.** If the reference bipole records < 0.3 mV peak-to-peak 1.5 s into a
case (for example, CS 7-8 lying over old scar), the case switches once to the CS bipole with the
largest signal. This is what a technician would do, and it uses signals only.

### 6.3 Ground truth, success criteria and the report

**Conduction topology** (`topology.ts`).

- An edge conducts when both its vertices are excitable and its diffusivity is non-zero.
- The **LA body** is the set of vertices reachable from the sinus sites.
- A PV is **isolated** when none of its excitable sleeve vertices is in the body.
- **Barrier components:**
  - Inexcitable vertices, vertices on openings, and excitable islands cut off from the body
    form "barrier" vertices, which are joined along mesh edges.
  - On a triangulated surface, a conducting path cannot cross an edge-connected chain of barrier
    vertices. Two openings are therefore separated by a line of block exactly when they share a
    component.
  - **Mitral block:** the MV opening shares a component with a PV opening.
  - **Roof block:** a left and a right PV opening share a component.
- **Durability.** Every check is also run with edema expired ("durable"). Block that depends on
  edema is reported as such.

**Evidence of what the learner did** (`report.ts`). Lesions within 30 mm of a vein's ostium count
as that vein's lesion set. Evidence must come after the last such lesion.

- **Entrance block:** an included mapping point in the vein sleeve with bipolar < 0.1 mV.
- **Exit block:** tip pacing from inside the sleeve with local capture and no 1:1 CS follow.
- **Line block demonstrated:** after the last lesion, either:
  - a pacing manoeuvre with a stimulus-to-electrogram time ≥ 100 ms to a bipole within 35 mm
    (the wave must detour around the line), or
  - a paced activation map with ≥ 10 points acquired during pacing [41, 42].
- **Earliest site:** the location of the minimum interpolated LAT, compared with the true
  breakthrough or focus.

**Criteria per scenario:**

- **Sinus:** coverage ≥ 80 %; earliest site within 10 mm.
- **PAF:** durable isolation of every vein, plus entrance and exit block evidence in every vein.
- **Persistent AF:** durable PVI; sinus rhythm at the end (cardioversion allowed).
- **Perimitral / roof:** durable line block; sinus rhythm at the end; line block demonstrated by
  pacing.
- **Focal AT:** focus eliminated or isolated (durable); sinus at the end; earliest site within
  8 mm.
- **Redo:** durable PVI; a new lesion within 6 mm of the gap centre; entrance and exit block in the
  reconnected vein [46].

**Report contents:**

- **Map quality:** points, included points, surface coverage (fraction of vertices with an
  interpolated LAT), density per cm².
- **Lesion set:** new and prior lesions, RF time, mean LQI, lesions below target, interlesion gaps.
- **Block:** per-vein isolation, mitral and roof block, rhythm.
- **Procedure:** simulated and wall time, pacing manoeuvres, cardioversions.
- **Safety:** esophageal temperature warnings, lesions over the esophagus, lesions with mean force
  > 40 g, lesions below the LQI target.
- **Explanation:** what was going on.

The report can be downloaded as JSON.

**The mitral isthmus is thick** (2.4–2.6 mm in the thickness model, §1.5). Standard 35 W × 20 s
lesions at 4 mm spacing leave conducting gaps between their cores; 45 W × 30 s at 3 mm closes the
line. This mirrors the clinical difficulty of mitral isthmus block [41]. Epicardial CS ablation is
not modelled.

### 6.4 Validation

`tests/pacing.test.ts`, `tests/scenarios.test.ts`, `tests/cases-pacing.test.ts` and
`tests/cases-arrhythmia.test.ts`. The case tests run the full reaction–diffusion engine on the CPU:

- **Protocols:** stimulus times for each protocol.
- **Capture:** the threshold follows the gap law; scar does not capture; output enlarges the
  footprint.
- **Signal analysis:** first activation, cycle length, and the noise floor.
- **Scenarios:**
  - Each scenario is deterministic per seed and varies across seeds.
  - PV triggers sit in the sleeves.
  - **Redo:** exactly the gap vein is reconnected. One lesion does not re-isolate it; filling both
    missing sites does.
  - **Post-PVI cases:** the rings isolate every vein. A mitral line creates mitral block but not
    roof block, and vice versa. A line with three missing lesions is not blocked.
- **Evaluation:** PAF needs isolation plus entrance and exit evidence after the last lesion; safety
  warnings are reported.
- **Pacing (engine):**
  - CS pacing at 5 mA captures. The CS reference follows the pacing CL (sinus is overdriven), and
    activation spreads from CS 3-4 to CS 9-10.
  - 0.2 mA does not capture (ground-truth capture fraction 0).
- **Entrainment:** PPI − TCL < 30 ms on the annulus and > 60 ms in the LAA.
- **Exit block:**
  - Before isolation, pacing inside the LSPV captures locally and the CS follows 1:1.
  - After an antral ring, it still captures locally, but the CS no longer follows.
- **Endpoints:**
  - Perimitral flutter: a mitral line (45 W × 30 s, 3 mm spacing) terminates it, with durable
    mitral block.
  - Roof flutter: a roof line terminates it.
  - Focal AT: one lesion at the focus eliminates it and sinus resumes.
  - Persistent AF: sustained and irregular for 3 s; cardioversion restores sinus.

## 7. Autonomic module and dataset export

### 7.1 Autonomic tone (phenomenological)

Code: `src/core/ep/autonomic.ts`. Latent foci and trigger modulation are in `src/engine/drivers.ts`.

This module is **phenomenological**. It has no neurotransmitter release, receptor kinetics or
ion-channel modulation. Tone acts only through the documented scaling rules below, which mimic the
direction and rough size of reported effects. Two sliders set vagal tone v and sympathetic tone s,
each 0–1.

**Ganglionated plexi.** Four zones model the major LA plexi [48]:

| Plexus | Location |
|---|---|
| Superior left | above the LSPV antrum |
| Inferior left | below the LIPV |
| Anterior right | in front of the RSPV |
| Inferior right | below the RIPV |

- **Centre:** the antral vertex 6–12 mm (edge-path distance) outside the vein's ostium that lies
  furthest in the plexus direction. The direction gets a seeded jitter of ±0.25 per component.
- **Weight:** a Gaussian of Euclidean distance, σ = 5–8 mm (seeded), truncated at 3σ.
- **Strength:** 0.7–1.3 (seeded).
- **GP density:** W_i = max over GPs of min(1, strength × efficacy × weight).

**Vagal tone.** Vagal tone shortens refractoriness, through acetylcholine-activated K⁺ current in
reality and through the scaling on τ_close here [49]. The APD scale (the multiplier on τ_close,
§2.2) becomes:

  uniform:        apdScale × (1 − 0.25·v)
  heterogeneous:  apdScale × (1 − v·(0.12 + 0.40·W_i))      (default; never below 0.5×)

So at full vagal tone the APD shortens by ≈ 12 % far from the plexi and by up to ≈ 50 % at their
centres. This creates the refractoriness heterogeneity that favours vagal AF [49].

- **Measured** (reaction–diffusion, healthy tissue, one sinus beat, v = 1, heterogeneous):
  APD90 falls to < 75 % of baseline at a GP centre and stays > 82 % far from the plexi.

**Sinus rate:**

  CL_eff = CL × (1 + 0.5·v) / (1 + 0.6·s)

For example, 800 ms becomes 1200 ms at full vagal tone and 500 ms at full sympathetic tone.

**Sympathetic tone and PV ectopy** [50, 51]:

- **Latent foci.** Every case has a latent focus in each PV sleeve, 4–8 mm into the vein (seeded),
  with a seeded draw u_v.
  - A focus is **armed** when u_v < s, so higher tone arms more veins.
  - Armed foci fire 1–3-beat bursts at 220–300 ms, as a Poisson process of rate 0.08·s per second
    per vein. A 400 ms dead time follows each burst.
  - All latent foci share one stimulus site; its vertices are switched to the firing vein before
    each burst.
- **Scenario triggers** (§6.1) fire more often under sympathetic tone: the interval is divided by
  (1 + 2s), and runs gain round(3s) beats.
- Ectopy needs the reaction–diffusion engine.

**GP ablation** [52]. A GP's efficacy is 1 − min(1, 1.5 × the weight-averaged fraction of its zone
covered by lesions, core or border). Efficacy multiplies that GP's contribution to W_i, so ablating
inside a plexus removes its extra vagal APD shortening. The teacher view (**GP zones**) shows W_i
and each GP's remaining efficacy.

### 7.2 Dataset export

Code: `src/core/export/` (`dataset.ts`, `labels.ts`).

**Points** can be exported as CSV (one row per point) or JSON (`ostium-points/1`). Each point
includes:

- **Position and identity:** xyz of the electrode at acquisition (mm, LPS), and the outward vertex
  normal at the projected vertex (normals point out of the blood pool, §1.1).
- **Projection:** vertex, projection distance, and region key.
- **Catheter:** catheter type and electrode.
- **Annotation:** LAT, method, bipolar and unipolar amplitude, deflections, fractionation and
  double-potential flags.
- **Acquisition:** contact force, stability and position SD, CL, excluded flag, tags, and the
  timestamp (simulated ms).
- **Raw EGM windows:** unipolar, bipolar and reference.
  - **Length:** configurable, 0–350 ms before and 10–350 ms after the reference.
  - **Rate:** 2 kHz as recorded, or 1 kHz. 1 kHz uses a two-sample boxcar and then decimation.
    Bipolar channels are already low-passed at 500 Hz (§3.3), so the boxcar's attenuation near
    Nyquist is the main distortion.
  - **CSV form:** three columns of space-separated samples, in mV.

**Ground-truth labels** (optional, on by default) come from the hidden simulation state. They are
added to exports only and never feed the maps (the mapping firewall test, §4.6, still holds):

| Label | Values |
|---|---|
| Fibrosis density | 0–1, plus the realized fibrotic-node flag |
| Fibrosis depth class | none / endocardial / mid-wall / transmural, from the transmural extent (< ⅓, < ⅔, ≥ ⅔ of the wall) where density > 0 |
| Lesion status | none / partial (border or partial thickness) / core, from the current raster (edema counts while active) |
| Autonomic zone | GP name where its weight ≥ 0.3, otherwise "none"; plus GP density W_i after ablation |
| Distance to the critical site | edge-path (geodesic) distance, mm |

The critical site depends on the scenario:

| Scenario | Critical site |
|---|---|
| Perimitral flutter | mitral isthmus (annulus to left PV ring) |
| Roof flutter | roof isthmus between the rings |
| Focal AT | focus |
| Paroxysmal AF | PV triggers |
| Redo | reconnection gap |
| Sinus | sinus breakthrough |
| Free simulation, persistent AF | none |

Where there is no critical site, the distance is empty in CSV and `null` in JSON.

**Meshes** can be exported as binary PLY or legacy ASCII VTK. Per-vertex fields:

- `region` and `wall_thickness`;
- the interpolated maps `map_lat`, `map_bipolar`, `map_unipolar` and `map_fractionation` (when
  points exist);
- with labels on: `gt_fibrosis_density`, `gt_fibrosis_depth_class`, `gt_lesion_status`,
  `gt_autonomic_zone`, `gt_gp_density` and `gt_critical_distance`.

Unmapped values are NaN in PLY and −9999 in VTK, because legacy ASCII readers do not parse NaN.

### 7.3 Headless batch mode

Code: `src/engine/batch.ts`, run in `src/workers/batch.worker.ts`. The batch runs off the main
thread and needs no UI.

**Spec:**

- number of cases and base seed;
- scenarios to draw from (including "free": a random tissue preset, fibrosis × 0–2, sinus rhythm);
- engine (eikonal or reaction–diffusion; forced to reaction–diffusion when a scenario needs it);
- points per case and catheter type;
- anatomy (the current mesh, or a new procedural anatomy per case at variability 0.5 or 1);
- random vagal and sympathetic tone per case;
- warm-up (1.5 s), maximum dwell per site (3.5 s), EGM window options, and whether to include each
  case's mesh.

**Each case:**

1. The case seed is derived from the base seed (`Rng.fork`), then the scenario, anatomy and tone.
2. A normal `SimEngine` is built and warmed up.
3. The roving catheter is placed at random non-boundary vertices. Each beat goes through the same
   `MappingSession` auto-acquisition filters as interactive mapping (settled, stable, in contact,
   CL within ±10 %, not on top of an existing point). The first accepted beat at a site gives its
   point(s); otherwise the site is abandoned after the dwell limit. There are up to
   3 × points-per-case attempts.
4. Points are exported with labels as in §7.2. The case records its seed, scenario, preset,
   fibrosis, anatomy, tone, effective sinus CL, the ground-truth summary and the critical-site
   label.

The output is one JSON (`ostium-batch/1`). Identical specs give identical output (tested).
Cancelling keeps the finished cases.

**Speed.** In eikonal mode, a point costs ≈ 1.2 s of simulated time (catheter settling plus one
beat). The moving electrodes' signals in eikonal mode are now evaluated with lead-field weights
binned by activation time, like the static table (§3.1 and the M5 notes). On one CPU core, 2 s of
simulated eikonal time took 0.8 s instead of 2.7 s, so playback is now faster than real time.
Reaction–diffusion batches are far slower without a GPU.

### 7.4 Validation

`tests/autonomic.test.ts` and `tests/export.test.ts`:

- **GP zones** lie on the antra next to their veins.
- **Vagal APD:** v = 0 leaves the APD unchanged; uniform mode gives 0.75×. In heterogeneous mode
  the scale is < 0.62× at a GP centre and 0.88× far from the plexi. Ablating a zone brings its
  centre back to 0.88×.
- **Tissue model:** APD90 shortens most at a GP centre (above).
- **Sinus CL:** the factors above; the engine reports 1200 ms for 800 ms at full vagal tone.
- **Latent foci:** none fire at s = 0. At s = 1 all foci are armed, with bursts within 40 % of the
  Poisson expectation. Triggers fire more often under sympathetic tone.
- **EGM windows:** lengths and decimation.
- **Labels:** depth classes; lesion core at an ablated focus; zero critical distance at the focus;
  GP zone membership.
- **Points:** CSV and JSON columns and values, with and without labels.
- **Meshes:** PLY and VTK round-trips with map and label fields (NaN and −9999).
- **Batch:** two eikonal cases × 5 points, every point labelled, with the requested window length;
  repeated runs are byte-identical.

## 8. Right atrium and typical flutter (stretch goal)

The right atrium is a **separate chamber mode**. The Anatomy panel (or a case that needs it)
generates an RA shell instead of the LA. Each chamber is simulated on its own, with no biatrial
coupling. Every subsystem (solver, mapping, ablation, pacing, export, batch) works unchanged on
either shell.

### 8.1 Anatomy

Code: `src/core/mesh/sdf-ra.ts` and `labels-ra.ts`, through `generateAtrium({ chamber: 'RA' })`.
The pipeline is the same as the LA's (§1.2–1.3): implicit surface, surface nets, cut openings,
isotropic remeshing to ≈ 0.95 mm.

**Shape** (LPS mm, centred on the RA):

| Part | Geometry |
|---|---|
| Body | ellipsoid, radii 24 × 22 × 27 mm |
| SVC | tube, radius 9.5 mm, entering superiorly and slightly posteriorly |
| IVC | tube, radius 11.5 mm, entering inferoposteriorly |
| CS ostium | short tube, radius 4.5 mm, on the inferoseptal wall between the IVC and the tricuspid annulus |
| RA appendage | broad two-segment tube, anterosuperior |
| Tricuspid annulus | cut plane facing the right ventricle (anterior, leftward, slightly inferior); radius ≈ 17 mm |

The default mesh has 12.1 k vertices, is manifold, and has a minimum angle of 24°.

**Regions** (appended to the frozen enum, ids 18–27). Precedence runs top to bottom:

1. **SVC, IVC, CS ostium, RA appendage**, by primitive ownership.
2. **Tricuspid annulus:** a 5 mm band.
3. **Cavotricuspid isthmus (CTI):** inferior vertices lateral to the CS ostium, with
   d(IVC) + d(TV) ≤ minimum + 9 mm. The isthmus is ≈ 20 mm long on the default mesh.
4. **Crista terminalis:** a ± 2.5 mm band around an edge path from the SVC to the IVC through the
   most posterolateral point.
5. **Septum** (normalized x > 0.35).
6. **Posterior smooth venous sinus.**
7. **Trabeculated free wall.**

**Wall thickness** (mm):

| Crista | CTI | Annulus | Septum | Free wall | Appendage | Cavae |
|---|---|---|---|---|---|---|
| 4.5 | 3.5 | 3.0 | 2.2 | 2.0 | 1.6 | 1.2 |

The crista and CTI values reflect their thick, muscular structure [53, 54]. The thickness ceiling
was raised to 6 mm; LA meshes are unaffected.

**Landmarks.** `anatomy.ra` holds the SVC, IVC and CS ostium, the crista centreline, and the sinus
node: the first crista vertex ≥ 6 mm below the SVC junction. For generic code, `anatomy.mitral`
holds the tricuspid annulus and `anatomy.laa` the RA appendage; `pvs` is empty.

### 8.2 Electrophysiology and catheters in the RA

- **Sinus rhythm.** A single site at the sinus node (4 mm radius) [55]. Activation spreads over the
  RA in ≈ 60–140 ms at 0.75 m/s (eikonal).
- **Crista terminalis.** The crista is a line of **transverse conduction block**. Edges joining the
  crista band to its tricuspid-facing (anterior) side are uncoupled (104 edges on the default
  mesh). The band stays coupled to the posterior venous sinus and along its length, and nothing is
  isolated (tested).

  In vivo this block is functional and rate-dependent, and it forms the posterior boundary of
  typical flutter [54]. Here it is structural. In the validation runs, the flutter behaved the same
  with and without it.
- **CS catheter.** It enters from the IVC, crosses the floor and passes through the ostium.
  - CS 9-10 lie in the ostium, 3.1 mm off its axis (against the wall), and record ≈ 0.8 mV.
  - CS 1-8 continue along the CS axis beyond the chamber. The LA is not simulated in this mode, so
    they record only far field.
  - CS 9-10 is therefore the default timing reference in the RA.
- **Roving catheter.** Its shaft enters from the IVC.
- **No esophageal zone**, and no PV ectopy or GP zones in this mode.

### 8.3 Typical flutter scenario

**Substrate:**

- paroxysmal ionic model (APD ≈ 190 ms);
- CV 0.47–0.55 m/s, no fibrosis;
- a **slow CTI zone**: σ × 0.30–0.40 within 8–11 mm of the isthmus centroid. Slower isthmus
  conduction is reported in typical flutter [54]; the values are a modelling choice.

**Induction** (§6.2). A transient line of block runs from the tricuspid annulus to the IVC across the
CTI, with a stimulus on its septal side. The wave ascends the septum, crosses the roof, descends the
lateral wall and re-enters the isthmus from lateral to septal: **counterclockwise** in the LAO
view, the common form.

The clockwise launch (stimulus on the lateral side) did not sustain at any release time tried
(200–310 ms) on this anatomy, so it is not used. Re-induction (§6.2) applies.

**Measured** on seeds 1–4: TCL 212–242 ms (mostly 220–227 ms). Clinical typical flutter is
≈ 200–260 ms [53].

**Ground truth: CTI block** means the tricuspid opening shares a barrier component with the IVC
opening (§6.3).

**Criteria:**

- durable CTI block;
- sinus rhythm at the end;
- line block demonstrated by pacing (§6.3 evidence).

The standard manoeuvre: pace from **CS 9-10** (the ostium, septal to the line) and record
**just lateral** to it. With block, the wave must travel up the septum and around the annulus
[56].

**Validation** (`tests/ra.test.ts`; reaction–diffusion on the CPU, seed 3):

- Flutter sustains at TCL 190–280 ms, and the ground truth reads "not sinus".
- Entrainment from mid-isthmus gives |PPI − TCL| < 30 ms.
- A CTI line (45 W × 30 s at 3 mm, as the isthmus is ≈ 3 mm thick) gives durable CTI block and
  sinus rhythm.
- CS-ostium pacing afterwards gives a stimulus-to-MAP time > 100 ms to a site < 35 mm away, lateral
  to the line.
- On seeds 1–4 alike, the CTI line terminated the flutter and sinus resumed.

Anatomy tests check:

- the openings, manifoldness and angle quality;
- that every RA region is present, with an isthmus 15–40 mm long;
- that the crista is thicker than the free wall, and the sinus node lies on the crista;
- that the crista block isolates nothing;
- CS electrode placement.

---

## Known limitations

### Anatomy (M1)
- **Single surface.** The atrium is a single surface with no wall volume. Wall thickness is a
  per-vertex attribute, not geometry. Transmural effects (lesion depth, fibrosis depth, epicardial
  structures) are modeled phenomenologically, not resolved.
- **Idealized anatomy.**
  - The LA body is an ellipsoid. Real atria have pectinate muscles in the LAA, the left lateral ridge,
    septal folds, and much more shape variation.
  - PV variants (common ostia, right middle veins) are not generated.
- **Imported meshes are not resampled.** Very coarse or very fine imported meshes need remeshing
  before the solver calibration holds.
- **Geodesic error.** Edge-graph Dijkstra overestimates geodesic distance by up to about 9 %. This is
  used for labelling only.

### Signals (M3)
- **Infinite homogeneous conductor.** The model has no blood/tissue conductivity boundary, no
  torso, lungs or spine, and no electrode–tissue interface impedance. Absolute amplitudes are
  therefore approximate, though their dependence on distance, contact, wall thickness and scar is
  physical.
- **Point electrodes.** There is no spatial averaging over the 3.5 mm tip, so very close electrodes
  are slightly over-sharp.
- **No ventricles or right atrium.** The CS and unipolar channels lack the ventricular far field
  that dominates real CS recordings, and the P wave lacks its right-atrial half.
- **Phenomenological contact and motion.** Force maps to distance by an assumed exponential. Motion
  amplitudes are illustrative, not measured.
- **Truncated far field.** Intracardiac lead fields sum sources within 30 mm only.
- **Eikonal-mode signals** use a fixed action-potential template, so they are a little sharper than
  reaction–diffusion signals and show no rate-dependent changes.

### Mapping (M4)
- **Interpolation method.** Inverse-distance weighting is simple and transparent, but flattens
  gradients between sparse points. Commercial systems use proprietary interpolation, and research
  tools use Laplace or RBF methods.
- **Point location.** Locations are the instantaneous electrode positions at the end of the beat
  window. There is no respiratory gating or patch-based localization error model. Projection is to
  the nearest vertex.
- **Heuristic annotation.** Fractionation and double-potential detection are heuristic. There is no
  LAT-coherence or "LAT histogram" tool, and no automatic rejection of far-field ventricular
  signals (the model has no ventricles).
- **Anatomy build** reveals the existing shell rather than reconstructing it, so catheter-geometry
  errors are not simulated.

### Ablation (M5)
- **Empirical lesions, no thermal model.** There is no bioheat equation, blood-flow cooling, irrigation,
  electrode orientation, steam pop, char or thrombus. Size depends on coupled energy and power only.
  Catheter angle does not change the lesion.
- **Surface raster.** Lesions are painted onto the surface by geodesic distance. Depth is compared with
  the per-vertex wall thickness, not resolved through the wall, so endocardial-only sparing of
  epicardial bundles is not represented.
- **Indices are illustrative.** The impedance, esophageal-temperature and LQI formulas are
  phenomenological and uncalibrated. Do not read them as clinical targets.
- **Compressed time.** The RF clock and edema recovery are compressed for teaching (§5.5).
  Late reconnection from tissue healing is represented only through edema.

### Pacing and scenarios (M6)
- **Scripted induction.** Arrhythmias start from a numerical induction (transient line block or a
  cross-field S2), not from programmed stimulation. Burst pacing in this model rarely induces AF,
  because wavefronts on a smooth isotropic shell organize rather than break. Learners can still
  try burst and S1–S2 protocols.
- **Phenomenological capture.** There is no virtual-electrode (bidomain) effect, no anodal
  capture, no strength–duration curve beyond the √(I/I_th) scaling, and no stimulus artifact.
- **Two catheters.** Only the CS and one roving catheter exist, so some clinical verification
  manoeuvres are approximated. For example, roof-line verification by LAA pacing while mapping
  the posterior wall needs a second roving catheter, so a paced activation map from the CS is
  accepted instead.
- **Simplified sinus node and foci.** Reset is instantaneous, with no sinus-node recovery time and
  no overdrive suppression of automatic foci.
- **Ground truth on a graph.** Block is decided on the vertex graph. Conduction across
  interstitially removed edges and electrotonic effects over thin lines are not considered.
- **Fixed anatomy.** The flutter circuits were validated on the default anatomy. On strongly
  varied procedural anatomies, a case may need re-induction.

### Autonomic module and export (M7)
- **Phenomenological tone.** Tone uses scaling rules, with no ACh/β-adrenergic channel models, no
  time course (changes are instantaneous), no baroreflex, and no effect on CV or on the AV node
  (which is not modelled).
- **Schematic GP anatomy.** GP zones are four Gaussian patches. Real plexi are variable, partly
  epicardial, and interconnected, including the ligament of Marshall. GP ablation acts through
  endocardial lesion coverage only.
- **Ectopy as stimuli.** Latent foci and triggers are stimulus trains, not afterdepolarizations
  in the ionic model.
- **Labels from the model.** Ground-truth labels describe this model's hidden state, for example
  fibrosis as isolated nodes or depth as a per-vertex fraction. They are not histology or
  imaging-derived truth.
- **Batch points use random sites.** Sites are uniform over vertices, not a clinical mapping
  workflow. In arrhythmia scenarios, the beat windows are referenced to the CS like interactive
  mapping.

### Right atrium (stretch goal)
- **One chamber at a time.** The LA and RA are separate shells. There is no Bachmann's bundle or
  interatrial conduction, no biatrial activation, and no LA signal on the distal CS in RA mode.
- **Smooth surfaces.** There are no pectinate muscles, Eustachian ridge or valve, Thebesian
  valve, or isthmus pouch. The CTI's slowing and thickness are regional parameters, not structure.
- **Structural crista block.** In vivo, crista block is functional and rate-dependent. Here it is
  a fixed line, and the sinus node site spans both sides of the crista.
- **Counterclockwise only.** The circuit runs counterclockwise only, and there is no lower-loop or
  upper-loop reentry scenario.
- **Generated meshes only.** Imported meshes are always treated as LA.

### Electrophysiology (M2), compared with bidomain models and real atria
- **Monodomain, not bidomain.**
  - Assumes equal intra- and extracellular anisotropy ratios.
  - Ignores extracellular current redistribution. This matters for defibrillation, virtual electrodes,
    and strong field stimulation, which this simulator does not cover.
  - Unipolar EGMs (M3) are computed in a separate post-processing step from the monodomain source.
- **Isotropic conduction.** Real atria conduct about 2–3× faster along fibres. Bachmann's bundle,
  the crista and the septopulmonary bundle are not represented as fast tracts. Fibre architecture is
  only used for the interstitial fibrosis pattern.
- **Phenomenological ionic models.**
  - There are no ionic currents, concentrations, or drug targets.
  - APD restitution comes from gating dynamics only.
  - Remodeling is represented by time constants, not by channel expression.
- **No right atrium or sinus node.** Sinus breakthroughs are prescribed. RA-dependent rhythms
  (typical flutter) need the stretch-goal RA.
- **Discrete structural fibrosis.** Fibrotic nodes are fully isolated, with no fibroblast–myocyte
  coupling or partial conductance. Patch size and transmurality are statistical, not imaging-derived.
- **Discretization.** Calibration absorbs CV error at h ≈ 1 mm, but wavefront-curvature effects and
  conduction failure at sharp fibrotic boundaries are mesh-dependent, as in any discrete model.
- **Eikonal mode** has no refractoriness, so it cannot show reentry, collision-dependent block, or
  pacing.
- **Performance.** The CPU fallback is slow, ≈ 0.03–0.13× real time depending on hardware. GPU
  performance has not been measured on real hardware during development.

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
12. Pinkall U, Polthier K. Computing discrete minimal surfaces and their conjugates. *Experimental Mathematics* 1993;2:15–36.
13. Qu Z, Garfinkel A. An advanced algorithm for solving partial differential equation in cardiac conduction. *IEEE Trans Biomed Eng* 1999;46:1166–1168.
14. Rush S, Larsen H. A practical algorithm for solving dynamic membrane equations. *IEEE Trans Biomed Eng* 1978;25:389–392.
15. Mitchell CC, Schaeffer DG. A two-current model for the dynamics of cardiac membrane. *Bull Math Biol* 2003;65:767–793.
16. Aliev RR, Panfilov AV. A simple two-variable model of cardiac excitation. *Chaos Solitons Fractals* 1996;7:293–301.
17. Fenton F, Karma A. Vortex dynamics in three-dimensional continuous myocardium with fiber rotation: filament instability and fibrillation. *Chaos* 1998;8:20–47.
18. Fenton FH, Cherry EM, Hastings HM, Evans SJ. Multiple mechanisms of spiral wave breakup in a model of cardiac electrical activity. *Chaos* 2002;12:852–892.
19. Kimmel R, Sethian JA. Computing geodesic paths on manifolds. *Proc Natl Acad Sci USA* 1998;95:8431–8435.
20. Dössel O, Krueger MW, Weber FM, Wilhelms M, Seemann G. Computational modeling of the human atrial anatomy and electrophysiology. *Med Biol Eng Comput* 2012;50:773–799.
21. Wijffels MC, Kirchhof CJ, Dorland R, Allessie MA. Atrial fibrillation begets atrial fibrillation: a study in awake chronically instrumented goats. *Circulation* 1995;92:1954–1968.
22. Rensma PL, Allessie MA, Lammers WJ, Bonke FI, Schalij MJ. Length of excitation wave and susceptibility to reentrant atrial arrhythmias in normal conscious dogs. *Circ Res* 1988;62:395–410.
23. Markides V, Schilling RJ, Ho SY, Chow AW, Davies DW, Peters NS. Characterization of left atrial activation in the intact human heart. *Circulation* 2003;107:733–739.
24. Lemery R, Birnie D, Tang ASL, Green M, Gollob M, Hendry M, Lau E. Normal atrial activation and voltage during sinus rhythm in the human heart: an endocardial and epicardial mapping study in patients with a history of atrial fibrillation. *J Cardiovasc Electrophysiol* 2007;18:402–408.
25. Clerc L. Directional differences of impulse spread in trabecular muscle from mammalian heart. *J Physiol* 1976;255:335–346.
26. Geddes LA, Baker LE. The specific resistance of biological material — a compendium of data for the biomedical engineer and physiologist. *Med Biol Eng* 1967;5:271–293.
27. Plonsey R, Barr RC. *Bioelectricity: A Quantitative Approach*, 3rd ed. Springer, 2007 (volume-conductor dipole sources).
28. Stevenson WG, Soejima K. Recording techniques for clinical electrophysiology. *J Cardiovasc Electrophysiol* 2005;16:1017–1022.
29. Rolf S, Kircher S, Arya A, et al. Tailored atrial substrate modification based on low-voltage areas in catheter ablation of atrial fibrillation. *Circ Arrhythm Electrophysiol* 2014;7:825–833.
30. Shah DC, Lambert H, Nakagawa H, Langenkamp A, Aeby N, Leo G. Area under the real-time contact force curve (force–time integral) predicts radiofrequency lesion size in an in vitro contractile model. *J Cardiovasc Electrophysiol* 2010;21:1038–1043.
31. Reddy VY, Shah D, Kautzner J, et al. The relationship between contact force and clinical outcome during radiofrequency catheter ablation of atrial fibrillation in the TOCCATA study. *Heart Rhythm* 2012;9:1789–1795.
32. Neuzil P, Reddy VY, Kautzner J, et al. Electrical reconnection after pulmonary vein isolation is contingent on contact force during initial treatment: results from the EFFICAS I study. *Circ Arrhythm Electrophysiol* 2013;6:327–333.
33. Leshem E, Zilberman I, Tschabrunn CM, et al. High-power and short-duration ablation for pulmonary vein isolation: biophysical characterization. *JACC Clin Electrophysiol* 2018;4:467–479.
34. Taghji P, El Haddad M, Phlips T, et al. Evaluation of a strategy aiming to enclose the pulmonary veins with contiguous and optimized radiofrequency lesions in paroxysmal atrial fibrillation: a pilot study. *JACC Clin Electrophysiol* 2018;4:99–108.
35. Das M, Loveday JJ, Wynn GJ, et al. Ablation index, a novel marker of ablation lesion quality: prediction of pulmonary vein reconnection at repeat electrophysiology study and regional differences in target values. *Europace* 2017;19:775–783.
36. Arujuna A, Karim R, Caulfield D, et al. Acute pulmonary vein isolation is achieved by a combination of reversible and irreversible atrial injury after catheter ablation: evidence from magnetic resonance imaging. *Circ Arrhythm Electrophysiol* 2012;5:691–700.
37. Good E, Oral H, Lemola K, et al. Movement of the esophagus during left atrial catheter ablation for atrial fibrillation. *J Am Coll Cardiol* 2005;46:2107–2110.
38. Leite LR, Santos SN, Maia H, et al. Luminal esophageal temperature monitoring with a deflectable esophageal temperature probe and intracardiac echocardiography may reduce esophageal injury during atrial fibrillation ablation procedures. *Circ Arrhythm Electrophysiol* 2011;4:149–156.
39. Jaïs P, Matsuo S, Knecht S, et al. A deductive mapping strategy for atrial tachycardia following atrial fibrillation ablation: importance of localized reentry. *J Cardiovasc Electrophysiol* 2009;20:480–491.
40. Waldo AL. Atrial flutter: entrainment characteristics. *J Cardiovasc Electrophysiol* 1997;8:337–352.
41. Jaïs P, Hocini M, Hsu LF, et al. Technique and results of linear ablation at the mitral isthmus in eradicating persistent atrial fibrillation. *Circulation* 2004;110:2996–3002.
42. Hocini M, Jaïs P, Sanders P, et al. Techniques, evaluation, and consequences of linear block at the left atrial roof in paroxysmal atrial fibrillation: a prospective randomized study. *Circulation* 2005;112:3688–3696.
43. Calkins H, Hindricks G, Cappato R, et al. 2017 HRS/EHRA/ECAS/APHRS/SOLAECE expert consensus statement on catheter and surgical ablation of atrial fibrillation. *Heart Rhythm* 2017;14:e275–e444.
44. Strauss HC, Saroff AL, Bigger JT Jr, Giardina EG. Premature atrial stimulation as a key to the understanding of sinoatrial conduction in man: presentation of data and critical review of the literature. *Circulation* 1973;47:86–93.
45. Haïssaguerre M, Jaïs P, Shah DC, et al. Spontaneous initiation of atrial fibrillation by ectopic beats originating in the pulmonary veins. *N Engl J Med* 1998;339:659–666.
46. Ouyang F, Antz M, Ernst S, et al. Recovered pulmonary vein conduction as a dominant factor for recurrent atrial tachyarrhythmias after complete circular isolation of the pulmonary veins. *Circulation* 2005;111:127–135.
47. Pertsov AM, Davidenko JM, Salomonsz R, Baxter WT, Jalife J. Spiral waves of excitation underlie reentrant activity in isolated cardiac muscle. *Circ Res* 1993;72:631–650.
48. Armour JA, Murphy DA, Yuan BX, Macdonald S, Hopkins DA. Gross and microscopic anatomy of the human intrinsic cardiac nervous system. *Anat Rec* 1997;247:289–298.
49. Liu L, Nattel S. Differing sympathetic and vagal effects on atrial fibrillation in dogs: role of refractoriness heterogeneity. *Am J Physiol* 1997;273:H805–H816.
50. Patterson E, Po SS, Scherlag BJ, Lazzara R. Triggered firing in pulmonary veins initiated by in vitro autonomic nerve stimulation. *Heart Rhythm* 2005;2:624–631.
51. Po SS, Scherlag BJ, Yamanashi WS, et al. Experimental model for paroxysmal atrial fibrillation arising at the pulmonary vein–atrial junctions. *Heart Rhythm* 2006;3:201–208.
52. Katritsis DG, Pokushalov E, Romanov A, et al. Autonomic denervation added to pulmonary vein isolation for paroxysmal atrial fibrillation: a randomized clinical trial. *J Am Coll Cardiol* 2013;62:2318–2325.
53. Saoudi N, Cosío F, Waldo A, et al. A classification of atrial flutter and regular atrial tachycardia according to electrophysiological mechanisms and anatomical bases: a statement from a joint expert group from the Working Group of Arrhythmias of the European Society of Cardiology and the North American Society of Pacing and Electrophysiology. *Eur Heart J* 2001;22:1162–1182.
54. Olgin JE, Kalman JM, Fitzpatrick AP, Lesh MD. Role of right atrial endocardial structures as barriers to conduction during human type I atrial flutter: activation and entrainment mapping guided by intracardiac echocardiography. *Circulation* 1995;92:1839–1848.
55. Boineau JP, Canavan TE, Schuessler RB, et al. Demonstration of a widely distributed atrial pacemaker complex in the human heart. *Circulation* 1988;77:1221–1237.
56. Shah DC, Takahashi A, Jaïs P, Hocini M, Clémenty J, Haïssaguerre M. Local electrogram-based criteria of cavotricuspid isthmus block. *J Cardiovasc Electrophysiol* 1999;10:662–669.

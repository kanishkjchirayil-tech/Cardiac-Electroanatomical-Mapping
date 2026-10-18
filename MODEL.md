# Ostium — model documentation

> **Educational simulation — not for clinical use.** Every number here is a modeling choice meant to be
> physiologically plausible for teaching. None of it is validated for clinical decisions.

This document lists every modeling assumption, equation, and parameter in the simulator. Each
milestone adds its own section. Sections marked *(planned)* are not implemented yet.

- [1. Anatomy](#1-anatomy) — implemented (M1)
- [2. Electrophysiology engine](#2-electrophysiology-engine) — implemented (M2)
- [3. Catheters and signals](#3-catheters-and-signals) — implemented (M3)
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
*(planned, M4.)*

## 5. Ablation
*(planned, M5.)*

## 6. Pacing and scenarios
*(planned, M6.)*

## 7. Autonomic module and dataset export
*(planned, M7.)*

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

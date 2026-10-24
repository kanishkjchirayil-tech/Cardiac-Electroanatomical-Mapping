# Ostium — atrial mapping & ablation simulator

> **Educational simulation — not for clinical use.**

Ostium is an in-browser teaching simulator for catheter mapping and ablation of the left atrium. It
builds a 3D atrial shell, simulates electrophysiology on it, and lets you acquire points with a roving
catheter, build activation and voltage maps from those points, and deliver RF lesions that change the
underlying tissue. It is a static site with no backend.

Modeling assumptions, equations, parameters, and references are in **[MODEL.md](MODEL.md)**.

## Status

| Milestone | Status |
|---|---|
| **M1** — Mesh, rendering, camera views, region labels | ✅ done |
| **M2** — Monodomain / eikonal solver, calibration, sinus rhythm | ✅ done |
| **M3** — Catheters, EGM synthesis, EGM panel | ✅ done |
| **M4** — Acquisition, annotation, LAT and voltage maps | ✅ done |
| **M5** — Ablation and lesion tags | ✅ done |
| M6 — Pacing, entrainment, scenarios, case report | planned |
| M7 — Autonomic module, dataset export, batch mode | planned |

## Running

You need Node ≥ 20 and a browser with WebGL 2. The tissue solver uses WebGPU when the browser has it (recent Chrome/Edge; Safari/Firefox with WebGPU enabled) and falls back to a CPU Web Worker otherwise.

```bash
npm install        # .npmrc sets legacy-peer-deps (works around an npm 10 optional-peer resolution bug)
npm run dev        # dev server at http://localhost:5173
npm test           # Vitest suite (≈ 3 min; mesh, solver, reentry, sinus rhythm, electrograms, mapping accuracy, ablation block vs gap)
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/
```

**Solver self-test.** Open `/selftest.html` (dev server or build) to compare the CPU and WebGPU
backends on identical problems and to measure the real-time factor on your hardware. Add
`?backend=cpu` to the app URL to force the CPU worker.

On first load the procedural atrium (~16.5 k vertices) is generated in a Web Worker, which takes about
8–10 s. Later loads of the same seed and variability come from an IndexedDB cache and are instant.

## Controls

| Input | Action |
|---|---|
| Left-drag | Rotate (free trackball) |
| Right-drag / Shift-drag | Pan |
| Wheel | Zoom |
| `1`–`8` | Standard views: AP, PA, LAO 30°, RAO 30°, left lateral, right lateral, superior, inferior |
| Hover the shell | Status bar shows region, wall thickness, vertex id, and LPS coordinates |
| Click the shell | Place the roving catheter tip there |
| Shift-drag on the shell | Slide the catheter tip across the wall |
| Arrow keys | Nudge the tip 2 mm across the wall in the screen direction (with Shift: 0.5 mm) |
| `[` / `]` | Contact force −5 g / +5 g |
| `P` | Acquire point(s) from the latest beat |
| Click a point marker | Select it in the point list and inspector |
| `Delete` / `Ctrl+Z` | Delete the selected point / undo |

The sidebar has these panels:

- **Simulation**
  - **Eikonal (fast)** computes a sinus activation map instantly by fast marching. **Reaction–diffusion**
    runs the full monodomain model, which you need for reentry, refractoriness and (from M6) pacing.
  - **Tissue preset**: healthy, paroxysmal AF substrate, or persistent AF substrate (remodeled, with
    fibrosis). Also pick the ionic model, the fibrosis amount and pattern, and the sinus cycle length.
  - **Run / Pause / +10 ms / Reset**, and the speed (0.1× to 1×, or Max). The clock shows simulated
    time and the measured speed as a multiple of real time.
  - **Teacher view** is off by default. It reveals hidden ground truth: live voltage, the true
    activation map of the last beat, and the substrate (fibrotic nodes, lesion cores and borders, the
    esophageal zone). Mapping never uses it.
  - **Tissue lab** measures plane-wave CV, APD90, ERP, and S1–S2 restitution curves for the current
    tissue.
- **Roving catheter**
  - Contact force (g), contact angle and tilt direction, and electrode spacing (2-5-2 default).
  - A live force bar and a **Stable / Unstable** badge. Stable means tip movement SD < 1 mm and
    force 5–40 g over the last second.
  - Cardiac and respiratory tip motion can be switched off.
- **Mapping**
  - **Acquire point** takes every electrode of the latest beat. **Auto-acquire** keeps only beats
    that meet the criteria: catheter settled, stable and in contact, CL within ±10 % of the
    reference, on the surface, and not on top of an existing point. The verdict for the last beat
    is shown live.
  - Map types: **LAT**, **bipolar voltage**, **unipolar voltage**, **fractionation**, and an animated
    **propagation** map.
  - Map settings:
    - LAT colour range (auto or manual) and voltage thresholds (default 0.1 / 0.5 mV bipolar).
    - Fill threshold and projection cutoff.
    - Point markers, conduction-velocity vectors, and **anatomy build**, which reveals the shell only
      where the catheter has been.
  - Annotation settings: window of interest relative to the CS reference, and the LAT method
    (steepest unipolar downslope or bipolar peak).
  - Points list: delete, undo, clear. The **inspector** shows the stored reference, bipolar and
    unipolar EGMs; click on them to re-annotate LAT. It also has *Auto LAT*, exclude, and tags.
  - The **HD grid** catheter (Roving catheter panel) acquires up to 16 points per beat.
- **Ablation**
  - Settings: **power** (W) and **duration** (s). Contact force comes from the catheter panel.
  - **RF ON / OFF** delivers at the ablation catheter tip. RF advances on an accelerated
    **RF clock** (1–20× simulated time, default 10×) while the simulation runs. **Instant**
    delivers the whole application at once, even when paused. Moving the catheter stops RF.
  - Live readouts: elapsed time, force, impedance and its drop, force–time integral, effective
    energy, predicted depth vs local wall thickness, and the **lesion quality index** (LQI, target 10 =
    predicted transmural). Over the esophagus, an estimated esophageal temperature with a warning at
    39 °C.
  - **Edema** (optional) makes fresh lesions temporarily larger. Edema recovers after a set
    simulated time, so acute block can later reconnect.
  - Lesion list: LQI, depth/wall, power·time, FTI, and the distance to the previous lesion. Gaps
    above the threshold (default 6 mm) are flagged and drawn as red lines. **Reset lesions**
    restores the tissue.
  - 3D view: lesion tags coloured by LQI (green ≥ 10, amber 8–10, red < 8), and the esophagus as a
    translucent tube behind the posterior wall.
  - Lesions change the tissue itself. Transmural cores stop conduction, partial lesions only slow
    it, and electrograms over ablated tissue shrink. Map before and after to check for block.
- **Signals**
  - Mains interference (50 or 60 Hz, or off) and a notch filter.
  - Noise level.
  - Bipolar and unipolar band-pass corners (defaults 30–500 Hz and 1–240 Hz).
- **Anatomy**
  - Generate a procedural LA. The seed sets anatomical variation and wall-thickness noise. Variability
    0 gives the canonical shape; 1 gives typical variation.
  - Import a mesh.
- **Display**
  - Overlay: plain shell, region labels, or wall thickness.
  - Wireframe, opening labels, and opacity.
  - In the region legend, hover an entry to highlight that segment.
- **Clipping plane**
  - View-aligned (or sagittal, coronal, axial), with an offset slider and a flip option.
  - Use it to look at the endocardium from inside.
- **Mesh** — quality statistics.

Below the 3D view is the **Electrograms** panel:

- **Traces:** ECG I, II and V1; CS 9-10 → CS 1-2 from the fixed coronary-sinus decapolar; MAP 1-2
  and MAP 3-4 bipolar; MAP 1 and MAP 2 unipolar.
- **Sweep speed:** 25–200 mm/s.
- **Gains:** per group, in mm/mV.
- **Freeze** stops the sweep.
- **Calipers:** drag on the traces to measure an interval and its rate; click to clear.
- **Cycle length:** read from a selectable CS reference bipole.

Electrograms are computed from the simulated tissue with a volume-conductor dipole model (MODEL.md
§3). They are measurements, so they appear whether or not the teacher view is on.

The orientation triad in the lower left shows **L/P/S**. The patient frame is LPS:
+x = left, +y = posterior, +z = superior. Units are millimetres.

## Importing a mesh

Supported formats are `.obj`, `.ply` (ASCII or binary; extra vertex properties are read), and legacy
ASCII `.vtk` (POLYDATA or UNSTRUCTURED_GRID). Select the mesh and an optional sidecar `.json` together in
the file dialog. The sidecar arrays are in the file's vertex order:

```json
{
  "format": "ostium-labels/1",
  "units": "mm",
  "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
  "region": ["lspv", "lspv", "roof", 3, "..."],
  "wallThickness": [1.1, 1.0, 1.8, "..."]
}
```

- **`region`**: numeric ids or keys from `src/core/mesh/regions.ts`, such as `anterior`, `roof`,
  `posterior`, `inferior`, `septum`, `lateral`, `lspv`, `lipv`, `rspv`, `ripv`, `lspv_antrum`, …, `laa`,
  `mitral_annulus`, or `mitral_isthmus`.
- **`transform`**: a row-major 4×4 into the LPS mm frame.
- **Without a sidecar**: a PLY/VTK point-data array named `region` (or `wallThickness`/`thickness`) is
  used if present.
- **Openings** are named from the majority region of their boundary vertices.

## Project layout

```
src/
  core/            framework-free simulation core (runs in browser, workers and Node tests)
    math/ rng.ts noise.ts
    mesh/          implicit atrium, surface nets, remeshing, labels, thickness, topology, geodesics, I/O
    ep/            FEM operators, ionic models, substrate, CPU and WebGPU solvers, eikonal, calibration
    catheter/      CS decapolar and roving catheter geometry, contact and motion models, surface walking
    signals/       lead fields, recording chain (noise, referencing, filters), ECG, beat windows, detection
    mapping/       annotation, mapping session (filters, undo), geodesic interpolation — sees signals only
    ablation/      RF application, empirical lesion model and raster, edema, esophagus, lesion-set helpers
  engine/          simulation engine hosted in a worker (clock, sinus pacing, backend selection)
  render/          three.js viewer, colormaps, standard views (framework-free)
  workers/         mesh generation and simulation workers
  selftest/        CPU-vs-WebGPU comparison page (selftest.html)
  ui/              Preact UI (panels, state, mesh service with IndexedDB cache)
tests/             Vitest specs
MODEL.md           model documentation
```

## License and naming

"Ostium" and its logo are original to this project. The project uses no vendor names, trade names, or
UI artwork from commercial mapping systems.

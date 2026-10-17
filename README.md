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
| M2 — Monodomain / eikonal solver, calibration, sinus rhythm | planned |
| M3 — Catheters, EGM synthesis, EGM panel | planned |
| M4 — Acquisition, annotation, LAT and voltage maps | planned |
| M5 — Ablation and lesion tags | planned |
| M6 — Pacing, entrainment, scenarios, case report | planned |
| M7 — Autonomic module, dataset export, batch mode | planned |

## Running

You need Node ≥ 20 and a browser with WebGL 2. WebGPU will be used from M2, with a CPU fallback.

```bash
npm install        # .npmrc sets legacy-peer-deps (works around an npm 10 optional-peer resolution bug)
npm run dev        # dev server at http://localhost:5173
npm test           # Vitest suite (≈ 20 s; generates the full-resolution atrium once)
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/
```

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

The sidebar has these panels:

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
  render/          three.js viewer, colormaps, standard views (framework-free)
  workers/         mesh generation worker
  ui/              Preact UI (panels, state, mesh service with IndexedDB cache)
tests/             Vitest specs
MODEL.md           model documentation
```

## License and naming

"Ostium" and its logo are original to this project. The project uses no vendor names, trade names, or
UI artwork from commercial mapping systems.

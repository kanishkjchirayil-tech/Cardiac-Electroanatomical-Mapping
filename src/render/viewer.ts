import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import type { SurfaceMesh } from '../core/mesh/types';
import { standardViews, type ViewName } from './views';
import { CatheterView } from './catheters';
import type { RovingFrame } from '../engine/protocol';

export interface HoverInfo {
  vertex: number;
  point: [number, number, number];
}

export type ClipAxis = 'view' | 'LR' | 'AP' | 'SI';

export interface ClipState {
  enabled: boolean;
  axis: ClipAxis;
  /** Offset from the mesh centre along the plane normal, mm. */
  offset: number;
  flip: boolean;
}

/**
 * three.js viewport for the atrial shell. Framework-free: the UI drives it through
 * plain method calls and receives hover / fps callbacks.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: TrackballControls;
  onHover: ((h: HoverInfo | null) => void) | null = null;
  onFps: ((fps: number) => void) | null = null;
  /** Click (no drag) on the shell. */
  onSelect: ((h: HoverInfo) => void) | null = null;
  /** Shift-drag across the shell (continuous). */
  onDrag: ((h: HoverInfo) => void) | null = null;
  readonly catheters = new CatheterView();
  private readonly ghostScene = new THREE.Scene();

  private readonly container: HTMLElement;
  private readonly labelLayer: HTMLDivElement;
  private shell: THREE.Mesh | null = null;
  private wire: THREE.Mesh | null = null;
  private loopLines: THREE.Group = new THREE.Group();
  private labels: Array<{ el: HTMLDivElement; pos: THREE.Vector3; normal: THREE.Vector3 }> = [];
  private readonly material: THREE.MeshStandardMaterial;
  private readonly wireMaterial: THREE.MeshBasicMaterial;
  private readonly clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private clip: ClipState = { enabled: false, axis: 'view', offset: 0, flip: false };
  private clipViewNormal = new THREE.Vector3(0, 1, 0);
  private center = new THREE.Vector3();
  private radius = 60;
  private readonly raycaster = new THREE.Raycaster();
  private pointer: THREE.Vector2 | null = null;
  private hoverDirty = false;
  private readonly gizmo: OrientationGizmo;
  private readonly resizeObserver: ResizeObserver;
  private frames = 0;
  private fpsT0 = performance.now();
  private showLabels = true;
  private wireVisible = false;
  /** Render on demand: only when the camera, geometry, colours or overlays changed. */
  private dirty = true;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('viewport-canvas');

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'viewport-labels';
    container.appendChild(this.labelLayer);

    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -300, 0);
    this.scene.add(this.camera);

    this.scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x2a2420, 0.9));
    const head = new THREE.DirectionalLight(0xffffff, 1.6);
    head.position.set(0.3, 0.5, 1);
    this.camera.add(head);

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.62,
      metalness: 0.0,
      clippingPlanes: [],
      transparent: false,
    });
    // Darken back faces so the endocardial side is distinguishable through the clip plane.
    this.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n diffuseColor.rgb *= gl_FrontFacing ? 1.0 : 0.55;',
      );
    };
    this.wireMaterial = new THREE.MeshBasicMaterial({
      color: 0x0b1015,
      wireframe: true,
      transparent: true,
      opacity: 0.22,
      clippingPlanes: [],
    });
    this.scene.add(this.loopLines);
    this.scene.add(this.catheters.group);
    this.ghostScene.add(this.catheters.ghost);

    this.controls = new TrackballControls(this.camera, this.renderer.domElement);
    this.controls.rotateSpeed = 3.0;
    this.controls.zoomSpeed = 1.4;
    this.controls.panSpeed = 0.8;
    this.controls.staticMoving = true;
    this.controls.addEventListener('change', () => (this.dirty = true));

    this.gizmo = new OrientationGizmo();

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.pointer = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.hoverDirty = true;
    });
    el.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.onHover?.(null);
    });
    // Click places the catheter; shift-drag drags it across the wall (trackball disabled meanwhile).
    let down: { x: number; y: number; t: number; shift: boolean } | null = null;
    const ndc = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), shift: e.shiftKey };
      if (e.shiftKey) {
        this.controls.enabled = false;
        const h = this.hitAt(ndc(e));
        if (h) this.onDrag?.(h);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (down?.shift && e.buttons & 1) {
        const h = this.hitAt(ndc(e));
        if (h) this.onDrag?.(h);
      }
    });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (down.shift) this.controls.enabled = true;
      else if (moved < 5 && performance.now() - down.t < 400) {
        const h = this.hitAt(ndc(e));
        if (h) this.onSelect?.(h);
      }
      down = null;
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setMesh(mesh: SurfaceMesh, colors: Float32Array): void {
    if (this.shell) {
      this.scene.remove(this.shell, this.wire!);
      this.shell.geometry.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors.slice(), 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeBoundingSphere();
    this.shell = new THREE.Mesh(g, this.material);
    this.wire = new THREE.Mesh(g, this.wireMaterial);
    this.wire.visible = this.wireVisible;
    this.scene.add(this.shell, this.wire);
    this.center.copy(g.boundingSphere!.center);
    this.radius = g.boundingSphere!.radius;
    this.buildLoops(mesh);
    this.applyClip();
  }

  setColors(colors: Float32Array): void {
    if (!this.shell) return;
    const attr = this.shell.geometry.getAttribute('color') as THREE.BufferAttribute;
    (attr.array as Float32Array).set(colors);
    attr.needsUpdate = true;
    this.dirty = true;
  }

  setWireframe(on: boolean): void {
    this.wireVisible = on;
    if (this.wire) this.wire.visible = on;
    this.dirty = true;
  }

  setOpacity(opacity: number): void {
    this.material.transparent = opacity < 0.999;
    this.material.opacity = opacity;
    this.material.depthWrite = opacity >= 0.999;
    this.material.needsUpdate = true;
    this.dirty = true;
  }

  setLabelsVisible(on: boolean): void {
    this.showLabels = on;
    this.loopLines.visible = on;
    this.labelLayer.style.display = on ? '' : 'none';
    this.dirty = true;
  }

  setView(name: ViewName, obliqueDeg = 30): void {
    const v = standardViews(obliqueDeg).find((x) => x.name === name);
    if (!v) return;
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (this.radius * 1.15) / Math.sin(fov / 2);
    this.controls.target.copy(this.center);
    this.camera.position.set(
      this.center.x + v.dir[0] * dist,
      this.center.y + v.dir[1] * dist,
      this.center.z + v.dir[2] * dist,
    );
    this.camera.up.set(v.up[0], v.up[1], v.up[2]);
    this.camera.lookAt(this.center);
    this.controls.update();
    if (this.clip.axis === 'view') this.captureViewNormal();
    this.applyClip();
  }

  setClip(state: ClipState): void {
    const axisChanged = state.axis !== this.clip.axis || (state.enabled && !this.clip.enabled);
    this.clip = { ...state };
    if (axisChanged && state.axis === 'view') this.captureViewNormal();
    this.applyClip();
  }

  /** Re-align a view-aligned clip plane with the current camera direction. */
  alignClipToView(): void {
    this.captureViewNormal();
    this.applyClip();
  }

  get meshRadius(): number {
    return this.radius;
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
  }

  private captureViewNormal(): void {
    // Normal points towards the camera: the half facing the viewer is cut away.
    this.clipViewNormal.copy(this.camera.position).sub(this.controls.target).normalize();
  }

  private applyClip(): void {
    this.dirty = true;
    const planes = this.clip.enabled ? [this.clipPlane] : [];
    this.material.clippingPlanes = planes;
    this.wireMaterial.clippingPlanes = planes;
    if (!this.clip.enabled) return;
    const n = new THREE.Vector3();
    switch (this.clip.axis) {
      case 'view': n.copy(this.clipViewNormal); break;
      case 'LR': n.set(1, 0, 0); break;
      case 'AP': n.set(0, -1, 0); break;
      case 'SI': n.set(0, 0, 1); break;
    }
    if (this.clip.flip) n.negate();
    // three.js keeps the side where n·p + c ≥ 0; we keep the side away from the normal.
    const p = this.center.clone().addScaledVector(n, this.clip.offset);
    this.clipPlane.normal.copy(n).negate();
    this.clipPlane.constant = n.dot(p);
  }

  private buildLoops(mesh: SurfaceMesh): void {
    this.loopLines.clear();
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    for (const loop of mesh.boundaryLoops) {
      const pts: THREE.Vector3[] = [];
      const c = new THREE.Vector3();
      for (const v of loop.vertices) {
        const p = new THREE.Vector3(mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]);
        pts.push(p);
        c.add(p);
      }
      c.multiplyScalar(1 / loop.vertices.length);
      // Newell normal of the opening, oriented away from the mesh centre.
      const normal = new THREE.Vector3();
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
        normal.x += (a.y - b.y) * (a.z + b.z);
        normal.y += (a.z - b.z) * (a.x + b.x);
        normal.z += (a.x - b.x) * (a.y + b.y);
      }
      normal.normalize();
      if (normal.dot(c.clone().sub(this.center)) < 0) normal.negate();
      pts.push(pts[0]!.clone());
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xe9eef2, transparent: true, opacity: 0.8 }),
      );
      this.loopLines.add(line);
      const el = document.createElement('div');
      el.className = 'mesh-label';
      el.textContent = loop.label;
      this.labelLayer.appendChild(el);
      this.labels.push({ el, pos: c, normal });
    }
  }

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.controls.handleResize();
    this.dirty = true;
  }

  /** Request a redraw on the next animation frame. */
  requestRender(): void {
    this.dirty = true;
  }

  private frame(): void {
    this.controls.update();
    if (this.hoverDirty) {
      this.hoverDirty = false;
      this.pick();
    }
    const now = performance.now();
    if (now - this.fpsT0 >= 1000) {
      this.onFps?.((this.frames * 1000) / (now - this.fpsT0));
      this.frames = 0;
      this.fpsT0 = now;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const r = this.renderer;
    const size = r.getSize(new THREE.Vector2());
    r.setViewport(0, 0, size.x, size.y);
    r.setScissorTest(false);
    r.clear();
    r.render(this.scene, this.camera);
    r.render(this.ghostScene, this.camera);
    this.gizmo.render(r, this.camera, size);
    if (this.showLabels) this.updateLabels(size);
    this.frames++;
  }

  private updateLabels(size: THREE.Vector2): void {
    const v = new THREE.Vector3();
    for (const l of this.labels) {
      v.copy(l.pos).project(this.camera);
      const hidden = v.z > 1 || (this.clip.enabled && this.clipPlane.distanceToPoint(l.pos) < 0);
      l.el.style.display = hidden ? 'none' : '';
      // Openings facing away from the camera are behind the shell: dim their labels.
      const facing = l.normal.dot(this.camera.position.clone().sub(l.pos)) > 0;
      l.el.classList.toggle('behind', !facing);
      l.el.style.transform = `translate(${((v.x + 1) / 2) * size.x}px, ${((1 - v.y) / 2) * size.y}px) translate(-50%, -50%)`;
    }
  }

  private pick(): void {
    if (!this.pointer || !this.onHover) return;
    this.onHover(this.hitAt(this.pointer));
  }

  /** Nearest shell vertex under a point in normalized device coordinates (respects the clip plane). */
  hitAt(p: THREE.Vector2): HoverInfo | null {
    if (!this.shell) return null;
    this.raycaster.setFromCamera(p, this.camera);
    const hits = this.raycaster.intersectObject(this.shell, false);
    const hit = hits.find((h) => !this.clip.enabled || this.clipPlane.distanceToPoint(h.point) >= 0);
    if (!hit || !hit.face) return null;
    const pos = this.shell.geometry.getAttribute('position') as THREE.BufferAttribute;
    const cand = [hit.face.a, hit.face.b, hit.face.c];
    let best = cand[0]!, bestD = Infinity;
    for (const v of cand) {
      const d = hit.point.distanceToSquared(new THREE.Vector3(pos.getX(v), pos.getY(v), pos.getZ(v)));
      if (d < bestD) { bestD = d; best = v; }
    }
    return { vertex: best, point: [hit.point.x, hit.point.y, hit.point.z] };
  }

  setCsCatheter(path: number[], electrodes: number[], transseptal: number[]): void {
    this.catheters.setCs(path, electrodes);
    this.catheters.setTransseptal(transseptal);
    this.dirty = true;
  }

  setRoving(f: RovingFrame | null): void {
    this.catheters.setRoving(f);
    this.dirty = true;
  }

  /** Camera right and up directions in world space (for keyboard nudges). */
  screenAxes(): { right: [number, number, number]; up: [number, number, number] } {
    const m = this.camera.matrixWorld.elements;
    return { right: [m[0]!, m[1]!, m[2]!], up: [m[4]!, m[5]!, m[6]!] };
  }
}

/** Small axis triad (L/P/S) rendered in the lower-left corner, following the main camera's rotation. */
class OrientationGizmo {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);

  constructor() {
    const axes: Array<[THREE.Vector3, number, string, string]> = [
      [new THREE.Vector3(1, 0, 0), 0xe4572e, 'L', 'R'],
      [new THREE.Vector3(0, 1, 0), 0x4cb944, 'P', 'A'],
      [new THREE.Vector3(0, 0, 1), 0x3b8ee8, 'S', 'I'],
    ];
    for (const [dir, color, pos, neg] of axes) {
      this.scene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color, 0.25, 0.14));
      this.scene.add(this.sprite(pos, color, dir.clone().multiplyScalar(1.3), 1));
      this.scene.add(this.sprite(neg, color, dir.clone().multiplyScalar(-1.15), 0.55));
    }
  }

  private sprite(text: string, color: number, at: THREE.Vector3, alpha: number): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.globalAlpha = alpha;
    ctx.fillText(text, 32, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    s.position.copy(at);
    s.scale.setScalar(0.45);
    return s;
  }

  render(r: THREE.WebGLRenderer, main: THREE.PerspectiveCamera, size: THREE.Vector2): void {
    const px = Math.round(Math.min(110, size.y * 0.22));
    this.camera.position.set(0, 0, 4).applyQuaternion(main.quaternion);
    this.camera.quaternion.copy(main.quaternion);
    r.clearDepth();
    r.setScissorTest(true);
    r.setScissor(8, 8, px, px);
    r.setViewport(8, 8, px, px);
    r.render(this.scene, this.camera);
    r.setScissorTest(false);
  }
}

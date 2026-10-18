import * as THREE from 'three';
import { CATHETER_RADIUS, electrodeOffsets, RING_LENGTH, TIP_LENGTH } from '../core/catheter/roving';
import type { RovingFrame } from '../engine/protocol';

/**
 * Catheter graphics: the fixed CS decapolar and the roving catheter (shaft, tip and ring
 * electrodes, contact-force vector). Every mesh has a "ghost" twin drawn without depth testing,
 * so catheters stay visible inside an opaque shell, as on mapping-system displays.
 */
const SHAFT = 0x2b4a66;
const CS_SHAFT = 0x5a4b7a;
const METAL = 0xc9ced6;
const TIP = 0xe0b04a;

const v3 = (a: ArrayLike<number>, i = 0) => new THREE.Vector3(a[3 * i]!, a[3 * i + 1]!, a[3 * i + 2]!);

export class CatheterView {
  readonly group = new THREE.Group();
  readonly ghost = new THREE.Group();
  private cs = new THREE.Group();
  private csGhost = new THREE.Group();
  private rov = new THREE.Group();
  private rovGhost = new THREE.Group();
  private shaft: THREE.Mesh;
  private shaftGhost: THREE.Mesh;
  private electrodes: THREE.Mesh[] = [];
  private electrodesGhost: THREE.Mesh[] = [];
  private arrow: THREE.ArrowHelper;
  private transseptal = new THREE.Vector3();

  constructor() {
    this.group.add(this.cs, this.rov);
    this.ghost.add(this.csGhost, this.rovGhost);
    this.shaft = new THREE.Mesh(new THREE.BufferGeometry(), solid(SHAFT));
    this.shaftGhost = new THREE.Mesh(this.shaft.geometry, ghost(SHAFT));
    this.rov.add(this.shaft);
    this.rovGhost.add(this.shaftGhost);
    for (let k = 0; k < 4; k++) {
      const len = k === 0 ? TIP_LENGTH : RING_LENGTH;
      const geo = new THREE.CylinderGeometry(CATHETER_RADIUS * 1.04, CATHETER_RADIUS * 1.04, len, 20, 1, false);
      if (k === 0) geo.translate(0, 0, 0);
      const m = new THREE.Mesh(geo, solid(k === 0 ? TIP : METAL, 0.35));
      const g = new THREE.Mesh(geo, ghost(k === 0 ? TIP : METAL));
      this.electrodes.push(m);
      this.electrodesGhost.push(g);
      this.rov.add(m);
      this.rovGhost.add(g);
    }
    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 5, 0x45c46b, 2, 1.4);
    (this.arrow.line.material as THREE.LineBasicMaterial).depthTest = false;
    (this.arrow.cone.material as THREE.MeshBasicMaterial).depthTest = false;
    this.arrow.renderOrder = 10;
    this.rovGhost.add(this.arrow);
    this.rov.visible = this.rovGhost.visible = false;
  }

  setCs(path: number[], electrodes: number[]): void {
    for (const g of [this.cs, this.csGhost]) {
      g.children.forEach((c) => (c as THREE.Mesh).geometry?.dispose());
      g.clear();
    }
    const pts = Array.from({ length: path.length / 3 }, (_, i) => v3(path, i));
    if (pts.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.TubeGeometry(curve, pts.length * 3, 0.9, 10, false);
    this.cs.add(new THREE.Mesh(tube, solid(CS_SHAFT)));
    this.csGhost.add(new THREE.Mesh(tube, ghost(CS_SHAFT)));
    const ringGeo = new THREE.CylinderGeometry(1.0, 1.0, 1.5, 16);
    for (let i = 0; i < electrodes.length / 3; i++) {
      const p = v3(electrodes, i);
      // Orient along the local path tangent (nearest path point).
      let best = 0, bd = Infinity;
      pts.forEach((q, k) => { const d = q.distanceToSquared(p); if (d < bd) { bd = d; best = k; } });
      const a = pts[Math.max(0, best - 1)]!, b = pts[Math.min(pts.length - 1, best + 1)]!;
      const dir = b.clone().sub(a).normalize();
      for (const [grp, mat] of [[this.cs, solid(METAL, 0.35)], [this.csGhost, ghost(METAL)]] as const) {
        const m = new THREE.Mesh(ringGeo, mat);
        m.position.copy(p);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        grp.add(m);
      }
    }
  }

  setTransseptal(p: number[]): void {
    this.transseptal.set(p[0]!, p[1]!, p[2]!);
  }

  setRoving(f: RovingFrame | null): void {
    const show = !!f;
    this.rov.visible = this.rovGhost.visible = show;
    if (!f) return;
    const axis = v3(f.axis), tipEnd = v3(f.tipEnd), normal = v3(f.normal);
    const offs = electrodeOffsets(f.config.spacing);
    const back = tipEnd.clone().addScaledVector(axis, offs[3]! + 1);
    // Shaft: from the transseptal entry, curving into the axis behind the proximal ring.
    const entryDir = back.clone().sub(this.transseptal).normalize();
    const pts = [
      this.transseptal.clone(),
      this.transseptal.clone().addScaledVector(entryDir, 10),
      back.clone().addScaledVector(axis, 18),
      back.clone().addScaledVector(axis, 6),
      back,
      tipEnd.clone().addScaledVector(axis, TIP_LENGTH),
    ];
    this.shaft.geometry.dispose();
    this.shaft.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, CATHETER_RADIUS, 12, false);
    this.shaftGhost.geometry = this.shaft.geometry;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    for (let k = 0; k < 4; k++) {
      const c = v3(f.electrodes, k);
      for (const m of [this.electrodes[k]!, this.electrodesGhost[k]!]) {
        m.position.copy(c);
        m.quaternion.copy(q);
      }
    }
    // Contact-force vector: along the catheter into the wall, length ∝ force.
    const forceDir = axis.clone().negate();
    const color = f.force < 5 ? 0x8aa0b4 : f.force <= 40 ? 0x45c46b : 0xe0533d;
    this.arrow.position.copy(tipEnd);
    this.arrow.setDirection(forceDir);
    this.arrow.setLength(3 + f.force * 0.35, 2, 1.4);
    this.arrow.setColor(color);
    void normal;
  }
}

function solid(color: number, metalness = 0.1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness });
}

function ghost(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false });
}

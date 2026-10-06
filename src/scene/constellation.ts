// Faint lines joining one person's devices, drawn from live star positions so
// they follow the stars while galaxies regroup.

import * as THREE from 'three';

export class Constellation {
  readonly lines: THREE.LineSegments;
  private members: number[] = [];
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.LineBasicMaterial({
    color: new THREE.Color('#c7d2fe'),
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  constructor() {
    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }

  set(members: number[]): void {
    this.members = members.length > 1 ? members : [];
    this.lines.visible = this.members.length > 1;
    // Every pair: a person rarely has more than four devices.
    const pairs = (this.members.length * (this.members.length - 1)) / 2;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(pairs, 1) * 6), 3));
  }

  get indices(): readonly number[] {
    return this.members;
  }

  update(pos: Float32Array, time: number): void {
    if (!this.lines.visible) return;
    const out = this.geometry.attributes.position.array as Float32Array;
    let o = 0;
    const m = this.members;
    for (let a = 0; a < m.length; a++) {
      for (let b = a + 1; b < m.length; b++) {
        for (const i of [m[a], m[b]]) {
          out[o++] = pos[i * 3];
          out[o++] = pos[i * 3 + 1];
          out[o++] = pos[i * 3 + 2];
        }
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.material.opacity = 0.4 + Math.sin(time * 2.2) * 0.15;
  }
}

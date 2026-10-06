// One THREE.Points cloud for the whole fleet. Positions and colors are eased on
// the CPU (cheap even at 30k devices, and it keeps picking exact); the shader
// only handles glow, twinkle, hover and the patch "flash".

import * as THREE from 'three';

const vertex = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aFlash;
  attribute float aSeed;
  attribute float aIndex;
  uniform float uTime;
  uniform float uScale;
  uniform float uHover;
  uniform float uSelected;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFlash;
  varying float vSelected;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float twinkle = 0.86 + 0.14 * sin(uTime * (0.6 + aSeed * 1.8) + aSeed * 40.0);
    float hover = abs(aIndex - uHover) < 0.5 ? 2.0 : 1.0;
    float sel = abs(aIndex - uSelected) < 0.5 ? 1.0 : 0.0;
    float size = aSize * twinkle * hover * (1.0 + aFlash * 1.6) * (1.0 + sel * 2.2);
    // Softer than true perspective so distant galaxies stay visible.
    gl_PointSize = clamp(size * uScale / pow(-mv.z, 0.6), 1.5, 72.0);
    gl_Position = projectionMatrix * mv;
    vColor = color;
    vAlpha = aAlpha;
    vFlash = aFlash;
    vSelected = sel;
  }
`;

const fragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFlash;
  varying float vSelected;

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p) * 2.0;
    if (d > 1.0) discard;
    float core = exp(-d * d * 22.0);
    float halo = exp(-d * d * 4.5) * 0.42;
    vec3 col = vColor * (core * 1.4 + halo) + vec3(1.0) * core * 0.55;
    col += vec3(0.85, 1.0, 0.92) * vFlash * vFlash * core * 1.4;
    float ring = vSelected * smoothstep(0.08, 0.0, abs(d - 0.78)) * 0.9;
    col += vec3(1.0) * ring;
    float a = (core + halo + ring) * vAlpha;
    gl_FragColor = vec4(col * a, a);
  }
`;

export class Stars {
  readonly points: THREE.Points;
  readonly geometry = new THREE.BufferGeometry();
  readonly material: THREE.ShaderMaterial;
  readonly count: number;

  /** What is drawn this frame. */
  readonly pos: Float32Array;
  readonly col: Float32Array;
  readonly size: Float32Array;
  readonly alpha: Float32Array;
  readonly flash: Float32Array;

  private fromPos: Float32Array;
  private toPos: Float32Array;
  private fromCol: Float32Array;
  private toCol: Float32Array;
  private toSize: Float32Array;
  private toAlpha: Float32Array;
  private posT = 1;
  private colT = 1;

  constructor(count: number) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.size = new Float32Array(count).fill(1);
    this.alpha = new Float32Array(count).fill(1);
    this.flash = new Float32Array(count);
    this.fromPos = new Float32Array(count * 3);
    this.toPos = new Float32Array(count * 3);
    this.fromCol = new Float32Array(count * 3);
    this.toCol = new Float32Array(count * 3);
    this.toSize = new Float32Array(count).fill(1);
    this.toAlpha = new Float32Array(count).fill(1);

    const seed = new Float32Array(count);
    const index = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      seed[i] = ((i * 2654435761) >>> 0) / 4294967296;
      index[i] = i;
    }

    const g = this.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aFlash', new THREE.BufferAttribute(this.flash, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('aIndex', new THREE.BufferAttribute(index, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 300 },
        uHover: { value: -1 },
        uSelected: { value: -1 },
      },
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
  }

  /** Ease to new positions. `instant` skips the animation (first load). */
  setPositions(target: Float32Array, instant = false): void {
    this.fromPos.set(this.pos);
    this.toPos.set(target);
    this.posT = instant ? 1 : 0;
    if (instant) this.pos.set(target);
    this.geometry.attributes.position.needsUpdate = true;
  }

  setStyle(colors: Float32Array, sizes: Float32Array, alphas: Float32Array, instant = false): void {
    this.fromCol.set(this.col);
    this.toCol.set(colors);
    this.toSize.set(sizes);
    this.toAlpha.set(alphas);
    this.colT = instant ? 1 : 0;
    if (instant) {
      this.col.set(colors);
      this.size.set(sizes);
      this.alpha.set(alphas);
      this.markStyle();
    }
  }

  update(dt: number, time: number): void {
    this.material.uniforms.uTime.value = time;

    if (this.posT < 1) {
      this.posT = Math.min(1, this.posT + dt / 1.6);
      const e = easeInOutCubic(this.posT);
      // Stagger by index so stars peel off in waves rather than moving as one block.
      for (let i = 0; i < this.count; i++) {
        const lag = ((i * 7919) % 1000) / 1000 * 0.35;
        const t = Math.min(1, Math.max(0, (e - lag) / (1 - lag)));
        const k = easeInOutCubic(t);
        for (let c = 0; c < 3; c++) {
          const j = i * 3 + c;
          this.pos[j] = this.fromPos[j] + (this.toPos[j] - this.fromPos[j]) * k;
        }
      }
      this.geometry.attributes.position.needsUpdate = true;
    }

    if (this.colT < 1) {
      this.colT = Math.min(1, this.colT + dt / 0.6);
      const k = easeInOutCubic(this.colT);
      for (let j = 0; j < this.count * 3; j++) this.col[j] = this.fromCol[j] + (this.toCol[j] - this.fromCol[j]) * k;
      for (let i = 0; i < this.count; i++) {
        this.size[i] += (this.toSize[i] - this.size[i]) * Math.min(1, k * 1.2);
        this.alpha[i] += (this.toAlpha[i] - this.alpha[i]) * Math.min(1, k * 1.2);
      }
      this.markStyle();
    }

    let anyFlash = false;
    for (let i = 0; i < this.count; i++) {
      if (this.flash[i] > 0) {
        this.flash[i] = Math.max(0, this.flash[i] - dt * 2.2);
        anyFlash = true;
      }
    }
    if (anyFlash) this.geometry.attributes.aFlash.needsUpdate = true;
  }

  /** Set one star's color immediately (used by the replay). */
  setColorNow(i: number, r: number, g: number, b: number): void {
    this.col[i * 3] = this.toCol[i * 3] = r;
    this.col[i * 3 + 1] = this.toCol[i * 3 + 1] = g;
    this.col[i * 3 + 2] = this.toCol[i * 3 + 2] = b;
    this.geometry.attributes.color.needsUpdate = true;
  }

  pulse(i: number, strength = 1): void {
    this.flash[i] = Math.max(this.flash[i], strength);
    this.geometry.attributes.aFlash.needsUpdate = true;
  }

  get animating(): boolean {
    return this.posT < 1;
  }

  private markStyle(): void {
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

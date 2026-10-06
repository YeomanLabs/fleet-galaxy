// Deep-space backdrop: a faint nebula on the inside of a big sphere, a field of
// distant stars, and a soft glow at the heart of each galaxy tinted by its health.

import * as THREE from 'three';
import { mulberry32 } from '../data/rng';
import type { GroupInfo } from './layout';

const nebulaVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const nebulaFragment = /* glsl */ `
  varying vec3 vDir;
  uniform float uTime;

  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    float n = fbm(d * 2.4 + vec3(0.0, uTime * 0.004, 0.0));
    float m = fbm(d * 5.0 - vec3(uTime * 0.003));
    // A diagonal band, like looking along a galactic plane.
    float band = exp(-pow(d.y * 2.2 + d.x * 0.6, 2.0) * 2.0);
    vec3 deep = vec3(0.012, 0.016, 0.035);
    vec3 violet = vec3(0.1, 0.045, 0.19);
    vec3 teal = vec3(0.03, 0.16, 0.2);
    vec3 col = deep;
    col += violet * smoothstep(0.45, 0.85, n) * (0.35 + band * 0.9);
    col += teal * smoothstep(0.5, 0.9, m) * band * 0.8;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createNebula(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    vertexShader: nebulaVertex,
    fragmentShader: nebulaFragment,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 32), mat);
  mesh.renderOrder = -2;
  return mesh;
}

export function createDust(count = 6000): THREE.Points {
  const rand = mulberry32(7);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = 1200 + rand() * 2400;
    const s = Math.sqrt(1 - u * u);
    pos[i * 3] = Math.cos(t) * s * r;
    pos[i * 3 + 1] = u * r;
    pos[i * 3 + 2] = Math.sin(t) * s * r;
    const warm = rand();
    const b = 0.35 + rand() * 0.65;
    col[i * 3] = b * (warm > 0.8 ? 1 : 0.8);
    col[i * 3 + 1] = b * 0.85;
    col[i * 3 + 2] = b * (warm < 0.3 ? 1 : 0.9);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({
    size: 1.2,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  const p = new THREE.Points(g, m);
  p.renderOrder = -1;
  return p;
}

let glowTexture: THREE.Texture | null = null;

function getGlowTexture(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.15, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

/** One soft glow per galaxy core. */
export class Cores {
  readonly group = new THREE.Group();
  private sprites: THREE.Sprite[] = [];

  set(groups: GroupInfo[], colors: string[]): void {
    for (const s of this.sprites) {
      this.group.remove(s);
      s.material.dispose();
    }
    this.sprites = groups.map((g, i) => {
      const mat = new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color: new THREE.Color(colors[i]),
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const s = new THREE.Sprite(mat);
      s.position.set(...g.center);
      s.scale.setScalar(g.radius * 1.15);
      this.group.add(s);
      return s;
    });
  }

  tint(colors: string[]): void {
    this.sprites.forEach((s, i) => s.material.color.set(colors[i]));
  }
}

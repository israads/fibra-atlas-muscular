import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import PARTS from './parts.json';
import { MUSCLES } from './muscles.js';
import { GROUPS, SEVERITY } from './groups.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const C = {
  muscle: new THREE.Color('#a8483f'),
  tendon: new THREE.Color('#e4dccd'),
  bone: new THREE.Color('#ece7dc'),
  dim: new THREE.Color('#cfc7c2'),
  white: new THREE.Color('#ffffff'),
  select: new THREE.Color('#1b6c80'),
  sev: { 1: new THREE.Color(SEVERITY[1].color), 2: new THREE.Color(SEVERITY[2].color), 3: new THREE.Color(SEVERITY[3].color) },
};
// Complexión: ensancha el cuerpo sin cambiar la altura.
const GIRTH_X = 1.14, GIRTH_Z = 1.2;
const TENDON = /tendon|ligament|linea alba|tract|retinaculum|aponeurosis/;
const SIDE_NAME = { L: 'izquierdo', R: 'derecho' };
const SIDE_NAME_F = { L: 'izquierda', R: 'derecha' };

// Dirección desde la que se mira cada zona (s = signo del lado).
const VIEW = {
  espalda: () => [0, 0.12, -1], cadera: (s) => [s * 0.55, 0.1, -1],
  hombro: (s) => [s * 0.75, 0.25, 0.8], brazo: (s) => [s * 0.8, 0.1, 0.75], antebrazo: (s) => [s * 0.8, 0.1, 0.75],
  muslo: (s) => [s * 0.45, 0.08, 1], pierna: (s) => [s * 0.8, 0.08, 0.7],
};

function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return ((h >>> 0) % 1000) / 1000; }

export function zoneLabel(region, side, regions) {
  const r = regions.find((x) => x.id === region);
  if (!r) return '';
  if (!r.lados || !side) return r.name;
  const fem = ['cadera', 'pierna'].includes(region);
  return `${r.name} ${fem ? SIDE_NAME_F[side] : SIDE_NAME[side]}`;
}

export async function createViewer(container, state, handlers, onProgress) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  scene.add(camera);
  const key = new THREE.DirectionalLight(0xfff4ea, 2.0); key.position.set(-1.2, 1.6, 2); camera.add(key);
  const rim = new THREE.DirectionalLight(0xdfeaf2, 1.2); rim.position.set(2, 0.5, -1.5); camera.add(rim);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xa89f98, 0.45));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.09;
  controls.zoomToCursor = true; controls.rotateSpeed = 0.9;
  controls.minDistance = 0.12; controls.maxDistance = 7;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

  // --- Modelo
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await new Promise((res, rej) => loader.load(`${import.meta.env.BASE_URL}model/body.glb`, res, (e) => onProgress?.(e.total ? e.loaded / e.total : 0), rej));
  gltf.scene.updateMatrixWorld(true);
  const root = new THREE.Group(); scene.add(root);
  const parts = []; const byId = {}; const bones = [];
  const v = new THREE.Vector3();
  const meshes = []; gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const src of meshes) {
    const id = src.name || src.parent?.name; const info = PARTS[id];
    if (!info) continue;
    // Hornea la descuantización: posiciones en metros, en espacio de mundo.
    const p = src.geometry.attributes.position; const arr = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(src.matrixWorld); arr[i * 3] = v.x * GIRTH_X; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z * GIRTH_Z; }
    const n = src.geometry.attributes.normal; const narr = new Float32Array(n.count * 3);
    for (let i = 0; i < n.count; i++) { v.fromBufferAttribute(n, i).normalize(); narr[i * 3] = v.x; narr[i * 3 + 1] = v.y; narr[i * 3 + 2] = v.z; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(narr, 3));
    geo.setIndex(src.geometry.index);
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    if (info.kind === 'bone') {
      const mesh = new THREE.Mesh(geo, null); mesh.userData.center = geo.boundingSphere.center.clone();
      bones.push(mesh); root.add(mesh); continue;
    }
    const meta = MUSCLES[info.base]; if (!meta) continue;
    const group = GROUPS[meta[1]];
    const sided = ['hombro', 'brazo', 'antebrazo', 'cadera', 'muslo', 'pierna'].includes(group.region);
    const side = info.side === 'C' ? null : info.side;
    const base = (TENDON.test(info.base) ? C.tendon : C.muscle).clone();
    const t = hash(id); base.offsetHSL((t - 0.5) * 0.018, (t - 0.5) * 0.06, (hash(id + 'l') - 0.5) * 0.07);
    const mat = new THREE.MeshStandardMaterial({ color: base.clone(), roughness: 0.62, metalness: 0.0, emissiveIntensity: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    geo.computeBoundsTree();
    const part = {
      id, mesh, base, baseKey: info.base, side, name: meta[0], action: meta[2], groupId: meta[1], group,
      region: group.region, zone: sided && side ? `${group.region}:${side}` : group.region,
      label: side ? `${meta[0]} ${SIDE_NAME[side]}` : meta[0], target: base.clone(), emissive: 0,
    };
    mesh.userData.part = part; parts.push(part); byId[id] = part; root.add(mesh);
  }
  const boneMat = new THREE.MeshStandardMaterial({ color: C.bone, roughness: 0.8 });
  bones.forEach((b) => { b.material = boneMat; });

  // Contorno del músculo seleccionado (casco invertido).
  const outlineMat = new THREE.MeshBasicMaterial({ color: 0x131416, side: THREE.BackSide, polygonOffset: true, polygonOffsetFactor: 6, polygonOffsetUnits: 6 });
  outlineMat.onBeforeCompile = (s) => { s.vertexShader = s.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = position + normal * 0.0011;'); };
  const outlines = new Map();

  const bodyBox = new THREE.Box3(); parts.forEach((p) => bodyBox.union(p.mesh.geometry.boundingBox));
  const zoneBox = {};
  for (const p of parts) (zoneBox[p.zone] ??= new THREE.Box3()).union(p.mesh.geometry.boundingBox);

  // --- Cámara
  let dirty = true; let fly = null;
  const invalidate = () => { dirty = true; };
  controls.addEventListener('change', invalidate);

  function fit(box, dir, pad = 1.12, ms = 800) {
    const sph = box.getBoundingSphere(new THREE.Sphere());
    const vfov = THREE.MathUtils.degToRad(camera.fov) / 2;
    const hfov = Math.atan(Math.tan(vfov) * camera.aspect);
    // Encaje por caja: alto contra fov vertical, ancho contra horizontal.
    const size = box.getSize(new THREE.Vector3());
    const d = new THREE.Vector3(...dir).normalize();
    const w = Math.hypot(size.x * Math.abs(d.z), size.z * Math.abs(d.x)) + Math.min(size.x, size.z) * 0.3;
    const dist = Math.max((size.y / 2) / Math.tan(vfov), (w / 2) / Math.tan(hfov)) * pad + sph.radius * 0.35;
    const toPos = sph.center.clone().addScaledVector(d, dist);
    if (!ms) { camera.position.copy(toPos); controls.target.copy(sph.center); controls.update(); invalidate(); return; }
    fly = { t0: performance.now(), ms, p0: camera.position.clone(), p1: toPos, c0: controls.target.clone(), c1: sph.center.clone() };
    invalidate();
  }
  function focusZone(zone, ms) {
    if (!zone) return fit(bodyBox, [0, 0.02, 1], container.clientWidth < 900 ? 1.3 : 1.06, ms);
    const [region, side] = zone.split(':');
    const s = side === 'R' ? -1 : 1;
    fit(zoneBox[zone], (VIEW[region] || (() => [0, 0.08, 1]))(s), 1.3, ms);
  }
  function focusPart(id) { const p = byId[id]; if (p) fit(p.mesh.geometry.boundingBox.clone().expandByScalar(0.06), camera.position.clone().sub(controls.target).toArray(), 1.5, 600); }
  function focusIds(ids) { const box = new THREE.Box3(); for (const id of ids) if (byId[id]) box.union(byId[id].mesh.geometry.boundingBox); if (!box.isEmpty()) fit(box.expandByScalar(0.04), camera.position.clone().sub(controls.target).toArray(), 1.25, 700); }
  function orbitTo(dir) {
    const dist = camera.position.distanceTo(controls.target);
    fly = { t0: performance.now(), ms: 600, p0: camera.position.clone(), p1: controls.target.clone().addScaledVector(new THREE.Vector3(...dir).normalize(), dist), c0: controls.target.clone(), c1: controls.target.clone(), arc: true };
    invalidate();
  }
  function zoom(f) { const d = camera.position.clone().sub(controls.target); const l = THREE.MathUtils.clamp(d.length() * f, controls.minDistance, controls.maxDistance); camera.position.copy(controls.target).addScaledVector(d.normalize(), l); controls.update(); invalidate(); }

  // --- Apariencia según el estado
  function refresh() {
    const { zone, isolate, onlyInjured, hidden, injuries, sel, hover, hoverZone, skeleton } = state;
    const chain = sel.size > 1 || state.multiMode;
    const anyInjury = Object.keys(injuries).length > 0;
    for (const p of parts) {
      const sev = injuries[p.id];
      const inZone = !zone || p.zone === zone;
      p.mesh.visible = !hidden.has(p.id) && (!isolate || inZone) && (!onlyInjured || !anyInjury || !!sev);
      p.pickable = p.mesh.visible;
      p.target.copy(sev ? C.sev[sev] : p.base);
      if (anyInjury && !sev) p.target.lerp(C.dim, 0.3);
      const picked = sel.has(p.id);
      if (picked && chain && !sev) p.target.copy(C.select);
      else if (!inZone && !sev) p.target.lerp(C.dim, 0.8);
      else if (!inZone && !picked) p.target.lerp(C.dim, 0.25);
      else if (chain && sel.size && !picked && !sev) p.target.lerp(C.dim, 0.55);
      if (!zone && hoverZone && p.zone === hoverZone) p.target.lerp(C.white, 0.28);
      if (hover === p.id) p.target.lerp(C.white, sev ? 0.14 : 0.3);
      if (picked && !chain && !sev) p.target.lerp(C.white, 0.28);
      p.emissive = picked ? (sev ? 0.08 : 0.18) : 0;
    }
    const zb = zone && zoneBox[zone] ? zoneBox[zone].clone().expandByScalar(0.05) : null;
    for (const b of bones) b.visible = skeleton && (!isolate || !zb || zb.containsPoint(b.userData.center));
    for (const [id, o] of outlines) if (!sel.has(id) || !byId[id].mesh.visible) { root.remove(o); outlines.delete(id); }
    for (const id of sel) { const p = byId[id]; if (p && p.mesh.visible && !outlines.has(id)) { const o = new THREE.Mesh(p.mesh.geometry, outlineMat); outlines.set(id, o); root.add(o); } }
    invalidate(); settle = 30;
  }
  let settle = 30;

  // --- Selección con el puntero
  const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
  const ndc = new THREE.Vector2();
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(parts.filter((p) => p.pickable).map((p) => p.mesh), false)[0];
    return hit ? hit.object.userData.part : null;
  }
  let down = null; let moveEv = null;
  const el = renderer.domElement;
  const active = new Set(); let lp = null;
  el.addEventListener('pointerdown', (e) => {
    active.add(e.pointerId); clearTimeout(lp);
    if (active.size > 1) { down = null; return; }
    down = { x: e.clientX, y: e.clientY, btn: e.button };
    // Pulsación larga en pantalla táctil: abre el menú del músculo.
    if (e.pointerType === 'touch') lp = setTimeout(() => { if (!down) return; down = null; const p = pick(e); if (p) { navigator.vibrate?.(12); handlers.onMenu(p, e); } }, 480);
  });
  el.addEventListener('pointermove', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) clearTimeout(lp);
    if (e.pointerType !== 'touch') moveEv = e;
  });
  el.addEventListener('pointerleave', () => { moveEv = null; handlers.onHover(null, null); });
  el.addEventListener('pointercancel', (e) => { active.delete(e.pointerId); clearTimeout(lp); down = null; });
  el.addEventListener('pointerup', (e) => {
    active.delete(e.pointerId); clearTimeout(lp);
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) { down = null; return; }
    const btn = down.btn; down = null; const p = pick(e);
    if (btn === 2) { if (p) handlers.onMenu(p, e); } else handlers.onPick(p, e);
  });
  el.addEventListener('dblclick', (e) => { const p = pick(e); if (p) handlers.onMenu(p, e); });
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  function resize() {
    const w = container.clientWidth, h = container.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); invalidate();
  }
  new ResizeObserver(resize).observe(container); resize();

  const ease = (t) => 1 - Math.pow(1 - t, 3);
  renderer.setAnimationLoop(() => {
    if (moveEv && !down) { const p = pick(moveEv); handlers.onHover(p, moveEv); moveEv = null; }
    if (fly) {
      const t = Math.min(1, (performance.now() - fly.t0) / fly.ms); const k = ease(t);
      controls.target.lerpVectors(fly.c0, fly.c1, k);
      if (fly.arc) {
        const a = fly.p0.clone().sub(fly.c0), b = fly.p1.clone().sub(fly.c1); const len = a.length();
        const q = new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize());
        camera.position.copy(a.normalize().applyQuaternion(new THREE.Quaternion().slerp(q, k)).multiplyScalar(len).add(controls.target));
      } else camera.position.lerpVectors(fly.p0, fly.p1, k);
      if (t >= 1) fly = null; dirty = true;
    }
    if (controls.update()) dirty = true;
    if (settle > 0) {
      settle--; dirty = true;
      for (const p of parts) { p.mesh.material.color.lerp(p.target, 0.25); const e = p.mesh.material.emissiveIntensity; p.mesh.material.emissive.copy(p.mesh.material.color); p.mesh.material.emissiveIntensity = e + (p.emissive - e) * 0.25; }
    }
    if (dirty) { dirty = false; renderer.render(scene, camera); }
  });

  focusZone(null, 0); refresh();
  const snapshot = () => { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/jpeg', 0.9); };
  return { parts, byId, refresh, focusZone, focusPart, focusIds, orbitTo, zoom, invalidate, snapshot };
}

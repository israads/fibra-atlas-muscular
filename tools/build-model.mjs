// Convierte los STL de BodyParts3D (músculos y huesos) en un único GLB optimizado.
// Uso: node tools/build-model.mjs <carpeta-con-stl>
import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';

const dir = process.argv[2];
const parts = JSON.parse(fs.readFileSync(new URL('./parts-source.json', import.meta.url)));
await MeshoptSimplifier.ready; await MeshoptEncoder.ready;

function readStl(file) {
  const b = fs.readFileSync(file);
  const n = b.readUInt32LE(80);
  const map = new Map(); const pos = []; const idx = new Uint32Array(n * 3);
  let o = 84;
  for (let i = 0; i < n; i++, o += 50) {
    for (let k = 0; k < 3; k++) {
      const p = o + 12 + k * 12;
      const key = b.toString('latin1', p, p + 12);
      let id = map.get(key);
      if (id === undefined) {
        id = pos.length / 3; map.set(key, id);
        const x = b.readFloatLE(p), y = b.readFloatLE(p + 4), z = b.readFloatLE(p + 8);
        pos.push(x * 0.001, z * 0.001, -y * 0.001); // Z arriba (mm) -> Y arriba (m)
      }
      idx[i * 3 + k] = id;
    }
  }
  return { pos: new Float32Array(pos), idx };
}

function compact(pos, idx) {
  const remap = new Int32Array(pos.length / 3).fill(-1); const out = []; let c = 0;
  const ni = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    if (remap[v] < 0) { remap[v] = c++; out.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); }
    ni[i] = remap[v];
  }
  return { pos: new Float32Array(out), idx: ni };
}

function normals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('body');
const out = {}; let total = 0;
const ids = Object.keys(parts).filter((id) => ['muscle', 'bone'].includes(parts[id].kind) && !/choroid/.test(parts[id].name));
for (const id of ids) {
  const file = path.join(dir, id + '.stl');
  if (!fs.existsSync(file)) { console.warn('falta', id); continue; }
  const p = parts[id];
  const raw = readStl(file);
  const tris = raw.idx.length / 3;
  const ratio = p.kind === 'muscle' ? 0.045 : 0.07;
  const target = Math.min(tris, Math.max(p.kind === 'muscle' ? 700 : 300, Math.round(tris * ratio)));
  const [sidx] = MeshoptSimplifier.simplify(raw.idx, raw.pos, 3, target * 3, 0.02);
  const m = compact(raw.pos, sidx);
  total += m.idx.length / 3;
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(m.pos).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normals(m.pos, m.idx)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(m.idx).setBuffer(buffer));
  scene.addChild(doc.createNode(id).setMesh(doc.createMesh(id).addPrimitive(prim)));
  out[id] = { en: p.name, kind: p.kind, side: p.side, base: p.base };
}
console.log('piezas', Object.keys(out).length, 'triángulos', total);
doc.createExtension(KHRMeshQuantization).setRequired(true);
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
await doc.transform(quantize({ quantizePosition: 14, quantizeNormal: 8 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const dest = new URL('../public/model/body.glb', import.meta.url);
await io.write(dest.pathname, doc);
fs.writeFileSync(new URL('../src/parts.json', import.meta.url), JSON.stringify(out));
console.log('GLB', (fs.statSync(dest).size / 1e6).toFixed(1), 'MB');

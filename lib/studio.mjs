// Tripo Studio 内部接口的共享实现：HTTP/代理、会话、上传、任务轮询、下载与本地格式转换
// MCP（server.mjs）和官方 API 兼容网关（gateway.mjs）都用这里
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const HOME = path.join(os.homedir(), '.tripo');
export const STATE = process.env.TRIPO_STUDIO_STATE || path.join(HOME, 'studio-state.json');
const CONFIG = process.env.TRIPO_STUDIO_CONFIG || path.join(HOME, 'config.json');
const BASE = 'https://api.tripo3d.ai/v2/studio';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSIMP_DIR = process.env.TRIPO_ASSIMP_DIR || path.join(HERE, '..', 'vendor', 'assimp');
const require = createRequire(import.meta.url);
const UA = process.env.TRIPO_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

// 代理优先级：TRIPO_NO_PROXY > TRIPO_PROXY > HTTPS_PROXY > 配置文件里的 proxy
export const CONF = readConfig();
const PROXY = process.env.TRIPO_NO_PROXY
  ? ''
  : (process.env.TRIPO_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || CONF.proxy || '');

export const DEFAULT_MODEL = CONF.model_version || 'v3.1-20260211';

/* ---------- HTTP（带代理 CONNECT 隧道） ---------- */

function tunnelSocket(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const req = http.request({
      host: p.hostname, port: p.port || 80, method: 'CONNECT',
      path: `${host}:${port}`, headers: { host: `${host}:${port}` },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('proxy CONNECT ' + res.statusCode));
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
}

export async function request(method, urlStr, { headers = {}, body = null, binary = false, direct = undefined } = {}) {
  const u = new URL(urlStr);
  const host = u.hostname;
  const port = u.port || 443;
  // S3 走代理时常在 TLS 握手阶段被重置，这类主机默认直连
  const defaultProxy = direct !== undefined ? !direct : Boolean(PROXY) && !/(^|\.)amazonaws\.com$/.test(host);

  const attempt = (withProxy) => new Promise((resolve, reject) => {
    const opts = { method, host, port, path: u.pathname + u.search, headers: { ...headers, host } };
    if (body) opts.headers['content-length'] = Buffer.byteLength(body);
    if (withProxy) {
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = (o, cb) => {
        tunnelSocket(PROXY, host, port)
          .then((sock) => {
            const t = tls.connect({ socket: sock, servername: host });
            t.once('secureConnect', () => cb(null, t));
            t.once('error', cb);
          })
          .catch(cb);
      };
      opts.agent = agent;
    }
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buf, text: binary ? '' : buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

  const attemptWithRetry = async (withProxy, times = 3) => {
    let lastErr;
    for (let i = 0; i < times; i++) {
      try { return await attempt(withProxy); } catch (e) {
        lastErr = e;
        if (!['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(e.code)) throw e;
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
    throw lastErr;
  };

  try {
    return await attemptWithRetry(defaultProxy, 3);
  } catch (e) {
    // 代理连通性坏掉时退回直连，避免整条链路被挡死
    if (defaultProxy) return attemptWithRetry(false, 2);
    throw e;
  }
}

/* ---------- 会话 ---------- */

export function cookieHeader() {
  if (!fs.existsSync(STATE)) {
    throw new Error(`找不到登录态文件 ${STATE}：先运行 npm run login 登录 Tripo Studio（或用 TRIPO_STUDIO_STATE 指定路径）`);
  }
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  return st.cookies.filter((c) => /tripo3d/.test(c.domain)).map((c) => `${c.name}=${c.value}`).join('; ');
}

export function apiHeaders(extra = {}) {
  return {
    cookie: cookieHeader(),
    'user-agent': UA,
    origin: 'https://studio.tripo3d.ai',
    referer: 'https://studio.tripo3d.ai/',
    'content-type': 'application/json',
    ...extra,
  };
}

export async function api(method, p, body) {
  const r = await request(method, BASE + p, { headers: apiHeaders(), body: body === undefined ? null : JSON.stringify(body) });
  let json = null;
  try { json = JSON.parse(r.text); } catch { /* 非 JSON */ }
  if (process.env.TRIPO_DEBUG) {
    console.error('[tripo]', method, p, '<-', body === undefined ? '' : JSON.stringify(body).slice(0, 400), '->', r.status, String(r.text).slice(0, 200));
  }
  if (r.status >= 400 || (json && typeof json.code === 'number' && json.code !== 0)) {
    const msg = json ? `${json.code}: ${json.message || ''} ${json.suggestion || ''}` : r.text.slice(0, 200);
    const err = new Error(`Tripo ${method} ${p} -> HTTP ${r.status} ${msg}`.trim());
    err.status = r.status;
    err.studioCode = json?.code;
    throw err;
  }
  return json;
}

/* ---------- SigV4（S3 上传用） ---------- */

function hmac(key, str) { return crypto.createHmac('sha256', key).update(str).digest(); }
function sha256hex(str) { return crypto.createHash('sha256').update(str).digest('hex'); }

function signS3Put({ host, key, payload, contentType, creds }) {
  // s3-accelerate 端点统一用 us-east-1 签名
  const region = /s3-accelerate/.test(host) ? 'us-east-1' : ((host.match(/s3[.-]([a-z0-9-]+)\.amazonaws\.com/) || [, 'us-west-2'])[1]);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256hex(payload);
  const canonicalUri = '/' + key.split('/').map(encodeURIComponent).join('/');
  const canonicalQuery = 'x-id=PutObject';
  const canonicalHeaders =
    `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\nx-amz-security-token:${creds.session_token}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token';
  const canonicalRequest = ['PUT', canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmac('AWS4' + creds.sts_sk, day);
  k = hmac(k, region); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.sts_ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
    'x-amz-security-token': creds.session_token, 'content-type': contentType, host,
  };
}

/* ---------- 业务 ---------- */

export const GENERATE_DEFAULTS = {
  face_limit: 2000000, quad: false, visibility: 'shareable', generate_parts: false, smart_poly: false,
  texture: true, delight: true, pbr: true, texture_alignment: 'original_image',
  texture_quality: 'detailed', geometry_quality: 'detailed', gen_image_model_version: 'flux.1_dev',
  sketch_to_render: false, t_pose: false,
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 面数预设：直接调 face_limit 太容易搞出百兆模型，给个台阶
export const FACE_PRESETS = { low: 30000, medium: 150000, high: 800000 };

// 官方 API 文档里的参数名，原样透传（见 platform.tripo3d.ai/docs/generation）
export const OFFICIAL_PARAMS = [
  'face_limit', 'texture', 'pbr', 'quad', 'texture_quality', 'geometry_quality',
  'auto_size', 'orientation', 'compress', 'smart_low_poly', 'generate_parts',
  'export_uv', 'model_seed', 'texture_seed', 'enable_image_autofix',
  'texture_alignment', 'visibility',
];

export function applyParams(body, args) {
  if (args.face_preset) {
    const n = FACE_PRESETS[args.face_preset];
    if (!n) throw new Error('face_preset 只能是 low / medium / high');
    body.face_limit = n;
  }
  for (const k of OFFICIAL_PARAMS) {
    if (args[k] !== undefined) body[k] = args[k];
  }
  return body;
}

// 后处理类接口（remesh/texture/...）返回的字段名不统一，统一取一个可轮询的 id
export function progressId(data) {
  const d = Array.isArray(data) ? data[0] : data;
  if (!d || typeof d !== 'object') return null;
  return d.operation_id || d.operator_id || d.task_id || d.project_id || d.id || null;
}

// 后处理接口的 part_names / part_name_list 就是当前模型里带网格的节点名：
// 生成的模型是 tripo_node_<根 operator>，导入的模型是原文件里的物体名，拆分后是 tripo_part_N
export async function meshPartNames(projectId) {
  try {
    const names = await modelMeshNodeNames(projectId);
    if (names && names.length) return names;
  } catch { /* 落到按历史推导 */ }
  try {
    const h = await api('GET', `/project/history/${projectId}?locale=zh-CN`);
    const list = h?.data?.history || [];
    // 根节点名取自最初那次生成；后续 remesh/texture 会开自己的目录，不能拿来拼
    const root = list.find((it) => /^(text|image|multiview)_to_model$/.test(String(it.type || ''))) || list[list.length - 1];
    if (root?.operator_id) return [`tripo_node_${root.operator_id}`];
    const m = String(root?.rendered_image || '').match(/\/tripo-studio\/\d+\/([0-9a-f-]{36})\//i);
    if (m) return [`tripo_node_${m[1]}`];
  } catch { /* 落到下面的兜底 */ }
  try {
    const det = await api('GET', `/project/detail/v3/${projectId}?locale=zh-CN`);
    const m = String(det?.data?.model_url || '').match(/\/tripo-studio\/\d+\/([0-9a-f-]{36})\//i);
    if (m) return [`tripo_node_${m[1]}`];
  } catch { /* 忽略 */ }
  return null;
}

// 读项目当前模型的带网格节点名。GLB 只拉 JSON 块；FBX（重拓扑或导入的模型）整个下载后用 assimp 读场景树
export async function modelMeshNodeNames(projectId) {
  const det = await api('GET', `/project/detail/v3/${projectId}?locale=zh-CN`);
  const url = det?.data?.model_url;
  if (!url) return null;
  const head = await request('GET', url, { headers: { range: 'bytes=0-19' }, binary: true });
  let j;
  if (head.buf.readUInt32LE(0) === 0x46546c67) {
    const len = head.buf.readUInt32LE(12);
    const r = await request('GET', url, { headers: { range: `bytes=20-${19 + len}` }, binary: true });
    j = JSON.parse(r.buf.subarray(0, len).toString('utf8'));
  } else if (head.buf.subarray(0, 11).toString('latin1') === 'Kaydara FBX') {
    const r = await request('GET', url, { binary: true });
    const files = await convertModel(r.buf, 'gltf2', 'scene', 'fbx');
    const g = files.find((f) => f.name.endsWith('.gltf'));
    if (!g) return null;
    j = JSON.parse(g.data.toString('utf8'));
  } else {
    return null;
  }
  return [...new Set((j.nodes || []).filter((n) => n.mesh !== undefined && n.name).map((n) => n.name))];
}

export async function waitImageAsset(assetId, deadline) {
  if (!assetId) throw new Error('生图任务没拿到 asset_id');
  while (Date.now() < deadline) {
    await sleep(4000);
    const a = (await api('POST', '/image/get_image_asset', { asset_id: assetId })).data || {};
    if (a.status === 'success') return a;
    if (['failed', 'banned', 'cancelled'].includes(a.status)) throw new Error(`生图 ${assetId} ${a.status}`);
  }
  throw new Error(`生图 ${assetId} 超时，可稍后在 Studio 图片面板查看`);
}

export async function waitTask(id, timeoutMs) {  const t0 = Date.now();
  let last = null;
  let fails = 0;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const j = await api('POST', '/progress', { ids: [id] });
      fails = 0;
      last = (j.data || [])[0] || {};
      if (last.status === 'success') return last;
      if (last.status === 'failed' || last.status === 'banned' || last.status === 'cancelled') {
        throw new Error(`任务 ${id} ${last.status}`);
      }
    } catch (e) {
      if (/^任务 /.test(e.message)) throw e;
      if (++fails >= 10) throw new Error(`轮询 ${id} 连续失败（任务可能仍在跑，稍后用 tripo_download）: ${e.message.slice(0, 120)}`);
      await sleep(5000);
      continue;
    }
    await sleep(4000);
  }
  return { ...last, timedOut: true, id };
}

export async function downloadModel(projectId, outPath, format = 'glb', animated = false, opts = {}) {
  const det = await api('GET', `/project/detail/v3/${projectId}?locale=zh-CN`);
  const url = det?.data?.model_url;
  if (!url) throw new Error('项目里没有 model_url');
  const r = await request('GET', url, { binary: true });
  if (r.status !== 200) throw new Error('下载失败 HTTP ' + r.status);
  if (animated) {
    // 动画不在主模型上，而在 operator.retarget[]（新的在前）；那个 GLB 只有骨骼和动画轨道
    const list = (det?.data?.operator?.retarget || []).filter((x) => x.status === 'success' && x.model_url);
    if (!list.length) throw new Error('项目还没有套过动画，先用 tripo_animate');
    const picks = opts.animation_name
      ? list.filter((x) => String(x.name).toLowerCase() === opts.animation_name.toLowerCase())
      : opts.all_animations ? list : [list[0]];
    if (!picks.length) throw new Error(`没有名为 ${opts.animation_name} 的动画，可选：${list.map((x) => x.name).join(' / ')}`);
    const anims = [];
    for (const p of picks) {
      const a = await request('GET', p.model_url, { binary: true });
      if (a.status !== 200) throw new Error('下载动画失败 HTTP ' + a.status);
      anims.push({ name: p.name, buf: a.buf });
    }
    let dest = path.resolve(outPath);
    if (path.extname(dest).toLowerCase() !== '.glb') dest = dest.replace(/\.[^.\\/]*$/, '') + '.glb';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = opts.animation_only ? anims[0].buf : mergeAnimationsIntoGlb(r.buf, anims);
    fs.writeFileSync(dest, out);
    return { path: dest, bytes: out.length, format: 'glb', animations: anims.map((a) => a.name), with_mesh: !opts.animation_only };
  }
  let dest = path.resolve(outPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 四边面重拓扑之后，项目当前模型是 FBX 而不是 GLB，按文件头判断
  const src = r.buf.subarray(0, 4).toString('latin1') === 'glTF' ? 'glb'
    : r.buf.subarray(0, 11).toString('latin1') === 'Kaydara FBX' ? 'fbx' : 'glb';
  if (format === src || (format === 'glb' && src === 'fbx')) {
    // 源文件就是目标格式；或源是 FBX 却要 GLB——直接给 FBX，避免二次转换丢四边面
    if (path.extname(dest).toLowerCase() !== `.${src}`) dest = dest.replace(/\.[^.\\/]*$/, '') + `.${src}`;
    fs.writeFileSync(dest, r.buf);
    return { path: dest, bytes: r.buf.length, format: src, ...(src !== format ? { note: '该项目当前模型是四边面 FBX，已按原格式保存' } : {}) };
  }
  const base = path.basename(dest, path.extname(dest));
  const files = await convertModel(r.buf, format, base, src);
  if (files.length === 1 && !files[0].archive) {
    const single = path.join(path.dirname(dest), `${base}.${format}`);
    fs.writeFileSync(single, files[0].data);
    return { path: single, bytes: files[0].data.length, format };
  }
  const dir = path.join(path.dirname(dest), base);
  const written = [];
  for (const f of files) {
    const p = path.join(dir, f.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.data);
    written.push({ path: p, bytes: f.data.length });
  }
  return { dir, files: written, format };
}

/* ---------- 格式转换：assimp wasm ---------- */

let assimpModule = null;

export async function convertModel(glbBuf, format, name, srcExt = 'glb', { unzip = true } = {}) {
  if (!['fbx', 'obj', 'stl', 'gltf2', '3mf'].includes(format)) throw new Error(`不支持的格式：${format}`);
  if (!assimpModule) {
    const js = path.join(ASSIMP_DIR, 'assimpjs.cjs');
    const wasm = path.join(ASSIMP_DIR, 'assimpjs.wasm');
    if (!fs.existsSync(js) || !fs.existsSync(wasm)) {
      throw new Error(`找不到 assimp 转换器（${ASSIMP_DIR}），可用 TRIPO_ASSIMP_DIR 指定目录`);
    }
    const factory = require(js);
    assimpModule = await (typeof factory === 'function' ? factory : factory.default || factory.assimpjs)({ locateFile: () => wasm });
  }
  const list = new assimpModule.FileList();
  list.AddFile(`model.${srcExt}`, new Uint8Array(glbBuf));
  const result = assimpModule.ConvertFileList(list, format, {}, name);
  if (!result.IsSuccess() || result.FileCount() === 0) {
    throw new Error(`转换 ${format} 失败：${result.GetErrorCode()}`);
  }
  const out = [];
  for (let i = 0; i < result.FileCount(); i++) {
    const f = result.GetFile(i);
    const data = Buffer.from(f.GetContent());
    const entry = f.GetPath?.() || f.GetName?.() || `result.${format}`;
    // fbx/obj 带贴图时转换器会打成 zip；3mf 本身就是 zip 容器，不能解开
    if (unzip && format !== '3mf' && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
      for (const z of readZip(data)) out.push({ name: z.name, data: z.data, archive: true });
    } else {
      out.push({ name: path.basename(entry), data, archive: false });
    }
  }
  result.delete?.();
  list.delete?.();
  return out;
}

/* ---------- 动画合并：把 retarget 产出的动画轨道并进绑定后的网格 GLB ---------- */

export function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB');
  let off = 12, json = null, bin = Buffer.alloc(0);
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  return { json, bin };
}

export function writeGlb(json, bin) {
  const pad = (b, c) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), c)]) : b);
  const j = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const b = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(b.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, j, bh, b]);
}

// 动画 GLB 与绑定 GLB 的骨骼同名，按名字把通道重新指到网格文件的节点上
export function mergeAnimationsIntoGlb(meshBuf, anims) {
  const base = parseGlb(meshBuf);
  const g = base.json;
  const nodeIndex = new Map((g.nodes || []).map((n, i) => [n.name, i]));
  const parts = [base.bin];
  let binLen = base.bin.length;
  g.bufferViews = g.bufferViews || [];
  g.accessors = g.accessors || [];
  g.animations = g.animations || [];
  for (const anim of anims) {
    const a = parseGlb(anim.buf);
    if ((a.json.buffers || []).length > 1) throw new Error('动画 GLB 结构不支持（多个 buffer）');
    const align = (4 - (binLen % 4)) % 4;
    if (align) { parts.push(Buffer.alloc(align)); binLen += align; }
    const shift = binLen;
    parts.push(a.bin); binLen += a.bin.length;
    const bvBase = g.bufferViews.length, accBase = g.accessors.length;
    for (const bv of a.json.bufferViews || []) g.bufferViews.push({ ...bv, buffer: 0, byteOffset: (bv.byteOffset || 0) + shift });
    for (const acc of a.json.accessors || []) g.accessors.push({ ...acc, ...(acc.bufferView !== undefined ? { bufferView: acc.bufferView + bvBase } : {}) });
    for (const an of a.json.animations || []) {
      const channels = [];
      for (const ch of an.channels) {
        const idx = nodeIndex.get(a.json.nodes[ch.target.node]?.name);
        if (idx !== undefined) channels.push({ ...ch, target: { ...ch.target, node: idx } });
      }
      if (!channels.length) throw new Error('动画骨骼与模型对不上，可能项目重新绑定过');
      g.animations.push({
        ...an,
        name: anim.name || an.name,
        channels,
        samplers: an.samplers.map((s) => ({ ...s, input: s.input + accBase, output: s.output + accBase })),
      });
    }
  }
  const bin = Buffer.concat(parts);
  g.buffers[0].byteLength = bin.length;
  return writeGlb(g, bin);
}

function readZip(buf) {
  let eocd = -1;
  const stop = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 结构损坏');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const entryName = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    out.push({ name: entryName, data: method === 0 ? raw : zlib.inflateRawSync(raw) });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

export function slug(s) {
  return (s || 'model').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'model';
}

export async function uploadImage(filePath) {
  const { bucket, key } = await uploadFile(filePath, 'png');
  const audit = await api('POST', '/audit/image', { image: { bucket, key } });
  const auditResult = audit?.data?.result;
  if (auditResult !== undefined && auditResult !== 'pass') throw new Error('图片审核未通过: ' + auditResult);
  return { bucket, key, audit: auditResult };
}

export async function uploadFile(filePath, defaultExt) {
  const ext = (path.extname(filePath).slice(1) || defaultExt).toLowerCase();
  const payload = fs.readFileSync(filePath);
  const tk = await api('POST', '/storage/temporary_token', { client: 'aws', format: ext });
  const creds = tk.data;
  const host = `${creds.resource_bucket}.${creds.host}`;
  const putHeaders = signS3Put({ host, key: creds.resource_uri, payload, contentType: 'application/octet-stream', creds });
  const put = await request('PUT', `https://${host}/${creds.resource_uri}?x-id=PutObject`, { headers: putHeaders, body: payload });
  if (put.status !== 200 && put.status !== 204) {
    throw new Error(`S3 上传失败 HTTP ${put.status} ${String(put.text).slice(0, 300)}`);
  }
  return { bucket: creds.resource_bucket, key: creds.resource_uri };
}

/* ---------- MCP 工具表 ---------- */

// Studio 前端的版本枚举：H3.1 / H3.0 / H2.5，以及“智能网格”P1.0 / P2.0（内部叫 Nexus）
export const MODEL_VERSIONS = [
  'v3.1-20260211', 'v3.0-20250812', 'v2.5-20250123', 'Nexus-v1.0-20260214', 'Nexus-v2.0-20260801',
];

// 动画预设（取自前端 bundle），biped 有 97 个，其余骨骼类型各 1 个
export const RIG_TYPES = ['biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic', 'others'];
export const PRESET_MOTIONS = {
  biped: 'afraid agree angry_01 angry_02 angry_03 basketball_shot bow box_01 box_02 box_03 cast_a_spell cheer chop clap climb complain_01 complain_02 crossover_dribble cry dance_01 dance_02 dance_03 dance_04 dance_05 dance_06 defeat_02 defeat_03 depressed dig dive dribble fall fire flee_01 flee_02 flip fold_arms football_catch football_save football_pass freaky frightened front_kick_01 front_kick_02 frustrated_01 frustrated_02 greet_01 greet_02 greet_03 greet_04 heart_pose hit_to_body_01 hit_to_body_02 hit_to_head hit_to_side hit_to_stomach hug idle jump_down jump jump_rope_01 jump_rope_02 laugh_01 laugh_02 lift_heavy look_around make_a_call_01 make_a_call_02 pitch_baseball play_mobile_game play_video_game press-up run_upstairs run scared_01 scared_02 scratch shoot shovel sing_01 sing_02 sing_03 sing_04 sit slash sob standing_relax surf swagger swim turn volleyball wait walk warm_up wave_goodbye_01 wave_goodbye_02'.split(' '),
  quadruped: ['walk'], hexapod: ['walk'], octopod: ['walk'], serpentine: ['march'], aquatic: ['march'],
};

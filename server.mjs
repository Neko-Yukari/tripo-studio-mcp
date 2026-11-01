#!/usr/bin/env node
// tripo-studio MCP — 用 Tripo Studio 订阅额度生成 3D 模型（非官方内部接口，见 README 免责声明）
// 鉴权：从 Studio 网页登录后导出的 Cookie（ory_kratos_session）
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

const HOME = path.join(os.homedir(), '.tripo');
const STATE = process.env.TRIPO_STUDIO_STATE || path.join(HOME, 'studio-state.json');
const CONFIG = process.env.TRIPO_STUDIO_CONFIG || path.join(HOME, 'config.json');
const BASE = 'https://api.tripo3d.ai/v2/studio';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSIMP_DIR = process.env.TRIPO_ASSIMP_DIR || path.join(HERE, 'vendor', 'assimp');
const require = createRequire(import.meta.url);
const UA = process.env.TRIPO_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

// 代理优先级：TRIPO_NO_PROXY > TRIPO_PROXY > HTTPS_PROXY > 配置文件里的 proxy
const CONF = readConfig();
const PROXY = process.env.TRIPO_NO_PROXY
  ? ''
  : (process.env.TRIPO_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || CONF.proxy || '');

const DEFAULT_MODEL = CONF.model_version || 'v3.1-20260211';

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

async function request(method, urlStr, { headers = {}, body = null, binary = false, direct = undefined } = {}) {
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

function cookieHeader() {
  if (!fs.existsSync(STATE)) {
    throw new Error(`找不到登录态文件 ${STATE}：先运行 npm run login 登录 Tripo Studio（或用 TRIPO_STUDIO_STATE 指定路径）`);
  }
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  return st.cookies.filter((c) => /tripo3d/.test(c.domain)).map((c) => `${c.name}=${c.value}`).join('; ');
}

function apiHeaders(extra = {}) {
  return {
    cookie: cookieHeader(),
    'user-agent': UA,
    origin: 'https://studio.tripo3d.ai',
    referer: 'https://studio.tripo3d.ai/',
    'content-type': 'application/json',
    ...extra,
  };
}

async function api(method, p, body) {
  const r = await request(method, BASE + p, { headers: apiHeaders(), body: body === undefined ? null : JSON.stringify(body) });
  let json = null;
  try { json = JSON.parse(r.text); } catch { /* 非 JSON */ }
  if (process.env.TRIPO_DEBUG) {
    console.error('[tripo]', method, p, '<-', body === undefined ? '' : JSON.stringify(body).slice(0, 400), '->', r.status, String(r.text).slice(0, 200));
  }
  if (r.status >= 400 || (json && typeof json.code === 'number' && json.code !== 0)) {
    const msg = json ? `${json.code}: ${json.message || ''} ${json.suggestion || ''}` : r.text.slice(0, 200);
    throw new Error(`Tripo ${method} ${p} -> HTTP ${r.status} ${msg}`.trim());
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

const GENERATE_DEFAULTS = {
  face_limit: 2000000, quad: false, visibility: 'shareable', generate_parts: false, smart_poly: false,
  texture: true, delight: true, pbr: true, texture_alignment: 'original_image',
  texture_quality: 'detailed', geometry_quality: 'detailed', gen_image_model_version: 'flux.1_dev',
  sketch_to_render: false, t_pose: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 面数预设：直接调 face_limit 太容易搞出百兆模型，给个台阶
const FACE_PRESETS = { low: 30000, medium: 150000, high: 800000 };

// 官方 API 文档里的参数名，原样透传（见 platform.tripo3d.ai/docs/generation）
const OFFICIAL_PARAMS = [
  'face_limit', 'texture', 'pbr', 'quad', 'texture_quality', 'geometry_quality',
  'auto_size', 'orientation', 'compress', 'smart_low_poly', 'generate_parts',
  'export_uv', 'model_seed', 'texture_seed', 'enable_image_autofix',
  'texture_alignment', 'visibility',
];

function applyParams(body, args) {
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
function progressId(data) {
  const d = Array.isArray(data) ? data[0] : data;
  if (!d || typeof d !== 'object') return null;
  return d.operation_id || d.operator_id || d.task_id || d.project_id || d.id || null;
}

// 后处理接口的 part_names / part_name_list 就是当前模型里带网格的节点名：
// 生成的模型是 tripo_node_<根 operator>，导入的模型是原文件里的物体名，拆分后是 tripo_part_N
async function meshPartNames(projectId) {
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
async function modelMeshNodeNames(projectId) {
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

async function waitImageAsset(assetId, deadline) {
  if (!assetId) throw new Error('生图任务没拿到 asset_id');
  while (Date.now() < deadline) {
    await sleep(4000);
    const a = (await api('POST', '/image/get_image_asset', { asset_id: assetId })).data || {};
    if (a.status === 'success') return a;
    if (['failed', 'banned', 'cancelled'].includes(a.status)) throw new Error(`生图 ${assetId} ${a.status}`);
  }
  throw new Error(`生图 ${assetId} 超时，可稍后在 Studio 图片面板查看`);
}

async function waitTask(id, timeoutMs) {  const t0 = Date.now();
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

async function downloadModel(projectId, outPath, format = 'glb', animated = false, opts = {}) {
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

async function convertModel(glbBuf, format, name, srcExt = 'glb') {
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
    if (format !== '3mf' && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
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

function parseGlb(buf) {
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

function writeGlb(json, bin) {
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
function mergeAnimationsIntoGlb(meshBuf, anims) {
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

function slug(s) {
  return (s || 'model').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'model';
}

async function uploadImage(filePath) {
  const { bucket, key } = await uploadFile(filePath, 'png');
  const audit = await api('POST', '/audit/image', { image: { bucket, key } });
  const auditResult = audit?.data?.result;
  if (auditResult !== undefined && auditResult !== 'pass') throw new Error('图片审核未通过: ' + auditResult);
  return { bucket, key, audit: auditResult };
}

async function uploadFile(filePath, defaultExt) {
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
const MODEL_VERSIONS = [
  'v3.1-20260211', 'v3.0-20250812', 'v2.5-20250123', 'Nexus-v1.0-20260214', 'Nexus-v2.0-20260801',
];

// 动画预设（取自前端 bundle），biped 有 97 个，其余骨骼类型各 1 个
const RIG_TYPES = ['biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic', 'others'];
const PRESET_MOTIONS = {
  biped: 'afraid agree angry_01 angry_02 angry_03 basketball_shot bow box_01 box_02 box_03 cast_a_spell cheer chop clap climb complain_01 complain_02 crossover_dribble cry dance_01 dance_02 dance_03 dance_04 dance_05 dance_06 defeat_02 defeat_03 depressed dig dive dribble fall fire flee_01 flee_02 flip fold_arms football_catch football_save football_pass freaky frightened front_kick_01 front_kick_02 frustrated_01 frustrated_02 greet_01 greet_02 greet_03 greet_04 heart_pose hit_to_body_01 hit_to_body_02 hit_to_head hit_to_side hit_to_stomach hug idle jump_down jump jump_rope_01 jump_rope_02 laugh_01 laugh_02 lift_heavy look_around make_a_call_01 make_a_call_02 pitch_baseball play_mobile_game play_video_game press-up run_upstairs run scared_01 scared_02 scratch shoot shovel sing_01 sing_02 sing_03 sing_04 sit slash sob standing_relax surf swagger swim turn volleyball wait walk warm_up wave_goodbye_01 wave_goodbye_02'.split(' '),
  quadruped: ['walk'], hexapod: ['walk'], octopod: ['walk'], serpentine: ['march'], aquatic: ['march'],
};

// 参数名与取值对齐官方文档 platform.tripo3d.ai/docs/generation
const GEN_PARAMS = {
  model_version: { type: 'string', enum: MODEL_VERSIONS, description: '模型版本，默认 v3.1-20260211（H3.1）。v3.0 = H3.0 快速，v2.5 = H2.5 经典；Nexus-v1.0 / Nexus-v2.0 = 智能网格 P1.0 / P2.0（对应官方 API 的 P1，输出干净拓扑低模）' },
  face_limit: { type: 'integer', description: '面数上限，不填自适应。v3.1/v3.0 detailed 最多 2,000,000、standard 1,500,000；v2.5 最多 500,000；quad=true 时不超过 150,000' },
  face_preset: { type: 'string', enum: ['low', 'medium', 'high'], description: '面数预设：low 3万 / medium 15万 / high 80万，优先于 face_limit；游戏资产和 3D 打印建议 low 或 medium' },
  texture: { type: 'boolean', description: '是否生成贴图，默认 true' },
  pbr: { type: 'boolean', description: 'PBR 材质，默认 true；为 true 时 texture 被强制为 true' },
  texture_quality: { type: 'string', enum: ['standard', 'detailed', 'extreme'], description: '贴图质量，默认 detailed；standard 为基准，detailed +20、extreme +30 积分' },
  geometry_quality: { type: 'string', enum: ['standard', 'detailed'], description: '几何精度，默认 detailed（Ultra）' },
  texture_alignment: { type: 'string', enum: ['original_image', 'geometry'], description: '贴图对齐倾向：忠于原图 / 忠于几何，默认 original_image' },
  quad: { type: 'boolean', description: '四边面输出，默认 false；开启后输出为 FBX 且面数不超过 150,000' },
  auto_size: { type: 'boolean', description: '按真实世界尺寸（米）缩放，默认 false' },
  orientation: { type: 'string', enum: ['default', 'align_image'], description: '自动旋转对齐原图，默认 default；仅 texture=true 时生效' },
  compress: { type: 'string', enum: ['geometry', 'meshopt'], description: '纹理压缩方式，默认 meshopt；geometry 需要在建模软件里先解压' },
  smart_low_poly: { type: 'boolean', description: '手搓拓扑低模，默认 false；输入复杂时可能失败' },
  generate_parts: { type: 'boolean', description: '分部件生成，默认 false；与 texture/pbr/quad 不兼容' },
  export_uv: { type: 'boolean', description: '生成阶段是否做 UV 展开，默认 true；设 false 更快、模型更小' },
  model_seed: { type: 'integer', description: '几何随机种子，固定可复现（v2.0 及以上）' },
  texture_seed: { type: 'integer', description: '贴图随机种子（v2.0 及以上）' },
  visibility: { type: 'string', enum: ['private', 'public', 'shareable'], description: '模型可见性，默认 shareable' },
  wait_seconds: { type: 'integer', description: '阻塞等待上限，默认 480 秒；超时会返回 id，稍后用 tripo_download 取模型' },
};

const TOOLS = [
  {
    name: 'tripo_status',
    description: '查看 Tripo Studio 账号状态：剩余积分、套餐、到期时间、特殊额度；可查某个操作的进度和最近的积分流水。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'operator_id / task_id，可选' },
        ledger: { type: 'integer', description: '同时返回最近 N 条积分流水（扣费/退款），默认 0' },
      },
    },
  },
  {
    name: 'tripo_generate_text',
    description: '文字生成 3D 模型（Studio 订阅额度，H3.1 基准约 55 积分/次）。对应内部接口 operation/text_to_model，参数名与官方文档 text_to_model 一致。默认阻塞等待完成并下载 GLB。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '提示词，英文效果更好' },
        out_path: { type: 'string', description: '保存路径，默认 tripo-out/<prompt>.glb' },
        ...GEN_PARAMS,
      },
      required: ['prompt'],
    },
  },
  {
    name: 'tripo_generate_image',
    description: '参考图生成 3D 模型。对应内部接口 operation/batch_image_to_model（单图即长度为 1 的数组），参数名与官方文档 image_to_model 一致。本地图片会先上传到 Tripo 并送审，默认阻塞等待并下载 GLB。',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '本地图片路径（png/jpg/webp），建议分辨率 ≥256×256' },
        out_path: { type: 'string', description: '保存路径，默认 tripo-out/<文件名>.glb' },
        enable_image_autofix: { type: 'boolean', description: '生成前先优化输入图，默认 false' },
        ...GEN_PARAMS,
      },
      required: ['image_path'],
    },
  },
  {
    name: 'tripo_generate_multiview',
    description: '多视图生成 3D 模型：给 2~4 张同一物体的不同视角图，对应内部接口 operation/multiview_to_model。数组顺序即视角顺序，默认按 front、left、right、back 理解；每张图都会先上传并送审。默认阻塞等待并下载 GLB。',
    inputSchema: {
      type: 'object',
      properties: {
        image_paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 4,
          description: '2~4 张本地图片，按 front、left、right、back 的顺序排列',
        },
        out_path: { type: 'string', description: '保存路径，默认 tripo-out/<第一张文件名>-mv.glb' },
        ...GEN_PARAMS,
      },
      required: ['image_paths'],
    },
  },
  {
    name: 'tripo_remesh',
    description: '重拓扑/减面：把已有项目重新布线到指定面数，对应内部接口 operation/remesh。会覆盖项目当前模型（生成新版本），完成后用 tripo_download 取。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        face_limit: { type: 'integer', description: '目标面数，界面范围 500–10000，默认 10000' },
        quad: { type: 'boolean', description: '四边形拓扑，默认 true；false 为三角面' },
        smart_poly: { type: 'boolean', description: '智能网格，默认 true' },
        bake: { type: 'boolean', description: '烘焙原贴图到新网格，默认 true' },
        part_name_list: { type: 'array', items: { type: 'string' }, description: '只处理指定部件；默认按当前模型的节点名自动填' },
        wait_seconds: { type: 'integer', description: '阻塞等待上限，默认 480 秒' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'tripo_texture',
    description: '重新生成贴图，对应内部接口 operation/texture_model。可以给一张参考图，也可以不给（纯靠几何推纹理）。会覆盖项目当前模型，完成后用 tripo_download 取。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        image_path: { type: 'string', description: '参考图（可选），不给就按几何生成' },
        texture_quality: { type: 'string', enum: ['standard', 'detailed', 'extreme'], description: '默认 detailed' },
        texture_alignment: { type: 'string', enum: ['original_image', 'geometry'], description: '默认 original_image' },
        delight: { type: 'boolean', description: '去光处理，默认 false' },
        part_names: { type: 'array', items: { type: 'string' }, description: '默认按项目根节点自动填' },
        wait_seconds: { type: 'integer', description: '默认 480 秒' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'tripo_uv',
    description: '智能 UV 展开：uv_edit/context → generate（首次，消耗 uv_edit 额度）或 retry（同一上下文内前 3 次免费）→ apply。已有候选且 next_action=apply 时直接应用，不再消耗额度。模型需 ≤8 万三角面或 ≤4 万四边面，超了先 tripo_remesh。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        apply: { type: 'boolean', description: '生成后是否立刻应用到项目，默认 true' },
        candidate_id: { type: 'string', description: '已有候选时指定要应用哪个；不填则应用最新的' },
        wait_seconds: { type: 'integer', description: '默认 480 秒' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'tripo_rig',
    description: '自动骨骼绑定：先跑 operation/pre_rig_check（免费，对应官方 animate_prerigcheck），再调 operation/rigging_model。人形可选骨骼规范（Mixamo / UE5 / Unity / ActorCore / VRM）；非人形按预检给出的 rig_type 绑。模型面数需 ≤10 万，否则先 tripo_remesh。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        check_only: { type: 'boolean', description: '只做预检（是否可绑、推荐 rig_type），不扣积分；默认 false' },
        rig_type: { type: 'string', enum: RIG_TYPES, description: '骨骼类型，默认取预检结果' },
        spec: { type: 'string', enum: ['mixamo', 'unreal', 'unity', 'actorcore', 'vrm'], description: '人形（biped）骨骼规范，默认 mixamo；unreal = UE5 Mannequin' },
        force: { type: 'boolean', description: '预检说不可绑时仍然尝试（界面上的“仍然尝试”），默认 false' },
        model_version: { type: 'string', description: '绑定模型版本，默认 v3.0-20260909（界面所用）' },
        wait_seconds: { type: 'integer', description: '默认 480 秒' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'tripo_upscale',
    description: '纹理放大到 4K / 8K，对应内部接口 operation/texture_upscaler。项目必须已有贴图。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        texture_quality: { type: 'string', enum: ['detailed', 'extreme'], description: 'detailed = 4K，extreme = 8K（默认；消耗 8K 试用次数或更高套餐）。目标必须高于当前贴图：H3.1 默认生成已是 4K，再要 detailed 会报 500' },
        model_version: { type: 'string', description: '默认 v3.0-20250812（界面所用）' },
        wait_seconds: { type: 'integer', description: '默认 480 秒' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'tripo_segment',
    description: '部件拆分，对应内部接口 operation/ai_segmentation。只支持未经重拓扑的原始网格；重拓扑过的项目会没反应。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        granularity: { type: 'string', enum: ['simple', 'balanced', 'detailed'], description: '拆分精度：simple 粗略 3–6 个部件 / balanced 标准 6–15 个（默认）/ detailed 精细 15+ 个' },
        model_version: { type: 'string', description: '默认 v2.0-20260430' },
        wait_seconds: { type: 'integer', description: '默认 480 秒' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'tripo_complete',
    description: '部件补全：给 tripo_segment 拆出的部件补齐被遮挡的几何。mode=ai 调 operation/ai_completion（AI 补全），mode=quick_cap 调 operation/mesh_fill（快速封口）。项目必须先拆分。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        mode: { type: 'string', enum: ['ai', 'quick_cap'], description: '默认 ai' },
        part_names: { type: 'array', items: { type: 'string' }, description: '要处理的部件节点名；不填则取模型里全部部件' },
        model_version: { type: 'string', description: 'ai 模式默认 v1.0-20250506，quick_cap 默认 default' },
        wait_seconds: { type: 'integer', description: '默认 480 秒' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'tripo_pbr',
    description: '给已有贴图的项目生成 PBR 材质（金属度/粗糙度/法线），对应内部接口 operation/pbr_generate。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        model_version: { type: 'string', description: '默认 v3.0-20250812（界面所用）' },
        wait_seconds: { type: 'integer', description: '默认 480 秒' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'tripo_animate',
    description: '给已绑定的模型套动画（operation/retarget_model）。三选一：preset 用内置动作（不生成新动作）；motion_asset_id 复用已生成的动作；prompt 先用 motion/generate 文字生成动作（仅人形）。可选值用 tripo_list_motions 查。模型必须先 tripo_rig；取结果用 tripo_download 加 animated:true。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        preset: { type: 'string', description: '内置动作名，如 walk / run / idle / dance_01；也可写全名 preset:biped:walk' },
        motion_asset_id: { type: 'string', description: '复用已生成的动作资产' },
        prompt: { type: 'string', description: '文字生成动作，例如 walk forward slowly' },
        duration_seconds: { type: 'integer', description: '文字生成时的时长（秒），默认 5' },
        rig_type: { type: 'string', enum: RIG_TYPES, description: '骨骼类型，默认取项目绑定时的类型' },
        wait_seconds: { type: 'integer', description: '默认 480 秒' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'tripo_image',
    description: '生成 2D 图片（对应官方 text_to_image / generate_image / image_to_multiview）：文字生图、带参考图改图、套模板，或把一张图扩成前/左/后/右四视图。内部接口 image/gen_image_v2 + image/gen_multiview，结果下载为 PNG，可直接给 tripo_generate_image / tripo_generate_multiview 用。套餐内每月有免费生图次数。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '描述；只做四视图且给了 image_paths 时可不填' },
        image_paths: { type: 'array', items: { type: 'string' }, description: '参考图（可选，可多张），用于改图/风格参考' },
        multiview: { type: 'boolean', description: '输出四视图。有 prompt 时先生成一张再扩四视图；只有一张 image_paths 时直接拿它扩' },
        model: {
          type: 'string',
          enum: ['gemini_3.1_flash_image_preview', 'gemini_3_pro_image_preview', 'gemini_2.5_flash_image_preview', 'gpt_image_2.5_sunburst', 'gpt_image_2', 'gpt_image_1.5', 'gpt_4o', 'flux.1_kontext_pro', 'flux.1_dev', 'midjourney'],
          description: '默认 gemini_3.1_flash_image_preview（Nano Banana 2）；gemini_3_pro = Nano Banana Pro，gpt_image_2.5_sunburst = GPT Image 2.5',
        },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], description: '默认 1:1' },
        resolution: { type: 'string', enum: ['1K', '2K', '4K'], description: '默认 1K' },
        amount: { type: 'integer', description: '生成张数 1–4，默认 1（multiview 时固定 1）' },
        template_id: { type: 'string', description: '模板 id（如角色拆分、T 姿势），用 list_templates:true 查' },
        list_templates: { type: 'boolean', description: '只列出可用模板，不生成' },
        t_pose: { type: 'boolean', description: '要求角色摆 T 姿势（便于后续绑定），默认 false' },
        out_dir: { type: 'string', description: '默认 tripo-out/images/<asset_id>' },
        wait_seconds: { type: 'integer', description: '默认 300 秒' },
      },
    },
  },
  {
    name: 'tripo_import',
    description: '把本地模型（GLB / FBX / OBJ / STL，≤150MB）导入 Studio 变成一个项目（对应官方 import_model），之后可以对它用 tripo_texture / tripo_remesh / tripo_rig / tripo_animate 等。内部接口 operation/import_user_model。',
    inputSchema: {
      type: 'object',
      properties: {
        model_path: { type: 'string', description: '本地模型文件' },
        name: { type: 'string', description: '项目名，默认文件名' },
        use_original_uv: { type: 'boolean', description: '保留原有 UV，默认 true' },
        transform_matrix: { type: 'array', items: { type: 'number' }, description: '4×4 变换矩阵（16 个数，列主序），默认单位矩阵；用来把模型转到正面朝前' },
        wait_seconds: { type: 'integer', description: '默认 480 秒' },
      },
      required: ['model_path'],
    },
  },
  {
    name: 'tripo_list_projects',
    description: '列出账号里的模型项目（按时间倒序），拿 project_id 给其他工具用。对应内部接口 assets/v2。',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', description: '默认 0' },
        size: { type: 'integer', description: '每页条数，默认 20，最多 50' },
      },
    },
  },
  {
    name: 'tripo_list_motions',
    description: '列出可用的动作：自己文字生成过的动作资产（可用 motion_asset_id 复用），以及按骨骼类型分组的内置预设动作名。',
    inputSchema: {
      type: 'object',
      properties: { rig_type: { type: 'string', enum: RIG_TYPES, description: '只看某种骨骼的预设，默认全部' } },
    },
  },
  {
    name: 'tripo_download',
    description: '把一个已有项目（project_id）的模型下载到本地。format 可选 glb / fbx / obj / stl，后三种在本地用 assimp 转换；FBX 和 OBJ 会连同贴图解到同名目录。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        format: { type: 'string', enum: ['glb', 'fbx', 'obj', 'stl', '3mf'], description: '默认 glb；3mf 只含几何，用于 3D 打印' },
        out_path: { type: 'string', description: '默认 tripo-out/<project_id>.glb；转换格式的扩展名会自动替换' },
        animated: { type: 'boolean', description: '下载带动画的 GLB：绑定后的网格 + 骨骼 + 动画在同一个文件（本地合并），默认取最近一次套的动画；默认 false' },
        animation_name: { type: 'string', description: '指定动画名（如 preset:biped:run、Wave Right Hand）' },
        all_animations: { type: 'boolean', description: '把项目套过的所有动画都并进一个 GLB（多个 Action）' },
        animation_only: { type: 'boolean', description: '只要 Studio 原始动画 GLB（无网格）' },
      },
      required: ['project_id'],
    },
  },
];

async function callTool(name, args) {
  if (name === 'tripo_status') {
    const out = {};
    try {
      const w = await api('GET', '/studio/whoami');
      out.session = { active: w.active, authenticated_at: w.authenticated_at };
    } catch (e) { out.session = { error: String(e.message).slice(0, 160) }; }
    try {
      const p = await api('GET', '/user/profile/payment');
      out.member = p.data?.member;
      out.credits = p.data?.wallet;
      out.subscription = {
        type: p.data?.subscription?.type, period: p.data?.subscription?.period,
        valid_until: p.data?.subscription?.valid_until, auto_renew: p.data?.subscription?.auto_renew,
      };
    } catch (e) { out.member = { error: String(e.message).slice(0, 160) }; }
    try {
      const q = await api('POST', '/operation/quota', {});
      out.quota = q.data?.quota || q.data || null;
    } catch (e) { out.quota = { error: String(e.message).slice(0, 160) }; }
    if (args.task_id) {
      const j = await api('POST', '/progress', { ids: [args.task_id] });
      out.task = (j.data || [])[0];
    }
    if (args.ledger) {
      const l = await api('GET', `/txn/records?page_num=1&page_size=${Math.min(args.ledger, 50)}`);
      out.ledger = (l.data?.records || []).map((r) => ({
        time: r.create_time, type: r.sub_type, txn: r.txn_type, amount: r.direction === 'sub' ? -r.amount : r.amount,
        status: r.status, operator_id: r.operator_id,
      }));
    }
    return out;
  }

  if (name === 'tripo_generate_text') {
    const body = applyParams({
      ...GENERATE_DEFAULTS,
      model_version: args.model_version || DEFAULT_MODEL,
      prompt: args.prompt,
    }, args);
    const j = await api('POST', '/operation/text_to_model', body);
    const { task_id, project_id } = j.data;
    const st = await waitTask(task_id, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { task_id, project_id, status: st.status, progress: st.progress, note: '仍在上色/生成，稍后用 tripo_download' };
    const file = await downloadModel(project_id, args.out_path || `tripo-out/${slug(args.prompt)}.glb`);
    return { task_id, project_id, status: st.status, file: file.path, bytes: file.bytes };
  }

  if (name === 'tripo_generate_image') {
    if (!fs.existsSync(args.image_path)) throw new Error('找不到图片: ' + args.image_path);
    const img = await uploadImage(args.image_path);
    const body = applyParams({
      ...GENERATE_DEFAULTS,
      model_version: args.model_version || DEFAULT_MODEL,
      image: [{
        bucket: img.bucket,
        key: img.key,
        image_audit_result: img.audit,
        image_source: 'upload',
        texture_quality: args.texture_quality || GENERATE_DEFAULTS.texture_quality,
      }],
    }, args);
    const j = await api('POST', '/operation/batch_image_to_model', body);
    const { project_id } = j.data[0];
    const opId = j.data[0].operator_id || j.data[0].operation_id;
    const st = await waitTask(opId, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { operator_id: opId, project_id, status: st.status, progress: st.progress, note: '仍未完成，稍后用 tripo_download' };
    const file = await downloadModel(project_id, args.out_path || `tripo-out/${slug(path.basename(args.image_path, path.extname(args.image_path)))}.glb`);
    return { operator_id: opId, project_id, status: st.status, file: file.path, bytes: file.bytes };
  }

  if (name === 'tripo_generate_multiview') {
    const paths = args.image_paths || [];
    if (paths.length < 2 || paths.length > 4) throw new Error('image_paths 需要 2~4 张图片');
    const images = [];
    for (const p of paths) {
      if (!fs.existsSync(p)) throw new Error('找不到图片: ' + p);
      const img = await uploadImage(p);
      images.push({
        bucket: img.bucket,
        key: img.key,
        image_audit_result: img.audit,
        image_source: 'upload',
        texture_quality: args.texture_quality || GENERATE_DEFAULTS.texture_quality,
      });
    }
    const body = applyParams({
      ...GENERATE_DEFAULTS,
      model_version: args.model_version || DEFAULT_MODEL,
      image: images,
    }, args);
    const j = await api('POST', '/operation/multiview_to_model', body);
    const { task_id, project_id } = j.data;
    const st = await waitTask(task_id, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { task_id, project_id, status: st.status, progress: st.progress, note: '仍在上色/生成，稍后用 tripo_download' };
    const base = slug(path.basename(paths[0], path.extname(paths[0])));
    const file = await downloadModel(project_id, args.out_path || `tripo-out/${base}-mv.glb`);
    return { task_id, project_id, status: st.status, file: file.path, bytes: file.bytes };
  }

  if (name === 'tripo_remesh') {
    const parts = args.part_name_list || await meshPartNames(args.project_id);
    const body = {
      project_id: args.project_id,
      face_limit: args.face_limit ?? 10000,
      quad: args.quad ?? true,
      smart_poly: args.smart_poly ?? true,
      bake: args.bake ?? true,
      model_version: 'default',
    };
    if (parts && parts.length) body.part_name_list = parts;
    const j = await api('POST', '/operation/remesh', body);
    const id = progressId(j.data);
    const st = await waitTask(id, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { operator_id: id, project_id: args.project_id, status: st.status, note: '重拓扑仍在进行，稍后用 tripo_download' };
    return { operator_id: id, project_id: args.project_id, status: st.status, note: '项目模型已更新，用 tripo_download 取结果' };
  }

  if (name === 'tripo_texture') {
    const parts = args.part_names || await meshPartNames(args.project_id);
    const body = {
      project_id: args.project_id,
      texture_quality: args.texture_quality || 'detailed',
      texture_alignment: args.texture_alignment || 'original_image',
      delight: args.delight ?? false,
    };
    if (parts && parts.length) body.part_names = parts;
    if (args.image_path) {
      if (!fs.existsSync(args.image_path)) throw new Error('找不到图片: ' + args.image_path);
      const img = await uploadImage(args.image_path);
      body.image = { bucket: img.bucket, key: img.key, image_audit_result: img.audit, image_source: 'upload' };
    }
    const j = await api('POST', '/operation/texture_model', body);
    const id = progressId(j.data);
    const st = await waitTask(id, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { operator_id: id, project_id: args.project_id, status: st.status, note: '贴图仍在生成，稍后用 tripo_download' };
    return { operator_id: id, project_id: args.project_id, status: st.status, note: '项目模型已更新，用 tripo_download 取结果' };
  }

  if (name === 'tripo_uv') {
    const det = await api('GET', `/project/detail/v3/${args.project_id}?locale=zh-CN`);
    const cur = det?.data?.operator?.operator_id;
    if (!cur) throw new Error('取不到项目当前 operator');
    // 上下文返回 next_action：generate（首次）/ retry（重试，前 3 次免费）/ apply（已有候选）
    const ctxRes = await api('POST', '/operation/uv_edit/context', { current_operator_id: cur, project_id: args.project_id });
    const ctx = ctxRes?.data || {};
    const action = ctx.next_action || 'generate';
    const target = ctx.current_operator_id || cur;
    const free = ctx.candidates?.length ? Math.max(4 - ctx.candidates.length, 0) : 4;

    if (action === 'apply') {
      const cands = (ctx.candidates || []).slice().sort((a, b) => b.created_at - a.created_at);
      const pick = args.candidate_id ? cands.find((c) => c.operator_id === args.candidate_id) : cands[0];
      if (!pick) throw new Error(`指定的候选 ${args.candidate_id} 不存在`);
      await api('POST', '/operation/uv_edit/apply', { project_id: args.project_id, current_operator_id: target, candidate_operator_id: pick.operator_id });
      return { operator_id: pick.operator_id, project_id: args.project_id, status: 'success', note: '已应用已有候选，用 tripo_download 取结果' };
    }

    const j = await api('POST', '/operation/uv_edit/generate', { action, current_operator_id: target, project_id: args.project_id });
    const id = j.data?.operator_id || progressId(j.data);
    const st = await waitTask(id, (args.wait_seconds || 480) * 1000);
    // retry 前 3 次免费，之后才扣积分；generate 首次消耗 uv_edit 额度
    const charged = action === 'generate' || free === 0;
    if (st.timedOut) return { operator_id: id, project_id: args.project_id, status: st.status, action, charged, note: 'UV 仍在展开；完成后只是候选，稍后重调 tripo_uv 会直接应用最新候选' };
    if (args.apply === false) return { operator_id: id, project_id: args.project_id, status: st.status, action, charged, note: '候选已生成但未应用；之后调 tripo_uv 会应用最新候选' };
    // generate/retry 只产出候选，必须 apply 才会替换项目当前模型
    await api('POST', '/operation/uv_edit/apply', { project_id: args.project_id, current_operator_id: target, candidate_operator_id: id });
    return { operator_id: id, project_id: args.project_id, status: st.status, action, charged, note: 'UV 已应用到项目，用 tripo_download 取结果' };
  }

  if (name === 'tripo_rig') {
    const modelVersion = args.model_version || 'v3.0-20260909';
    const chk = (await api('POST', '/operation/pre_rig_check', { project_id: args.project_id, model_version: modelVersion })).data || {};
    const check = { riggable: chk.riggable, rig_type: chk.rig_type, check_success: chk.check_success };
    if (args.check_only) return check;
    if (chk.riggable === false && !args.force && (args.rig_type || 'biped') === 'biped') {
      return { ...check, status: 'not_rigged', note: '预检认为不适合人形绑定；可按 rig_type 换类型，或加 force:true 仍然尝试（会扣积分）' };
    }
    const rigType = args.rig_type || chk.rig_type || 'biped';
    const body = { project_id: args.project_id, model_version: modelVersion, rig_type: rigType };
    if (rigType === 'biped') body.spec = args.spec || 'mixamo';
    const j = await api('POST', '/operation/rigging_model', body);
    const id = progressId(j.data);
    const st = await waitTask(id, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { operator_id: id, project_id: args.project_id, status: st.status, note: '绑定仍在进行，稍后用 tripo_download' };
    return { operator_id: id, project_id: args.project_id, status: st.status, note: '项目模型已更新，用 tripo_download 取结果' };
  }

  if (name === 'tripo_upscale') {
    const body = {
      project_id: args.project_id,
      model_version: args.model_version || 'v3.0-20250812',
      texture_quality: args.texture_quality || 'extreme',
    };
    const j = await api('POST', '/operation/texture_upscaler', body);
    const id = progressId(j.data);
    const st = await waitTask(id, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { operator_id: id, project_id: args.project_id, status: st.status, note: '纹理放大仍在进行，稍后用 tripo_download' };
    return { operator_id: id, project_id: args.project_id, status: st.status, note: '项目模型已更新，用 tripo_download 取结果' };
  }

  if (name === 'tripo_segment') {
    const body = {
      project_id: args.project_id,
      segmentation_granularity: args.granularity || 'balanced',
      model_version: args.model_version || 'v2.0-20260430',
    };
    const j = await api('POST', '/operation/ai_segmentation', body);
    const id = progressId(j.data);
    const st = await waitTask(id, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { operator_id: id, project_id: args.project_id, status: st.status, note: '拆分仍在进行，稍后用 tripo_download' };
    return { operator_id: id, project_id: args.project_id, status: st.status, note: '项目已拆成多部件，用 tripo_download 取结果' };
  }

  if (name === 'tripo_complete') {
    const quick = args.mode === 'quick_cap';
    const parts = args.part_names || await modelMeshNodeNames(args.project_id);
    if (!parts || parts.length < 2) throw new Error('项目还没拆分（模型里不到 2 个部件），先调 tripo_segment');
    const body = {
      project_id: args.project_id,
      part_names: parts,
      model_version: args.model_version || (quick ? 'default' : 'v1.0-20250506'),
    };
    const j = await api('POST', quick ? '/operation/mesh_fill' : '/operation/ai_completion', body);
    const id = progressId(j.data);
    const st = await waitTask(id, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { operator_id: id, project_id: args.project_id, status: st.status, note: '补全仍在进行，稍后用 tripo_download' };
    return { operator_id: id, project_id: args.project_id, status: st.status, note: '项目模型已更新，用 tripo_download 取结果' };
  }

  if (name === 'tripo_pbr') {
    const body = { project_id: args.project_id, model_version: args.model_version || 'v3.0-20250812' };
    const j = await api('POST', '/operation/pbr_generate', body);
    const id = progressId(j.data);
    const st = await waitTask(id, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { operator_id: id, project_id: args.project_id, status: st.status, note: 'PBR 仍在生成，稍后用 tripo_download' };
    return { operator_id: id, project_id: args.project_id, status: st.status, note: '项目模型已更新，用 tripo_download 取结果' };
  }

  if (name === 'tripo_animate') {
    const sources = ['preset', 'motion_asset_id', 'prompt'].filter((k) => args[k]);
    if (sources.length !== 1) throw new Error('preset / motion_asset_id / prompt 三选一');
    const deadline = Date.now() + (args.wait_seconds || 480) * 1000;
    let rigType = args.rig_type;
    if (!rigType) {
      const det = await api('GET', `/project/detail/v3/${args.project_id}?locale=zh-CN`);
      rigType = det?.data?.operator?.rigging?.type || 'biped';
    }

    let taskId = null;
    let assetId = args.motion_asset_id || null;
    if (args.prompt) {
      const gen = await api('POST', '/motion/generate', {
        segments: [{ duration_seconds: args.duration_seconds || 5, prompt: args.prompt }],
      });
      taskId = gen?.data?.task_id;
      if (!taskId) throw new Error('动作任务没拿到 task_id');
      assetId = gen?.data?.asset_id || null;
      while (!assetId) {
        if (Date.now() > deadline) return { task_id: taskId, status: 'timeout', note: '动作仍在生成，稍后用 tripo_list_motions 找到 asset_id 再套' };
        await sleep(5000);
        const t = await api('POST', '/motion/get_task', { task_id: taskId });
        if (t?.data?.status === 'failed') throw new Error('动作生成失败: ' + (t?.data?.error || ''));
        assetId = t?.data?.asset_id || null;
      }
    }

    const body = { project_id: args.project_id, model_version: 'default', rig_type: rigType };
    if (args.preset) {
      const full = args.preset.startsWith('preset:') ? args.preset : `preset:${rigType}:${args.preset}`;
      const name = full.split(':').pop();
      if (!(PRESET_MOTIONS[rigType] || []).includes(name)) throw new Error(`${rigType} 没有预设动作 ${name}，用 tripo_list_motions 查`);
      body.animations = [full];
    } else {
      body.motion_asset_id = assetId;
    }
    const rt = await api('POST', '/operation/retarget_model', body);
    const id = progressId(rt.data);
    const st = await waitTask(id, Math.max(10000, deadline - Date.now()));
    if (st.timedOut) return { task_id: taskId, asset_id: assetId, operator_id: id, status: st.status, note: '动作已生成，重定向仍在进行' };
    return { task_id: taskId, asset_id: assetId, operator_id: id, status: st.status, note: '动画已套到项目模型，用 tripo_download 取结果' };
  }

  if (name === 'tripo_image') {
    if (args.list_templates) {
      const t = await api('GET', '/image/available_templates');
      return (t.data?.templates || []).map((x) => ({ template_id: x.template_id, title: x.title, description: x.description, category: x.category, tags: x.secondary_tag }));
    }
    const deadline = Date.now() + (args.wait_seconds || 300) * 1000;
    const refs = [];
    for (const p of args.image_paths || []) {
      if (!fs.existsSync(p)) throw new Error('找不到图片: ' + p);
      const img = await uploadImage(p);
      refs.push({ bucket: img.bucket, key: img.key, image_audit_result: img.audit, image_source: 'upload' });
    }
    let source = null;
    let asset = null;
    if (args.prompt) {
      const body = {
        if_upload: true,
        sketch_to_render: false,
        t_pose: !!args.t_pose,
        amount: args.multiview ? 1 : Math.min(Math.max(args.amount || 1, 1), 4),
        model_version: args.model || 'gemini_3.1_flash_image_preview',
        prompt: args.prompt,
        resolution: args.multiview ? undefined : (args.resolution || '1K'),
        scale: args.multiview ? undefined : (args.aspect_ratio || (refs.length ? undefined : '1:1')),
        template_id: args.template_id,
      };
      if (refs.length === 1) body.image = refs[0];
      else if (refs.length > 1) body.images = refs;
      const g = await api('POST', '/image/gen_image_v2', body);
      asset = await waitImageAsset(g.data?.asset_id, deadline);
      if (args.multiview) source = { ...asset.output.data[0], image_source: 'generate' };
    } else if (args.multiview && refs.length === 1) {
      source = refs[0];
    } else {
      throw new Error('需要 prompt；或者 multiview:true 加一张 image_paths');
    }
    if (source) {
      const mv = await api('POST', '/image/gen_multiview', {
        if_upload: true,
        image: { bucket: source.bucket, image_audit_result: source.image_audit_result, image_source: source.image_source, key: source.key },
      });
      asset = await waitImageAsset(mv.data?.asset_id, deadline);
    }
    const dir = path.resolve(args.out_dir || `tripo-out/images/${asset.asset_id}`);
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (const [i, d] of (asset.output.data || []).entries()) {
      if (!d.url) continue;
      const name = path.basename(new URL(d.url).pathname) || `image_${i}.png`;
      const r = await request('GET', d.url, { binary: true });
      const p = path.join(dir, name);
      fs.writeFileSync(p, r.buf);
      files.push({ file: p, bytes: r.buf.length, audit: d.image_audit_result });
    }
    if (asset.type === 'multiview_images' && files.length === 4) {
      // 四视图输出顺序是 front, left, back, right（与官方一致）；tripo_generate_multiview 要的是 front, left, right, back
      const [front, left, back, right] = files.map((f) => f.file);
      return { asset_id: asset.asset_id, type: asset.type, views: { front, left, back, right }, multiview_input: [front, left, right, back], files };
    }
    return { asset_id: asset.asset_id, type: asset.type, files };
  }

  if (name === 'tripo_import') {
    if (!fs.existsSync(args.model_path)) throw new Error('找不到模型: ' + args.model_path);
    const format = path.extname(args.model_path).slice(1).toLowerCase();
    if (!['glb', 'fbx', 'obj', 'stl'].includes(format)) throw new Error('只支持 glb / fbx / obj / stl');
    const { bucket, key } = await uploadFile(args.model_path, format);
    const j = await api('POST', '/operation/import_user_model', {
      format,
      model: { bucket, key },
      name: args.name || path.basename(args.model_path),
      transform_matrix: args.transform_matrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      use_original_uv: args.use_original_uv ?? true,
    });
    const id = progressId(j.data);
    const projectId = j.data?.project_id;
    const st = await waitTask(id, (args.wait_seconds || 480) * 1000);
    return { project_id: projectId, operator_id: id, status: st.status, ...(st.timedOut ? { note: '仍在处理' } : {}) };
  }

  if (name === 'tripo_list_projects') {
    const size = Math.min(args.size || 20, 50);
    const r = await api('GET', `/assets/v2?asset_type=mine&locale=zh-CN&offset=${args.offset || 0}&size=${size}&type=all`);
    const d = r.data || {};
    return {
      total: d.total, used_assets: d.used_assets, max_assets: d.max_assets,
      projects: (d.projects || []).map((p) => ({
        project_id: p.id, name: p.project_name, type: p.type, created_at: p.created_at,
        cover: String(p.cover_image || '').split('?')[0] || undefined,
      })),
    };
  }

  if (name === 'tripo_list_motions') {
    const r = await api('POST', '/motion/list_assets', {});
    const presets = args.rig_type ? { [args.rig_type]: PRESET_MOTIONS[args.rig_type] || [] } : PRESET_MOTIONS;
    return {
      generated: (r.data?.assets || []).map((a) => ({ motion_asset_id: a.asset_id, title: a.title, category: a.category, action_type: a.action_type })),
      presets,
    };
  }

  if (name === 'tripo_download') {
    const res = await downloadModel(args.project_id, args.out_path || `tripo-out/${args.project_id}.glb`, args.format || 'glb', !!args.animated, args);
    if (res.dir) {
      return { dir: res.dir, format: res.format, files: res.files.map((f) => ({ file: f.path, bytes: f.bytes })) };
    }
    return { file: res.path, bytes: res.bytes, format: res.format, ...(res.animations ? { animations: res.animations, with_mesh: res.with_mesh } : {}), ...(res.note ? { note: res.note } : {}) };
  }

  throw new Error('unknown tool ' + name);
}

/* ---------- JSON-RPC over stdio ---------- */

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tripo-studio', version: '0.6.0' } } });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const out = await callTool(params.name, params.arguments || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true } });
  }
});





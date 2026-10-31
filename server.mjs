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

// 面数预设：直接调 face_limit 太容易抳出百兆模型，给个台阶
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

// 后处理接口的 part_name_list 用的是项目根节点名（tripo_node_<根 operator>），重拓扑后也不变
async function meshPartNames(projectId) {
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

async function downloadModel(projectId, outPath, format = 'glb') {
  const det = await api('GET', `/project/detail/v3/${projectId}?locale=zh-CN`);
  const url = det?.data?.model_url;
  if (!url) throw new Error('项目里没有 model_url');
  const r = await request('GET', url, { binary: true });
  if (r.status !== 200) throw new Error('下载失败 HTTP ' + r.status);
  const dest = path.resolve(outPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (format === 'glb') {
    fs.writeFileSync(dest, r.buf);
    return { path: dest, bytes: r.buf.length, format: 'glb' };
  }
  const base = path.basename(dest, path.extname(dest));
  const files = await convertModel(r.buf, format, base);
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

async function convertModel(glbBuf, format, name) {
  if (!['fbx', 'obj', 'stl'].includes(format)) throw new Error(`不支持的格式：${format}`);
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
  list.AddFile('model.glb', new Uint8Array(glbBuf));
  const result = assimpModule.ConvertFileList(list, format, {}, name);
  if (!result.IsSuccess() || result.FileCount() === 0) {
    throw new Error(`转换 ${format} 失败：${result.GetErrorCode()}`);
  }
  const out = [];
  for (let i = 0; i < result.FileCount(); i++) {
    const f = result.GetFile(i);
    const data = Buffer.from(f.GetContent());
    const entry = f.GetPath?.() || f.GetName?.() || `result.${format}`;
    if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
      for (const z of readZip(data)) out.push({ name: z.name, data: z.data, archive: true });
    } else {
      out.push({ name: path.basename(entry), data, archive: false });
    }
  }
  result.delete?.();
  list.delete?.();
  return out;
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
  const ext = (path.extname(filePath).slice(1) || 'png').toLowerCase();
  const payload = fs.readFileSync(filePath);
  const tk = await api('POST', '/storage/temporary_token', { client: 'aws', format: ext });
  const creds = tk.data;
  const host = `${creds.resource_bucket}.${creds.host}`;
  const putHeaders = signS3Put({ host, key: creds.resource_uri, payload, contentType: 'application/octet-stream', creds });
  const put = await request('PUT', `https://${host}/${creds.resource_uri}?x-id=PutObject`, { headers: putHeaders, body: payload });
  if (put.status !== 200 && put.status !== 204) {
    throw new Error(`S3 上传失败 HTTP ${put.status} ${String(put.text).slice(0, 300)}`);
  }
  const audit = await api('POST', '/audit/image', { image: { bucket: creds.resource_bucket, key: creds.resource_uri } });
  const auditResult = audit?.data?.result;
  if (auditResult !== undefined && auditResult !== 'pass') throw new Error('图片审核未通过: ' + auditResult);
  return { bucket: creds.resource_bucket, key: creds.resource_uri, audit: auditResult };
}

/* ---------- MCP 工具表 ---------- */

const MODEL_VERSIONS = [
  'v3.1-20260211', 'v3.0-20250812', 'v2.5-20250123', 'v2.0-20240919', 'P1-20260311', 'Turbo-v1.0-20250506',
];

// 参数名与取值对齐官方文档 platform.tripo3d.ai/docs/generation
const GEN_PARAMS = {
  model_version: { type: 'string', enum: MODEL_VERSIONS, description: '模型版本，默认 v3.1-20260211；P1 系列支持四边面' },
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
    description: '查看 Tripo Studio 账号状态（套餐、到期时间、自动续费），也可查某个操作的进度。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'operator_id / task_id，可选' } },
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
    description: '智能 UV 展开，对应内部接口 operation/uv_edit/generate。会覆盖项目当前模型。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        wait_seconds: { type: 'integer', description: '默认 480 秒' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'tripo_rig',
    description: '自动骨骼绑定，对应内部接口 operation/rigging_model。适合人形模型，椅子之类会失败。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        rig_type: { type: 'string', description: '骨骼类型，默认 biped' },
        part_name_list: { type: 'array', items: { type: 'string' }, description: '默认按项目根节点自动填' },
        wait_seconds: { type: 'integer', description: '默认 480 秒' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'tripo_upscale',
    description: '纹理放大，对应内部接口 operation/texture_upscaler。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        model_version: { type: 'string', description: '放大模型版本，目前只接受 v1.0-20250506' },
        part_name_list: { type: 'array', items: { type: 'string' }, description: '默认按项目根节点自动填' },
        wait_seconds: { type: 'integer', description: '默认 480 秒' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'tripo_download',
    description: '把一个已有项目（project_id）的模型下载到本地。format 可选 glb / fbx / obj / stl，后三种在本地用 assimp 转换；FBX 和 OBJ 会连同贴图解到同名目录。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        format: { type: 'string', enum: ['glb', 'fbx', 'obj', 'stl'], description: '默认 glb' },
        out_path: { type: 'string', description: '默认 tripo-out/<project_id>.glb；转换格式的扩展名会自动替换' },
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
    // 必须先取一次 context，action 要用上下文给出的 next_action（generate / retry）
    const ctxRes = await api('POST', '/operation/uv_edit/context', { current_operator_id: cur, project_id: args.project_id });
    const action = ctxRes?.data?.next_action || 'generate';
    const target = ctxRes?.data?.current_operator_id || cur;
    const j = await api('POST', '/operation/uv_edit/generate', { action, current_operator_id: target, project_id: args.project_id });
    const id = progressId(j.data) || target;
    const st = await waitTask(id, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { operator_id: id, project_id: args.project_id, status: st.status, note: 'UV 仍在展开，稍后用 tripo_download' };
    return { operator_id: id, project_id: args.project_id, status: st.status, note: '项目模型已更新，用 tripo_download 取结果' };
  }

  if (name === 'tripo_rig') {
    const parts = args.part_name_list || await meshPartNames(args.project_id);
    const body = { project_id: args.project_id, rig_type: args.rig_type || 'biped' };
    if (parts && parts.length) body.part_name_list = parts;
    const j = await api('POST', '/operation/rigging_model', body);
    const id = progressId(j.data);
    const st = await waitTask(id, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { operator_id: id, project_id: args.project_id, status: st.status, note: '绑定仍在进行，稍后用 tripo_download' };
    return { operator_id: id, project_id: args.project_id, status: st.status, note: '项目模型已更新，用 tripo_download 取结果' };
  }

  if (name === 'tripo_upscale') {
    const parts = args.part_name_list || await meshPartNames(args.project_id);
    const body = { project_id: args.project_id, model_version: args.model_version || 'v1.0-20250506' };
    if (parts && parts.length) body.part_name_list = parts;
    const j = await api('POST', '/operation/texture_upscaler', body);
    const id = progressId(j.data);
    const st = await waitTask(id, (args.wait_seconds || 480) * 1000);
    if (st.timedOut) return { operator_id: id, project_id: args.project_id, status: st.status, note: '纹理放大仍在进行，稍后用 tripo_download' };
    return { operator_id: id, project_id: args.project_id, status: st.status, note: '项目模型已更新，用 tripo_download 取结果' };
  }

  if (name === 'tripo_download') {
    const res = await downloadModel(args.project_id, args.out_path || `tripo-out/${args.project_id}.glb`, args.format || 'glb');
    if (res.dir) {
      return { dir: res.dir, format: res.format, files: res.files.map((f) => ({ file: f.path, bytes: f.bytes })) };
    }
    return { file: res.path, bytes: res.bytes, format: res.format };
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
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tripo-studio', version: '0.4.0' } } });
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



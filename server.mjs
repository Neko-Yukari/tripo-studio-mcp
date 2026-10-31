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
import readline from 'node:readline';

const HOME = path.join(os.homedir(), '.tripo');
const STATE = process.env.TRIPO_STUDIO_STATE || path.join(HOME, 'studio-state.json');
const CONFIG = process.env.TRIPO_STUDIO_CONFIG || path.join(HOME, 'config.json');
const BASE = 'https://api.tripo3d.ai/v2/studio';
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

async function request(method, urlStr, { headers = {}, body = null, binary = false } = {}) {
  const u = new URL(urlStr);
  const host = u.hostname;
  const port = u.port || 443;
  const opts = { method, host, port, path: u.pathname + u.search, headers: { ...headers, host } };
  if (body) opts.headers['content-length'] = Buffer.byteLength(body);

  if (PROXY) {
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

  return new Promise((resolve, reject) => {
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

// 官方 API 文档里的参数名，原样透传（见 platform.tripo3d.ai/docs/generation）
const OFFICIAL_PARAMS = [
  'face_limit', 'texture', 'pbr', 'quad', 'texture_quality', 'geometry_quality',
  'auto_size', 'orientation', 'compress', 'smart_low_poly', 'generate_parts',
  'export_uv', 'model_seed', 'texture_seed', 'enable_image_autofix',
  'texture_alignment', 'visibility',
];

function applyParams(body, args) {
  for (const k of OFFICIAL_PARAMS) {
    if (args[k] !== undefined) body[k] = args[k];
  }
  return body;
}

async function waitTask(id, timeoutMs) {
  const t0 = Date.now();
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

async function downloadModel(projectId, outPath) {
  const det = await api('GET', `/project/detail/v3/${projectId}?locale=zh-CN`);
  const url = det?.data?.model_url;
  if (!url) throw new Error('项目里没有 model_url');
  const r = await request('GET', url, { binary: true });
  if (r.status !== 200) throw new Error('下载失败 HTTP ' + r.status);
  const dest = path.resolve(outPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, r.buf);
  return { path: dest, bytes: r.buf.length };
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
    name: 'tripo_download',
    description: '把一个已有项目（project_id）的 GLB 下载到本地。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        out_path: { type: 'string', description: '默认 tripo-out/<project_id>.glb' },
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

  if (name === 'tripo_download') {
    const file = await downloadModel(args.project_id, args.out_path || `tripo-out/${args.project_id}.glb`);
    return { file: file.path, bytes: file.bytes };
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
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tripo-studio', version: '0.1.0' } } });
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

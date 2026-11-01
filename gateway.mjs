#!/usr/bin/env node
// Tripo 官方 API 兼容网关：把 V3（/v3/*）和 V2（/v2/openapi/*）请求翻译成 Studio 内部接口，花的是订阅积分
// 只做能等价映射的功能；Studio 没有的能力一律按官方错误格式明确拒绝，不做近似替代
//   node gateway.mjs keygen [名字]   签发一个 tsk_ 开头的 key（只存哈希）
//   node gateway.mjs revoke <名字>   作废 key
//   node gateway.mjs [--port 8787] [--host 127.0.0.1] [--tls-cert cert.pem --tls-key key.pem]
//   server.mjs 会带 --attached 自动拉起它：没签过 key 就直接退出，MCP 退出（stdin 关闭）时跟着退出
// SDK 0.4.x 没装 aiohttp 时（Blender 里就是这样）会把 443 端口和 TLS 写死，这时要用 --tls-* 在 443 上跑
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import {
  HOME, api, request, applyParams, progressId, meshPartNames, convertModel, mergeAnimationsIntoGlb,
  uploadImage, uploadFile, GENERATE_DEFAULTS, PRESET_MOTIONS, RIG_TYPES,
} from './lib/studio.mjs';

const DIR = process.env.TRIPO_GATEWAY_DIR || path.join(HOME, 'gateway');
const KEYS = path.join(DIR, 'keys.json');
const STATE = path.join(DIR, 'state.json');
const FILES = path.join(DIR, 'files');
const UPLOADS = path.join(DIR, 'uploads');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };

/* ---------- key ---------- */

const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

function loadKeys() {
  try { return JSON.parse(fs.readFileSync(KEYS, 'utf8')); } catch { /* 首次运行 */ }
  const k = { secret: crypto.randomBytes(32).toString('hex'), keys: [] };
  saveKeys(k);
  return k;
}

function saveKeys(k) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(KEYS, JSON.stringify(k, null, 2));
}

if (argv[0] === 'keygen') {
  const k = loadKeys();
  const name = argv[1] || `key-${k.keys.length + 1}`;
  if (k.keys.some((x) => x.name === name)) { console.error(`已有名为 ${name} 的 key`); process.exit(1); }
  const key = 'tsk_' + crypto.randomBytes(24).toString('base64url');
  k.keys.push({ name, hash: hashKey(key), created_at: new Date().toISOString() });
  saveKeys(k);
  console.log(key);
  process.exit(0);
}
if (argv[0] === 'revoke') {
  const k = loadKeys();
  const before = k.keys.length;
  k.keys = k.keys.filter((x) => x.name !== argv[1]);
  saveKeys(k);
  console.log(before === k.keys.length ? `没有名为 ${argv[1]} 的 key` : `已作废 ${argv[1]}`);
  process.exit(0);
}

if (argv.includes('--attached')) {
  let n = 0;
  try { n = JSON.parse(fs.readFileSync(KEYS, 'utf8')).keys.length; } catch { /* 还没有 keys.json */ }
  if (!n) process.exit(0);
  process.stdin.on('end', () => process.exit(0)).resume();
}

const SECRET = loadKeys().secret;
const TLS_CERT = opt('tls-cert', process.env.TRIPO_GATEWAY_TLS_CERT);
const TLS_KEY = opt('tls-key', process.env.TRIPO_GATEWAY_TLS_KEY);
const TLS = TLS_CERT && TLS_KEY ? { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) } : null;
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex').slice(0, 32);

/* ---------- 任务与上传的持久化 ---------- */

const state = (() => {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { tasks: {}, uploads: {} }; }
})();
for (const t of Object.values(state.tasks)) t.finalizing = false;

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(STATE + '.tmp', JSON.stringify(state));
    fs.renameSync(STATE + '.tmp', STATE);
  }, 200);
}

/* ---------- 错误 ---------- */

class GwError extends Error {
  constructor(status, code, message, suggestion = '') {
    super(message);
    this.status = status; this.code = code; this.suggestion = suggestion;
  }
}
const invalid = (msg, hint = '') => new GwError(400, 1004, msg, hint);
const unsupported = (what, hint = 'Tripo Studio has no equivalent; use the official API for this') =>
  new GwError(400, 2002, `Not supported by the Tripo Studio gateway: ${what}`, hint);

function fromStudio(e) {
  if (e instanceof GwError) return e;
  const msg = String(e?.message || e);
  if (/credit|积分不足|余额不足/i.test(msg)) return new GwError(403, 2010, 'You don\'t have enough Studio credits', msg.slice(0, 300));
  if (/审核/.test(msg)) return new GwError(400, 2008, 'Input rejected by content audit', msg.slice(0, 300));
  if (e?.status === 401 || /找不到登录态/.test(msg)) {
    return new GwError(500, 1000, 'The gateway\'s Tripo Studio session is missing or expired', 'Run npm run login on the gateway machine');
  }
  if (e?.status >= 400 && e?.status < 500) return new GwError(400, 1004, `Tripo Studio rejected the request: ${msg.slice(0, 300)}`);
  return new GwError(500, 1000, msg.slice(0, 300), 'Retry later');
}

/* ---------- 小工具 ---------- */

const FINAL = new Set(['success', 'failed', 'banned', 'expired', 'cancelled']);
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp'];
const MODEL_EXT = ['glb', 'fbx', 'obj', 'stl'];
const MIME = { glb: 'model/gltf-binary', fbx: 'application/octet-stream', obj: 'text/plain', stl: 'model/stl', '3mf': 'model/3mf', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function sniffExt(buf) {
  if (buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(0, 4).toString('latin1') === 'glTF') return 'glb';
  if (buf.subarray(0, 11).toString('latin1') === 'Kaydara FBX') return 'fbx';
  return null;
}

function storeFile(t, name, buf) {
  const dir = path.join(FILES, t.task_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}
const filePath = (t, name) => path.join(FILES, t.task_id, name);

async function fetchBuf(url, what) {
  const r = await request('GET', url, { binary: true });
  if (r.status !== 200) throw new Error(`下载${what}失败 HTTP ${r.status}`);
  return r.buf;
}

function ownTask(id, ctx) {
  const t = state.tasks[id];
  if (!t || t.key !== ctx.key) throw new GwError(404, 2001, 'The task is not found', 'Query a task with the same API key that created it');
  return t;
}

function newTask(ctx, type, input, fields) {
  const t = {
    task_id: crypto.randomUUID(), key: ctx.key, type, input, status: 'queued', progress: 0,
    created_at: Date.now(), out: {}, ...fields,
  };
  state.tasks[t.task_id] = t;
  save();
  return t;
}

// 官方默认值原样出现时放行，其他取值 Studio 做不到就报错
function rejectParams(body, keys, defaults = {}) {
  for (const k of keys) {
    if (body[k] === undefined || body[k] === null) continue;
    if (k in defaults && body[k] === defaults[k]) continue;
    throw unsupported(`parameter ${k}=${JSON.stringify(body[k])}`, `Omit ${k}; Studio has no equivalent`);
  }
}

// 后处理接口的 model：不传时用 Studio 唯一的那个版本；传了别的版本就报错
function fixedModel(body, accepted, label) {
  const m = body.model ?? body.model_version;
  if (m == null || m === '' || accepted.includes(m)) return;
  throw new GwError(400, 2017, `${label} version ${m} is not available in Tripo Studio`,
    accepted.length ? `Omit model or use ${accepted.join(' / ')}` : 'Omit model; Studio runs its own version');
}

/* ---------- 文件引用 ---------- */

function parseRef(ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  if (typeof ref === 'string') {
    if (/^https?:\/\//.test(ref)) return { url: ref };
    if (state.uploads[ref]) return { file_token: ref };
    if (state.tasks[ref]) return { task_id: ref };
    return { file_token: ref };
  }
  if (typeof ref === 'object' && !Array.isArray(ref)) {
    if (!Object.keys(ref).length) return null;
    if (ref.file_token) return { file_token: ref.file_token };
    if (ref.url) return { url: ref.url };
    if (ref.object?.bucket && ref.object?.key) return { object: ref.object };
    if (ref.task_id) return { task_id: ref.task_id };
  }
  throw invalid('Unrecognized file reference', 'Use a file_token, an https URL or {object:{bucket,key}}');
}

async function localFile(r, ctx, allowed) {
  if (r.file_token) {
    const u = state.uploads[r.file_token];
    if (!u || u.key !== ctx.key || u.pending) throw new GwError(400, 1004, `file_token ${r.file_token} is invalid or not uploaded`);
    if (!allowed.includes(u.ext)) throw new GwError(400, 2004, `File type ${u.ext} is not supported here`);
    return { path: u.path, ext: u.ext };
  }
  if (!r.url.startsWith('https://')) throw invalid('Only https:// URLs are supported as file inputs');
  const buf = await fetchBuf(r.url, '输入文件');
  const ext = sniffExt(buf) || path.extname(new URL(r.url).pathname).slice(1).toLowerCase();
  if (!allowed.includes(ext)) throw new GwError(400, 2004, `File type ${ext || 'unknown'} is not supported here`);
  fs.mkdirSync(UPLOADS, { recursive: true });
  const p = path.join(UPLOADS, `url-${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(p, buf);
  return { path: p, ext };
}

// 任意图片引用 → Studio 的图片项（已上传、已过审）
async function studioImage(ref, ctx) {
  const r = parseRef(ref);
  if (!r) return null;
  let file;
  if (r.task_id) {
    const t = ownTask(r.task_id, ctx);
    const name = t.extra?.images?.[0];
    if (t.status !== 'success' || !name) throw new GwError(400, 2007, `Task ${r.task_id} is not a succeeded image task`);
    file = filePath(t, name);
  } else if (r.object) {
    const audit = (await api('POST', '/audit/image', { image: { bucket: r.object.bucket, key: r.object.key } }))?.data?.result;
    if (audit !== 'pass') throw new GwError(400, 2008, 'Input image rejected by content audit');
    return { bucket: r.object.bucket, key: r.object.key, image_audit_result: audit, image_source: 'upload' };
  } else {
    file = (await localFile(r, ctx, IMAGE_EXT)).path;
  }
  const img = await uploadImage(file);
  return { bucket: img.bucket, key: img.key, image_audit_result: img.audit, image_source: 'upload' };
}

/* ---------- 模型版本与生成参数 ---------- */

// 官方名 → Studio 名。P2 与 Studio 的 Nexus-v2.0 同一发布日期；P1 日期不同，不映射
const MODEL_MAP = {
  'v3.1-20260211': 'v3.1-20260211', 'v3.0-20250812': 'v3.0-20250812', 'v2.5-20250123': 'v2.5-20250123',
  'P2-20260801': 'Nexus-v2.0-20260801',
};

function studioModel(body, ctx) {
  const m = body.model ?? body.model_version;
  if (!m) {
    if (ctx.api === 'v3') throw invalid('model is required', `Use one of ${Object.keys(MODEL_MAP).join(', ')}`);
    return 'v2.5-20250123'; // V2 的默认版本
  }
  if (MODEL_MAP[m]) return MODEL_MAP[m];
  throw new GwError(400, 2017, `Model version ${m} is not available in Tripo Studio`, `Use one of ${Object.keys(MODEL_MAP).join(', ')}`);
}

function genBody(body, ctx) {
  rejectParams(body, ['negative_prompt', 'image_seed', 'texture_version', 'export_orientation', 'style']);
  if (body.texture_quality === 'fast') throw unsupported('texture_quality "fast"');
  // 官方默认是 standard 画质、自适应面数；Studio 网页的默认（detailed、200 万面）更贵，不沿用
  const out = applyParams({
    ...GENERATE_DEFAULTS, texture_quality: 'standard', geometry_quality: 'standard', model_version: studioModel(body, ctx),
  }, body);
  if (body.face_limit === undefined) delete out.face_limit;
  if (body.smart_low_poly !== undefined) out.smart_poly = body.smart_low_poly;
  if (body.delight !== undefined) out.delight = body.delight;
  if (out.model_version === 'v2.5-20250123') delete out.geometry_quality;
  return out;
}

/* ---------- 源任务（后处理） ---------- */

function sourceTask(body, ctx) {
  const id = body.original_model_task_id ?? body.original_task_id
    ?? (typeof body.input === 'string' ? body.input : body.input?.task_id);
  if (!id) throw invalid('original_model_task_id (or input) is required');
  if (!state.tasks[id] && (/^https?:/.test(id) || /^file_/.test(id) || state.uploads[id])) {
    throw unsupported('post-processing a file_token or URL directly', 'Create an import_model task first, then pass its task_id');
  }
  const t = ownTask(id, ctx);
  if (t.status !== 'success' || !t.project_id) throw new GwError(400, 2007, 'The original task is not a succeeded model task');
  return t;
}

// Studio 项目是线性的：后处理会改写项目当前模型，只能接着项目的最新状态做
async function currentProject(t) {
  const busy = Object.values(state.tasks).find((x) => x.project_id === t.project_id && x.poll && !FINAL.has(x.status));
  if (busy) {
    throw new GwError(400, 1004, `Task ${busy.task_id} is still running on the same Studio project`,
      'Wait for it to finish; a Studio project runs one operation at a time');
  }
  const det = (await api('GET', `/project/detail/v3/${t.project_id}?locale=zh-CN`)).data || {};
  const cur = det.operator?.operator_id;
  if (t.studio_operator && cur && cur !== t.studio_operator) {
    throw new GwError(400, 2007, `Task ${t.task_id} is no longer the current state of its Studio project`,
      'Studio projects are linear: post-process the latest task of this model, or generate a new one');
  }
  return det;
}

/* ---------- 各任务类型 ---------- */

async function textToModel(ctx, body, type) {
  if (!body.prompt) throw invalid('prompt is required');
  const sb = { ...genBody(body, ctx), prompt: body.prompt };
  const d = (await api('POST', '/operation/text_to_model', sb)).data;
  return newTask(ctx, type, body, { project_id: d.project_id, poll: { kind: 'progress', id: d.task_id }, finalize: 'model', pbr: sb.pbr });
}

async function imageToModel(ctx, body, type) {
  const sb = genBody(body, ctx);
  const img = await studioImage(body.file ?? body.input, ctx);
  if (!img) throw invalid('file (or input) is required');
  sb.image = [{ ...img, texture_quality: sb.texture_quality }];
  const d = (await api('POST', '/operation/batch_image_to_model', sb)).data[0];
  return newTask(ctx, type, body, { project_id: d.project_id, poll: { kind: 'progress', id: d.operator_id || d.operation_id }, finalize: 'model', pbr: sb.pbr });
}

const VIEWS = ['front', 'left', 'back', 'right'];

async function multiviewToModel(ctx, body, type) {
  const sb = genBody(body, ctx);
  const list = body.files ?? body.inputs;
  const taskRef = body.original_task_id ?? body.original_model_task_id
    ?? (Array.isArray(list) && list.length === 1 && list[0]?.task_id ? list[0].task_id : null);
  let refs; // 官方顺序 [front, left, back, right]
  if (taskRef) {
    const t = ownTask(taskRef, ctx);
    if (t.status !== 'success' || !t.extra?.views) throw new GwError(400, 2007, 'The original task is not a succeeded multiview image task');
    refs = VIEWS.map((v) => ({ file: filePath(t, t.extra.views[v]) }));
  } else {
    if (!Array.isArray(list)) throw invalid('files (or inputs) is required');
    const viewKeyed = list.length && list.every((x) => x && typeof x === 'object' && Object.keys(x).length === 1 && VIEWS.includes(Object.keys(x)[0]));
    if (viewKeyed) {
      const m = Object.assign({}, ...list);
      refs = VIEWS.map((v) => parseRef(m[v]));
    } else {
      if (list.length !== 4) throw invalid('files must contain exactly 4 items in the order [front, left, back, right]');
      refs = list.map(parseRef);
    }
  }
  if (!refs[0]) throw invalid('The front view cannot be omitted');
  if (refs.some((r) => !r)) {
    throw unsupported('multiview input with skipped views', 'The Studio gateway needs all four views [front, left, back, right]');
  }
  const images = [];
  for (const r of refs) images.push(r.file ? await uploadAsImage(r.file) : await studioImage(r.file_token ? r.file_token : r.url ? r.url : r, ctx));
  // Studio 的数组顺序是 front, left, right, back
  sb.image = [images[0], images[1], images[3], images[2]].map((im) => ({ ...im, texture_quality: sb.texture_quality }));
  const d = (await api('POST', '/operation/multiview_to_model', sb)).data;
  return newTask(ctx, type, body, { project_id: d.project_id, poll: { kind: 'progress', id: d.task_id }, finalize: 'model', pbr: sb.pbr });
}

async function uploadAsImage(file) {
  const img = await uploadImage(file);
  return { bucket: img.bucket, key: img.key, image_audit_result: img.audit, image_source: 'upload' };
}

async function importModel(ctx, body, type) {
  const r = parseRef(body.file ?? body.input);
  if (!r || r.task_id) throw invalid('file (or input) with a model file is required');
  let model, format;
  if (r.object) {
    format = path.extname(r.object.key).slice(1).toLowerCase();
    model = { bucket: r.object.bucket, key: r.object.key };
  } else {
    const f = await localFile(r, ctx, MODEL_EXT);
    format = f.ext;
    model = await uploadFile(f.path, f.ext);
  }
  if (!MODEL_EXT.includes(format)) throw new GwError(400, 2004, `Model format ${format} is not supported`, `Use ${MODEL_EXT.join(' / ')}`);
  const d = (await api('POST', '/operation/import_user_model', {
    format, model, name: body.name || `import.${format}`,
    transform_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], use_original_uv: true,
  })).data;
  return newTask(ctx, type, body, { project_id: d.project_id, poll: { kind: 'progress', id: progressId(d) }, finalize: 'model' });
}

async function textureModel(ctx, body, type) {
  fixedModel(body, [], 'Texture model');
  rejectParams(body, ['texture_seed', 'style_image', 'bake', 'compress', 'pbr'], { bake: true, pbr: true });
  const tp = body.texture_prompt || {};
  if (tp.text) throw unsupported('text texture prompts (texture_prompt.text)', 'Studio re-texturing takes a reference image only');
  if (tp.images || tp.style_image) throw unsupported('multiple or style texture images');
  const src = sourceTask(body, ctx);
  await currentProject(src);
  const sb = {
    project_id: src.project_id,
    texture_quality: body.texture_quality || 'standard',
    texture_alignment: body.texture_alignment || 'original_image',
    delight: body.delight ?? false,
  };
  const parts = body.part_names || await meshPartNames(src.project_id);
  if (parts?.length) sb.part_names = parts;
  if (tp.image) sb.image = await studioImage(tp.image, ctx);
  const d = (await api('POST', '/operation/texture_model', sb)).data;
  return newTask(ctx, type, body, { project_id: src.project_id, poll: { kind: 'progress', id: progressId(d) }, finalize: 'model' });
}

async function lowpoly(ctx, body, type) {
  fixedModel(body, [], 'Retopology');
  rejectParams(body, ['smart_uv'], { smart_uv: false });
  if (!body.face_limit) throw invalid('face_limit is required');
  const src = sourceTask(body, ctx);
  await currentProject(src);
  const parts = body.part_names || await meshPartNames(src.project_id);
  const sb = {
    project_id: src.project_id, face_limit: body.face_limit, quad: body.quad ?? false,
    smart_poly: true, bake: body.bake ?? true, model_version: 'default',
  };
  if (parts?.length) sb.part_name_list = parts;
  const d = (await api('POST', '/operation/remesh', sb)).data;
  return newTask(ctx, type, body, { project_id: src.project_id, poll: { kind: 'progress', id: progressId(d) }, finalize: 'model' });
}

async function segment(ctx, body, type) {
  fixedModel(body, ['v2.0-20260430'], 'Segmentation');
  rejectParams(body, ['split_by_connectivity', 'ref_image']);
  const g = body.segmentation_granularity ?? 'balanced';
  if (!['simple', 'balanced', 'detailed'].includes(g)) throw invalid('segmentation_granularity must be simple / balanced / detailed');
  const src = sourceTask(body, ctx);
  await currentProject(src);
  const d = (await api('POST', '/operation/ai_segmentation', {
    project_id: src.project_id, segmentation_granularity: g, model_version: 'v2.0-20260430',
  })).data;
  return newTask(ctx, type, body, { project_id: src.project_id, poll: { kind: 'progress', id: progressId(d) }, finalize: 'model' });
}

async function complete(ctx, body, type) {
  fixedModel(body, ['v1.0-20250506'], 'Completion');
  rejectParams(body, ['completion_mode']);
  if (!Array.isArray(body.part_names) || !body.part_names.length) throw invalid('part_names is required');
  const src = sourceTask(body, ctx);
  await currentProject(src);
  const d = (await api('POST', '/operation/ai_completion', {
    project_id: src.project_id, part_names: body.part_names, model_version: 'v1.0-20250506',
  })).data;
  return newTask(ctx, type, body, { project_id: src.project_id, poll: { kind: 'progress', id: progressId(d) }, finalize: 'model' });
}

async function meshUv(ctx, body, type) {
  fixedModel(body, [], 'UV');
  rejectParams(body, ['bake', 'export_orientation', 'compress'], { bake: true });
  const src = sourceTask(body, ctx);
  const det = await currentProject(src);
  const cur = det.operator?.operator_id;
  const c = (await api('POST', '/operation/uv_edit/context', { current_operator_id: cur, project_id: src.project_id })).data || {};
  // 有未应用的旧候选时也重新展开一次，不拿旧结果充数
  const action = c.next_action === 'apply' ? 'retry' : (c.next_action || 'generate');
  const target = c.current_operator_id || cur;
  const d = (await api('POST', '/operation/uv_edit/generate', { action, current_operator_id: target, project_id: src.project_id })).data;
  const id = d?.operator_id || progressId(d);
  return newTask(ctx, type, body, { project_id: src.project_id, poll: { kind: 'progress', id }, finalize: 'model', uv_target: target });
}

async function rigCheck(ctx, body, type) {
  const src = sourceTask(body, ctx);
  await currentProject(src);
  const c = (await api('POST', '/operation/pre_rig_check', { project_id: src.project_id, model_version: 'v3.0-20260909' })).data || {};
  return newTask(ctx, type, body, {
    project_id: src.project_id, status: 'success', progress: 100, completed_at: Date.now(),
    out: { riggable: !!c.riggable, rig_type: c.rig_type, topology: c.rig_type },
  });
}

const RIG_SPECS = ['mixamo', 'actorcore', 'unreal', 'unity', 'vrm'];

async function rig(ctx, body, type) {
  fixedModel(body, ['v3.0-20260909'], 'Rig');
  rejectParams(body, ['out_format'], { out_format: 'glb' });
  const rigType = body.rig_type || 'biped';
  if (!RIG_TYPES.includes(rigType)) throw invalid(`rig_type must be one of ${RIG_TYPES.join(', ')}`);
  if (body.spec === 'tripo') throw unsupported('spec "tripo"', `Studio specs: ${RIG_SPECS.join(', ')} (omit spec for mixamo)`);
  if (body.spec && !RIG_SPECS.includes(body.spec)) throw invalid(`spec must be one of ${RIG_SPECS.join(', ')}`);
  const src = sourceTask(body, ctx);
  await currentProject(src);
  const sb = { project_id: src.project_id, model_version: 'v3.0-20260909', rig_type: rigType };
  if (rigType === 'biped') sb.spec = body.spec || 'mixamo';
  const d = (await api('POST', '/operation/rigging_model', sb)).data;
  return newTask(ctx, type, body, { project_id: src.project_id, poll: { kind: 'progress', id: progressId(d) }, finalize: 'model', rig_type: rigType });
}

function studioPreset(anim, rigType) {
  const m = /^preset:(?:([a-z]+):)?([a-z0-9_-]+)$/.exec(String(anim || ''));
  if (!m) throw unsupported(`animation ${anim}`, 'Only preset:* animations are supported');
  const rt = m[1] || 'biped';
  if (rt !== rigType) throw invalid(`Preset ${anim} is for ${rt}, but the model is rigged as ${rigType}`);
  if (!(PRESET_MOTIONS[rt] || []).includes(m[2])) {
    throw unsupported(`preset ${anim}`, `Studio ${rt} presets: ${(PRESET_MOTIONS[rt] || []).join(', ')}`);
  }
  return `preset:${rt}:${m[2]}`;
}

async function retarget(ctx, body, type) {
  rejectParams(body, ['out_format', 'animate_in_place'], { out_format: 'glb', animate_in_place: false });
  const anims = body.animations ?? (body.animation ? [body.animation] : []);
  if (!anims.length) throw invalid('animation (or animations) is required');
  if (anims.length > 1) throw unsupported('more than one animation per task', 'Create one animate_retarget task per animation');
  const src = sourceTask(body, ctx);
  const det = await currentProject(src);
  const rigType = src.rig_type || det.operator?.rigging?.type;
  if (!rigType) throw new GwError(400, 2012, 'The original task is not a rigged model', 'Run animate_rig first');
  const sb = { project_id: src.project_id, model_version: 'default', rig_type: rigType, animations: [studioPreset(anims[0], rigType)] };
  const d = (await api('POST', '/operation/retarget_model', sb)).data;
  return newTask(ctx, type, body, {
    project_id: src.project_id, poll: { kind: 'progress', id: progressId(d) }, finalize: 'retarget',
    rig_type: rigType, with_geometry: body.export_with_geometry ?? true,
  });
}

const CONVERT_FORMATS = { GLTF: 'gltf2', FBX: 'fbx', OBJ: 'obj', STL: 'stl', '3MF': '3mf' };
const CONVERT_DEFAULTS = {
  quad: false, force_symmetry: false, flatten_bottom: false, pivot_to_center_bottom: false, scale_factor: 1,
  with_animation: true, pack_uv: false, bake: true, animate_in_place: false, export_vertex_colors: false,
  flatten_bottom_threshold: 0.01, texture_size: 4096, texture_format: 'JPEG',
};

async function convert(ctx, body, type) {
  const fmt = String(body.format || '').toUpperCase();
  if (fmt === 'USDZ') throw unsupported('USDZ export');
  if (!CONVERT_FORMATS[fmt]) throw invalid(`format must be one of ${Object.keys(CONVERT_FORMATS).join(', ')}`);
  rejectParams(body, [...Object.keys(CONVERT_DEFAULTS), 'face_limit', 'part_names', 'export_orientation', 'fbx_preset'], CONVERT_DEFAULTS);
  const src = sourceTask(body, ctx);
  if (['animate_rig', 'animate_retarget'].includes(src.type)) throw unsupported('converting rigged or animated models', 'Use the GLB from the rig/retarget task');
  if (!src.artifact) throw new GwError(400, 2006, 'The original task has no model output');
  const t = newTask(ctx, type, body, { status: 'running', local: true });
  // 本地 assimp 转换，不碰 Studio；带贴图的 FBX/OBJ/GLTF 以 zip 交付
  (async () => {
    const buf = fs.readFileSync(filePath(src, src.artifact));
    const srcExt = path.extname(src.artifact).slice(1);
    let name;
    if (CONVERT_FORMATS[fmt] === srcExt) {
      name = storeFile(t, `model.${srcExt}`, buf);
    } else {
      const files = await convertModel(buf, CONVERT_FORMATS[fmt], 'model', srcExt, { unzip: false });
      if (files.length !== 1) throw new Error(`转换结果有 ${files.length} 个文件`);
      const f = files[0];
      const zipped = f.data[0] === 0x50 && f.data[1] === 0x4b && fmt !== '3MF';
      name = storeFile(t, zipped ? 'model.zip' : `model.${fmt === 'GLTF' ? 'gltf' : fmt.toLowerCase()}`, f.data);
    }
    t.artifact = name;
    t.out = { model: { file: name } };
  })().then(() => done(t), (e) => fail(t, e));
  return t;
}

const IMAGE_SCALES = ['1:1', '16:9', '9:16', '4:3', '3:4'];

async function generateImage(ctx, body, type) {
  rejectParams(body, ['size', 'quality', 'background', 'output_format', 'watermark', 'template', 'negative_prompt']);
  if (!body.prompt) throw invalid('prompt is required');
  if (body.aspect_ratio && !IMAGE_SCALES.includes(body.aspect_ratio)) throw unsupported(`aspect_ratio ${body.aspect_ratio}`, `Studio ratios: ${IMAGE_SCALES.join(', ')}`);
  const refs = [];
  for (const r of [body.file, body.input, ...(body.files || []), ...(body.inputs || [])].filter((x) => x != null && x !== '')) {
    refs.push(await studioImage(r, ctx));
  }
  const sb = {
    if_upload: true, sketch_to_render: !!body.sketch_to_render, t_pose: !!body.t_pose, amount: 1,
    model_version: body.model ?? body.model_version ?? 'gemini_3.1_flash_image_preview',
    prompt: body.prompt, resolution: '1K', scale: body.aspect_ratio || (refs.length ? undefined : '1:1'),
  };
  if (refs.length === 1) sb.image = refs[0];
  else if (refs.length > 1) sb.images = refs;
  const d = (await api('POST', '/image/gen_image_v2', sb)).data;
  return newTask(ctx, type, body, { poll: { kind: 'image', id: d.asset_id }, finalize: 'image' });
}

async function multiviewImage(ctx, body, type) {
  const img = await studioImage(body.file ?? body.input, ctx);
  if (!img) throw invalid('file (or input) is required');
  const d = (await api('POST', '/image/gen_multiview', { if_upload: true, image: img })).data;
  return newTask(ctx, type, body, { poll: { kind: 'image', id: d.asset_id }, finalize: 'multiview_image' });
}

/* ---------- 收尾：拉结果、缓存到本地 ---------- */

async function finalizeModel(t) {
  if (t.uv_target) {
    // UV 只产出候选，应用之后才替换项目当前模型
    await api('POST', '/operation/uv_edit/apply', { project_id: t.project_id, current_operator_id: t.uv_target, candidate_operator_id: t.poll.id });
  }
  const det = (await api('GET', `/project/detail/v3/${t.project_id}?locale=zh-CN`)).data || {};
  if (!det.model_url) throw new Error('项目里没有 model_url');
  t.studio_operator = det.operator?.operator_id;
  const buf = await fetchBuf(det.model_url, '模型');
  t.artifact = storeFile(t, `model.${sniffExt(buf) || 'glb'}`, buf);
  t.out = { [t.pbr ? 'pbr_model' : 'model']: { file: t.artifact } };
  await cover(t, det);
}

async function finalizeRetarget(t) {
  const det = (await api('GET', `/project/detail/v3/${t.project_id}?locale=zh-CN`)).data || {};
  t.studio_operator = det.operator?.operator_id;
  const list = (det.operator?.retarget || []).filter((x) => x.status === 'success' && x.model_url);
  const pick = list.find((x) => x.operator_id === t.poll.id) || list[0];
  if (!pick) throw new Error('项目里没有动画结果');
  const anim = await fetchBuf(pick.model_url, '动画');
  // Studio 的动画 GLB 只有骨骼和轨道；官方默认带网格，所以按骨骼名并回绑定后的网格
  const out = t.with_geometry ? mergeAnimationsIntoGlb(await fetchBuf(det.model_url, '模型'), [{ name: pick.name, buf: anim }]) : anim;
  t.artifact = storeFile(t, 'model.glb', out);
  t.out = { model: { file: t.artifact } };
  await cover(t, det);
}

async function cover(t, det) {
  // 封面是 [彩色, 灰模] 两张，取彩色那张
  const c = det.cover_image || det.operator?.cover_image;
  const url = Array.isArray(c) ? c[0] : c;
  if (!url) return;
  try {
    const buf = await fetchBuf(url, '预览图');
    t.out.rendered_image = { file: storeFile(t, `preview.${sniffExt(buf) || 'png'}`, buf) };
  } catch { /* 预览图可有可无 */ }
}

async function finalizeImages(t) {
  const a = (await api('POST', '/image/get_image_asset', { asset_id: t.poll.id })).data || {};
  const files = [];
  for (const [i, d] of (a.output?.data || []).filter((x) => x.url).entries()) {
    const buf = await fetchBuf(d.url, '图片');
    files.push(storeFile(t, `image_${i}.${sniffExt(buf) || 'png'}`, buf));
  }
  if (t.finalize === 'multiview_image') {
    // Studio 四视图输出顺序与官方一致：front, left, back, right
    if (files.length !== 4) throw new Error(`四视图只拿到 ${files.length} 张`);
    t.extra = { views: Object.fromEntries(VIEWS.map((v, i) => [v, files[i]])) };
    t.out = { generate_multiview_image: Object.fromEntries(VIEWS.map((v, i) => [`${v}_view_url`, { file: files[i] }])) };
  } else {
    if (!files.length) throw new Error('生图结果为空');
    t.extra = { images: files };
    t.out = { generated_image: { file: files[0] } };
  }
}

const FINALIZERS = { model: finalizeModel, retarget: finalizeRetarget, image: finalizeImages, multiview_image: finalizeImages };

async function done(t) {
  t.status = 'success'; t.progress = 100; t.completed_at = Date.now();
  if (t.poll?.kind === 'progress') {
    try {
      const l = await api('GET', '/txn/records?page_num=1&page_size=30');
      const ids = new Set([t.poll.id, t.studio_operator].filter(Boolean));
      const r = (l.data?.records || []).find((x) => ids.has(x.operator_id));
      if (r) t.credits = Number(r.amount) || 0;
    } catch { /* 积分只是附加信息 */ }
  }
  save();
}

function fail(t, e, status = 'failed') {
  t.status = status; t.completed_at = Date.now();
  t.error = { code: 1001, message: String(e?.message || e).slice(0, 300) };
  console.error('[gateway] task', t.task_id, status, t.error.message);
  save();
}

/* ---------- 后台轮询 Studio ---------- */

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const t of Object.values(state.tasks)) {
      if (FINAL.has(t.status) || t.finalizing || !t.poll) continue;
      let st, progress;
      try {
        if (t.poll.kind === 'progress') {
          const d = (await api('POST', '/progress', { ids: [t.poll.id] })).data?.[0] || {};
          st = d.status; progress = Number(d.progress) || 0;
          t.left_time = d.left_time;
        } else {
          const a = (await api('POST', '/image/get_image_asset', { asset_id: t.poll.id })).data || {};
          st = a.status; progress = st === 'success' ? 100 : 50;
        }
        t.poll_fails = 0;
      } catch (e) {
        if (++t.poll_fails >= 20) fail(t, e);
        continue;
      }
      if (st === 'success') {
        t.finalizing = true; t.status = 'running'; t.progress = 99;
        FINALIZERS[t.finalize](t).then(() => done(t), (e) => fail(t, e)).finally(() => { t.finalizing = false; });
      } else if (['failed', 'banned', 'cancelled', 'expired'].includes(st)) {
        fail(t, `Studio task ${st}`, st);
      } else {
        t.status = st === 'queued' || st === 'waiting' ? 'queued' : 'running';
        t.progress = Math.min(progress, 99);
      }
    }
    save();
  } finally {
    ticking = false;
  }
}

/* ---------- 输出渲染 ---------- */

function fileUrl(base, t, name) {
  return `${base}/files/${t.task_id}/${sign(`${t.task_id}/${name}`)}/${encodeURIComponent(name)}`;
}

function resolveOut(v, base, t) {
  if (v && typeof v === 'object') {
    if (v.file) return fileUrl(base, t, v.file);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveOut(x, base, t)]));
  }
  return v;
}

function renderTask(t, ctx) {
  const out = t.status === 'success' ? resolveOut(t.out || {}, ctx.base, t) : {};
  const err = t.error ? t.error : null;
  if (ctx.api === 'v2') {
    return {
      task_id: t.task_id, type: t.type, status: t.status, input: t.input, output: out,
      progress: t.progress, create_time: Math.floor(t.created_at / 1000), consumed_credit: t.credits || 0,
      queuing_num: -1, running_left_time: FINAL.has(t.status) ? -1 : (Number(t.left_time) || -1),
      ...(err ? { error_code: err.code, error_msg: err.message } : {}),
    };
  }
  const o3 = {};
  const model = out.pbr_model || out.model || out.base_model;
  if (model) o3.model_url = model;
  if (out.rendered_image) o3.rendered_image_url = out.rendered_image;
  if (out.generated_image) o3.generated_image_url = out.generated_image;
  if (out.generate_multiview_image) o3.generate_multiview_image = out.generate_multiview_image;
  if (out.riggable !== undefined) { o3.riggable = out.riggable; o3.rig_type = out.rig_type; }
  return {
    task_id: t.task_id, type: t.type, status: ['banned', 'expired'].includes(t.status) ? 'failed' : t.status,
    progress: t.progress, input: t.input, output: o3, credits_consumed: t.credits || 0,
    created_at: new Date(t.created_at).toISOString(),
    ...(t.completed_at ? { completed_at: new Date(t.completed_at).toISOString() } : {}),
    ...(err ? { error_code: err.code, error_message: err.message } : {}),
  };
}

/* ---------- 上传 ---------- */

function parseMultipart(buf, ctype) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ctype || '');
  if (!m) throw new GwError(400, 1003, 'The request body is malformed', 'Send multipart/form-data with a file field');
  const b = Buffer.from('--' + (m[1] || m[2]));
  const parts = [];
  let pos = buf.indexOf(b);
  while (pos >= 0) {
    const start = pos + b.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(b, start);
    if (next < 0) break;
    const part = buf.subarray(start + 2, next - 2);
    const he = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, he).toString('utf8');
    parts.push({ name: /name="([^"]*)"/i.exec(head)?.[1], filename: /filename="([^"]*)"/i.exec(head)?.[1], data: part.subarray(he + 4) });
    pos = next;
  }
  return parts;
}

function saveUpload(ctx, data, filename, allowed) {
  const ext = (sniffExt(data) || path.extname(filename || '').slice(1)).toLowerCase().replace('jpeg', 'jpg');
  if (!data.length) throw new GwError(400, 2003, 'The file is empty');
  if (!allowed.includes(ext)) throw new GwError(400, 2004, `File type ${ext || 'unknown'} is not supported`, `Use ${allowed.join(' / ')}`);
  const limit = IMAGE_EXT.includes(ext) ? 20 : 150;
  if (data.length > limit * 1024 * 1024) throw invalid(`File exceeds ${limit} MB`);
  const token = ctx.api === 'v3' ? `file_${crypto.randomUUID().replace(/-/g, '')}` : crypto.randomUUID();
  fs.mkdirSync(UPLOADS, { recursive: true });
  const p = path.join(UPLOADS, `${token}.${ext}`);
  fs.writeFileSync(p, data);
  state.uploads[token] = { key: ctx.key, path: p, ext, created_at: Date.now() };
  save();
  return token;
}

function multipartFile(ctx, req, buf, allowed) {
  const f = parseMultipart(buf, req.headers['content-type']).find((p) => p.name === 'file');
  if (!f) throw invalid('file field is required');
  return saveUpload(ctx, f.data, f.filename, allowed);
}

/* ---------- 路由 ---------- */

const V2_TYPES = {
  text_to_model: textToModel, image_to_model: imageToModel, multiview_to_model: multiviewToModel,
  import_model: importModel, texture_model: textureModel, highpoly_to_lowpoly: lowpoly,
  mesh_segmentation: segment, mesh_completion: complete, animate_prerigcheck: rigCheck, animate_rig: rig,
  animate_retarget: retarget, convert_model: convert, conversion: convert,
  text_to_image: generateImage, generate_image: generateImage, generate_multiview_image: multiviewImage,
};
const V2_UNSUPPORTED = {
  refine_model: 'refine_model', stylize_model: 'stylize_model (lego/voxel/voronoi/minecraft)',
  edit_multiview_image: 'edit_multiview_image', classification: 'classification',
  render_video: 'render_video', render_image: 'render_image', image_to_splat: 'image_to_splat',
};
const V3_CREATE = {
  'generation/text-to-model': ['text_to_model', textToModel],
  'generation/image-to-model': ['image_to_model', imageToModel],
  'generation/multiview-to-model': ['multiview_to_model', multiviewToModel],
  'generation/text-to-image': ['text_to_image', generateImage],
  'generation/image-to-image': ['generate_image', generateImage],
  'generation/image-to-multiview': ['image_to_multiview', multiviewImage],
  'models/texture': ['texture_model', textureModel],
  'models/convert': ['convert_model', convert],
  'models/import': ['import_model', importModel],
  'mesh/segment': ['mesh_segmentation', segment],
  'mesh/complete': ['mesh_completion', complete],
  'mesh/decimate': ['highpoly_to_lowpoly', lowpoly],
  'mesh/uv': ['mesh_uv', meshUv],
  'animations/rig-check': ['animate_prerigcheck', rigCheck],
  'animations/rig': ['animate_rig', rig],
  'animations/retarget': ['animate_retarget', retarget],
};
const V3_UNSUPPORTED = {
  'generation/edit-multiview': 'edit_multiview', 'generation/image-to-splat': 'image_to_splat (Gaussian splats)',
  'generation/image-to-depth': 'image_to_depth', 'models/refine': 'refine_model',
  'models/stylize': 'stylize_model', 'mesh/smartsegment': 'smart segmentation', 'mesh/edit': 'mesh editing',
  'files/upload-credentials': 'STS upload credentials (use POST /v3/files or /v3/files/presign)',
};

async function balance() {
  const p = await api('GET', '/user/profile/payment');
  return { balance: Number(p.data?.wallet?.total_credit) || 0, frozen: 0 };
}

async function readBody(req, limit = 160 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw invalid('Request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function json(buf) {
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new GwError(400, 1003, 'The request body is malformed'); }
}

async function route(req, ctx, url) {
  const p = url.pathname;
  const m = req.method;

  if (ctx.api === 'v2') {
    const sub = p.slice('/v2/openapi'.length);
    if (m === 'POST' && sub === '/task') {
      const body = json(await readBody(req));
      if (V2_UNSUPPORTED[body.type]) throw unsupported(V2_UNSUPPORTED[body.type]);
      const fn = V2_TYPES[body.type];
      if (!fn) throw new GwError(400, 2002, 'This task type is not supported', `Supported: ${Object.keys(V2_TYPES).join(', ')}`);
      const t = await fn(ctx, body, body.type === 'conversion' ? 'convert_model' : body.type);
      return { task_id: t.task_id };
    }
    let mm;
    if (m === 'GET' && (mm = /^\/task\/([0-9a-f-]{36})$/.exec(sub))) return renderTask(ownTask(mm[1], ctx), ctx);
    if (m === 'POST' && (sub === '/upload' || sub === '/upload/sts')) {
      return { image_token: multipartFile(ctx, req, await readBody(req), ['png', 'jpg', 'webp']) };
    }
    if (m === 'POST' && sub === '/upload/sts/token') {
      // 直接发 Studio 自己的 STS 凭据：客户端传到 Studio 的桶，建任务时用 {object:{bucket,key}} 引用
      const body = json(await readBody(req));
      const fmt = String(body.format || 'webp').toLowerCase();
      if (![...IMAGE_EXT, ...MODEL_EXT].includes(fmt)) throw new GwError(400, 2004, `Format ${fmt} is not supported`);
      const c = (await api('POST', '/storage/temporary_token', { client: 'aws', format: fmt })).data;
      return { s3_host: c.host, resource_bucket: c.resource_bucket, resource_uri: c.resource_uri, session_token: c.session_token, sts_ak: c.sts_ak, sts_sk: c.sts_sk };
    }
    if (m === 'GET' && sub === '/user/balance') return balance();
    if (/^\/task\/watch/.test(sub)) throw unsupported('WebSocket task watch', 'Poll GET /task/{task_id}');
    if (sub === '/task/batch') throw unsupported('batch task creation', 'Create tasks one by one');
    if (/^\/user\/wallet|^\/upload\/temporary_token/.test(sub)) throw unsupported(sub);
    throw new GwError(404, 1004, `No endpoint ${m} ${p}`);
  }

  const sub = p.slice('/v3/'.length);
  if (m === 'POST' && V3_CREATE[sub]) {
    const [type, fn] = V3_CREATE[sub];
    const t = await fn(ctx, json(await readBody(req)), type);
    return { task_id: t.task_id, type: t.type, status: t.status };
  }
  if (V3_UNSUPPORTED[sub]) throw unsupported(V3_UNSUPPORTED[sub]);
  let mm;
  if (m === 'GET' && (mm = /^tasks\/([0-9a-f-]{36})$/.exec(sub))) return renderTask(ownTask(mm[1], ctx), ctx);
  if (m === 'POST' && sub === 'tasks/list') {
    const ids = json(await readBody(req)).task_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw invalid('task_ids must be an array of 1-100 ids');
    const tasks = {}, missed = [];
    for (const id of ids) {
      if (!/^[0-9a-f-]{36}$/.test(String(id))) throw invalid(`Invalid task id ${id}`);
      const t = state.tasks[id];
      if (t && t.key === ctx.key) tasks[id] = renderTask(t, ctx); else missed.push(id);
    }
    return { tasks, missed: missed.length ? missed : null };
  }
  if (m === 'POST' && sub === 'files') {
    return { file_token: multipartFile(ctx, req, await readBody(req), ['png', 'jpg', 'webp', ...MODEL_EXT]) };
  }
  if (m === 'POST' && sub === 'files/presign') {
    const fmt = String(json(await readBody(req)).format || '').toLowerCase().replace('jpeg', 'jpg');
    if (!['png', 'jpg', 'webp', ...MODEL_EXT].includes(fmt)) throw new GwError(400, 2004, `Format ${fmt || '(empty)'} is not supported`, `Use ${['png', 'jpg', 'webp', ...MODEL_EXT].join(' / ')}`);
    const token = `file_${crypto.randomUUID().replace(/-/g, '')}`;
    state.uploads[token] = { key: ctx.key, path: path.join(UPLOADS, `${token}.${fmt}`), ext: fmt, pending: true, created_at: Date.now() };
    save();
    const u = `${ctx.base}/uploads/${token}/${sign(token)}`;
    return { presigned_url: u, upload_url: u, file_token: token, expires_in: 1800 };
  }
  if (m === 'GET' && sub === 'account/balance') return balance();
  if (m === 'GET' && sub === 'account/usage') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 200);
    const offset = Number(url.searchParams.get('offset')) || 0;
    if (offset % limit) throw invalid('offset must be a multiple of limit');
    const l = await api('GET', `/txn/records?page_num=${offset / limit + 1}&page_size=${limit}`);
    const byOp = new Map(Object.values(state.tasks).filter((t) => t.key === ctx.key && t.poll).map((t) => [t.poll.id, t]));
    const rows = (l.data?.records || []).filter((r) => r.direction === 'sub').map((r) => {
      const t = byOp.get(r.operator_id);
      const time = Number(r.create_time);
      return {
        task_id: t?.task_id || r.operator_id, type: t?.type || r.sub_type, credits_consumed: Number(r.amount) || 0,
        created_at: Number.isFinite(time) ? new Date(time * (time < 1e12 ? 1000 : 1)).toISOString() : r.create_time, status: r.status,
      };
    });
    return { items: rows, limit, offset };
  }
  throw new GwError(404, 4001, `No endpoint found: ${m} ${p}`);
}

function send(res, status, body, trace) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-tripo-trace-id': trace });
  res.end(JSON.stringify(body));
}

function serveFile(req, res, mm) {
  const [, taskId, sig, rawName] = mm;
  const name = decodeURIComponent(rawName);
  const t = state.tasks[taskId];
  if (!t || sig !== sign(`${taskId}/${name}`) || name.includes('/') || name.includes('\\')) { res.writeHead(404); return res.end(); }
  const p = filePath(t, name);
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(name).slice(1)] || 'application/octet-stream', 'content-length': fs.statSync(p).size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(p).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const trace = crypto.randomUUID();
  const t0 = Date.now();
  let mm;
  if ((req.method === 'GET' || req.method === 'HEAD') && (mm = /^\/files\/([0-9a-f-]{36})\/([0-9a-f]{32})\/([^/]+)$/.exec(url.pathname))) {
    return serveFile(req, res, mm);
  }
  if (req.method === 'PUT' && (mm = /^\/uploads\/(file_[0-9a-f]{32})\/([0-9a-f]{32})$/.exec(url.pathname))) {
    const u = state.uploads[mm[1]];
    if (!u || !u.pending || mm[2] !== sign(mm[1])) { res.writeHead(403); return res.end(); }
    const buf = await readBody(req);
    fs.mkdirSync(UPLOADS, { recursive: true });
    fs.writeFileSync(u.path, buf);
    u.pending = false;
    save();
    res.writeHead(200); return res.end();
  }

  const apiVer = url.pathname.startsWith('/v2/openapi/') ? 'v2' : url.pathname.startsWith('/v3/') ? 'v3' : null;
  const ctx = { api: apiVer, base: PUBLIC_URL };
  const reply = (status, data) => {
    send(res, status, apiVer === 'v3' ? { code: 0, status: 'success', data } : { code: 0, data }, trace);
  };
  const replyError = (e) => {
    const body = apiVer === 'v3'
      ? { code: e.code, status: 'error', message: e.message, suggestion: e.suggestion, request_id: trace }
      : { code: e.code, message: e.message, suggestion: e.suggestion };
    send(res, e.status, body, trace);
  };
  try {
    if (!apiVer) throw new GwError(404, 4001, `No endpoint found: ${req.method} ${url.pathname}`);
    const key = /^Bearer\s+(tsk_\S+)$/i.exec(req.headers.authorization || '')?.[1];
    const hash = key && hashKey(key);
    if (!hash || !loadKeys().keys.some((k) => k.hash === hash)) {
      throw new GwError(401, apiVer === 'v3' ? 2 : 1002, apiVer === 'v3' ? 'Invalid API key' : 'Authentication failed',
        'Check if your credentials is valid, and ensure you set it correctly');
    }
    ctx.key = hash;
    reply(200, await route(req, ctx, url));
  } catch (e) {
    const g = fromStudio(e);
    if (!(e instanceof GwError)) console.error('[gateway]', req.method, url.pathname, e?.message);
    replyError(g);
  } finally {
    console.error(`[gateway] ${req.method} ${url.pathname} -> ${res.statusCode} ${Date.now() - t0}ms`);
  }
}

const port = Number(opt('port', process.env.TRIPO_GATEWAY_PORT || 8787));
const host = opt('host', process.env.TRIPO_GATEWAY_HOST || '127.0.0.1');
// 产物链接的前缀。客户端发来的 Host 不一定带端口，不能拿来拼；默认端口要省掉，否则 SDK 0.4.x 的 legacy 客户端会把“host:443”当主机名解析
const PUBLIC_URL = (process.env.TRIPO_GATEWAY_PUBLIC_URL || `${TLS ? 'https' : 'http'}://${['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host}${port === (TLS ? 443 : 80) ? '' : `:${port}`}`).replace(/\/$/, '');
const onRequest = (req, res) => {
  handle(req, res).catch((e) => {
    console.error('[gateway]', req.method, req.url, e?.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
};
const server = TLS ? https.createServer(TLS, onRequest) : http.createServer(onRequest);
// V2 的 WebSocket watch 已不支持，升级请求直接拒绝，免得客户端挂住
server.on('upgrade', (req, socket) => {
  const body = JSON.stringify({ code: 2002, message: 'Not supported by the Tripo Studio gateway: WebSocket task watch', suggestion: 'Poll GET /task/{task_id}' });
  socket.end(`HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
});
server.listen(port, host, () => {
  console.error(`[gateway] listening on ${TLS ? 'https' : 'http'}://${host}:${port}  (V3: /v3, V2: /v2/openapi)`);
  if (!loadKeys().keys.length) console.error('[gateway] 还没有 key：先运行 node gateway.mjs keygen');
  // 拿到端口才开始轮询，免得没抢到端口的实例也去写 state.json
  const poll = () => tick().catch((e) => console.error('[gateway] poll', e?.message));
  poll();
  setInterval(poll, 3000);
});
// 端口被占用多半是另一个 MCP 实例已经拉起了网关；用退出码 3 告诉 server.mjs 稍后再试
server.on('error', (e) => {
  console.error(`[gateway] ${host}:${port} ${e.code === 'EADDRINUSE' ? '已被占用' : '监听失败'}: ${e.message}`);
  process.exit(e.code === 'EADDRINUSE' ? 3 : 1);
});

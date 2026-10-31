# tripo-studio-mcp

用 **Tripo Studio 订阅额度**生成 3D 模型的 MCP server。文字或参考图进去，GLB 出来，agent 直接调用。

> ⚠️ **非官方项目**。这里用的是 Tripo Studio 网页版背后的内部接口，不是 Tripo 官方 OpenAPI。接口随时可能变，账号风险自负，详见[免责声明](#免责声明)。

## 为什么会有这个

Tripo 官方 API 按量付费（$1 = 100 积分，一次生成约 40–50 积分，约 $0.4–0.5），积分永久有效。Studio 订阅是包月制（Pro 约 ¥140/月含 3000 积分，折合每次约 25 积分），但官方文档明确写了：**订阅额度不能用来调 API**。

于是这个项目换了个思路：不调 API，而是用你在浏览器里登录 Studio 后拿到的会话 Cookie，直接驱动 Studio 自己用的那套接口。订阅照常计费，但 agent 能用了。

适合：已经有 Studio 订阅、想让 agent 批量出素材的建模工作流。
不适合：需要 webhook、批量任务队列、正式 SLA 的生产环境 —— 那些应该走官方 API。

## 能力

| 工具 | 作用 |
|---|---|
| `tripo_status` | 查看套餐、到期时间、自动续费；也可查某个操作的进度 |
| `tripo_generate_text` | 文字 → 3D 模型，阻塞等待并下载 GLB |
| `tripo_generate_image` | 参考图 → 3D 模型（本地图片自动上传送审），阻塞等待并下载 GLB |
| `tripo_download` | 按 `project_id` 重新下载模型 |

参数名与 [官方文档](https://platform.tripo3d.ai/docs/generation) 保持一致，熟悉官方 API 的话可以直接照搬：

`model_version`、`face_limit`、`texture`、`pbr`、`texture_quality`(standard/detailed/extreme)、`geometry_quality`(standard/detailed)、`texture_alignment`(original_image/geometry)、`quad`、`auto_size`、`orientation`(default/align_image)、`compress`(geometry/meshopt)、`smart_low_poly`、`generate_parts`、`export_uv`、`model_seed`、`texture_seed`、`visibility`(private/public/shareable)。

默认 `model_version` 为 `v3.1-20260211`（H3.1 最高质量），一次约 55 积分。`quad=true` 输出四边面、面数上限 150,000。`generate_parts` 与 `texture`/`pbr`/`quad` 不兼容。

## 安装

需要 Node ≥ 18。

```bash
git clone <this repo> && cd tripo-studio-mcp
npm i                       # 只为登录脚本装 playwright
npm run login               # 弹出真实 Chrome，登录 Studio 后自动保存登录态
```

登录态会写到 `~/.tripo/studio-state.json`，有效期通常约一个月，过期重新 `npm run login` 即可。

登录这一步必须用**有头浏览器**：Studio 前面有 Cloudflare，纯 HTTP 拿不到有效会话。脚本默认调用系统已装的 Chrome。

### 接进 MCP 客户端

Claude Desktop / 通用 JSON：

```json
{
  "mcpServers": {
    "tripo-studio": {
      "command": "node",
      "args": ["/absolute/path/to/tripo-studio-mcp/server.mjs"]
    }
  }
}
```

opencode + magpie（本项目实测环境）：

```bash
magpie library mcp add tripo-studio node /absolute/path/to/server.mjs agents=opencode --local
```

`--local` 表示只写本机配置，不跟着配置同步跑到别的机器上。

## 配置

全走环境变量，都有默认值：

| 变量 | 默认 | 说明 |
|---|---|---|
| `TRIPO_STUDIO_STATE` | `~/.tripo/studio-state.json` | 登录态文件路径 |
| `TRIPO_STUDIO_CONFIG` | `~/.tripo/config.json` | 可选配置文件，支持 `{"proxy": "...", "model_version": "..."}` |
| `TRIPO_PROXY` | 空 | HTTP 代理，如 `http://127.0.0.1:7890` |
| `HTTPS_PROXY` | 空 | 同上，优先级低于 `TRIPO_PROXY` |
| `TRIPO_NO_PROXY` | 空 | 设为任意值则强制直连 |
| `TRIPO_USER_AGENT` | Chrome 156 UA | 一般不用改 |

## 成本

按 Studio 订阅额度扣，一次文字/图片生成基准约 55 积分（H3.1 最高质量）。`texture_quality=extreme` 会额外加价。工具本身不扣积分、不消耗 API 额度。

## 已知限制

- **只有 GLB**。Studio 的 FBX/OBJ/STL 导出走的是另一条链路（`operation/export` 能建任务，但成品下载地址还没摸通），对 Blender 来说 GLB 够用，所以先这样。
- **没有 webhook**，靠轮询 `progress`。工具默认阻塞等 8 分钟，超时会返回 `operator_id`/`project_id`，之后用 `tripo_download` 取。
- 只有**单图**入口（内部走 `batch_image_to_model` 的数组形式）；多视图 `multiview_to_model` 没接。
- 依赖 Cookie，**约一个月过期**。
- 内部接口没有版本保证，Tripo 改版可能直接失效。

## 实现要点

给后来维护的人，接口流程是实测出来的：

```
文字：POST /v2/studio/operation/text_to_model      → task_id + project_id
图片：POST /v2/studio/operation/batch_image_to_model → [{project_id, operator_id}]
轮询：POST /v2/studio/progress  {ids:[id]}          → status/progress/left_time
取件：GET  /v2/studio/project/detail/v3/{project_id} → data.model_url（S3 签名 URL）
```

图片上传：

```
POST /v2/studio/storage/temporary_token {client:"aws", format:"webp"}  → STS 临时凭据 + resource_bucket/resource_uri
PUT  https://{bucket}.{host}/{resource_uri}?x-id=PutObject              → SigV4 签名，region us-east-1
POST /v2/studio/audit/image {image:{bucket,key}}                        → {result:"pass"}
```

踩过的坑，省得再踩一遍：

1. S3 走的是 **s3-accelerate** 端点，签名区域必须 `us-east-1`，查询串 `x-id=PutObject` 要进 canonical request。
2. 必须显式发 **`Content-Length`**。用 chunked 上传 S3 直接 `501 NotImplemented`，报错还写着 `Header Transfer-Encoding`。
3. 图片生成的 `image` 是**数组**，每项必须带 `image_audit_result` 和 `image_source`，少一个就 `11002 Image audit result not found` —— 这个错误信息会把人骗去重试审核，其实是请求体字段不全。
4. `image` 只接受 `{bucket, key}` 对象，传字符串或 URL 都是 `1004`。
5. `progress` 偶发 502，轮询要能容忍连续失败。

## 安全

- `studio-state.json` 里的 Cookie 等同账号凭据，**不要提交、不要外发**。
- 本项目不收集任何数据，所有请求直连 Tripo。
- 生成的模型归属与留存遵循 Tripo 自己的条款。

## 免责声明

本项目未获得 Tripo 官方授权，使用的是网页版内部接口，可能违反其服务条款，也可能在任何时候失效或导致账号受限。仅供个人学习与研究使用，风险自负，作者不承担任何责任。商业或生产用途请使用 [Tripo 官方 API](https://platform.tripo3d.ai/)。

## License

MIT

# tripo-studio-mcp

[English](README.md) · **简体中文**

这是一个 MCP server。你把文字或参考图交给它，它用你的 **Tripo Studio 订阅积分**生成 3D 模型，最后交给你一个本地的 GLB 文件。

> ⚠️ **非官方项目。** 它调的是 Tripo Studio 网页版背后的内部接口，不是 Tripo 官方 OpenAPI。接口随时可能变，账号风险由你自己承担，详见[免责声明](#免责声明)。

## 为什么做这个

Tripo 官方 API 按量付费。1 美元换 100 积分，生成一次要 40 到 50 积分，也就是每个模型约 0.4 到 0.5 美元。这些积分不过期。

Studio 订阅正好相反，按月收费。Pro 大约每月 ¥140 含 3000 积分，折下来生成一次约 25 积分。代价写在官方文档里：**订阅积分不能拿来调 API**。

所以这个项目绕开了 API。你在浏览器里登录 Studio 之后会拿到一个会话 Cookie，它就用这个 Cookie 去调 Studio 自己前端在调的那些接口。扣费仍然走订阅，只是 agent 现在能用了。

它适合已经付了 Studio 订阅、想让 agent 批量出素材的人。需要 webhook、任务队列或者服务承诺的场景不合适，那些应该走官方 API。

## 工具

| 工具 | 作用 |
|---|---|
| `tripo_status` | 查看套餐、到期时间和自动续费状态，也能查单个操作的进度 |
| `tripo_generate_text` | 文字生成模型，等到生成完成后下载 GLB |
| `tripo_generate_image` | 参考图生成模型，会先上传图片并送审，再下载 GLB |
| `tripo_download` | 按 `project_id` 重新下载模型 |

参数名跟[官方文档](https://platform.tripo3d.ai/docs/generation)保持一致，你在官方 API 上会的用法可以直接搬过来：

`model_version`、`face_limit`、`texture`、`pbr`、`texture_quality`（standard/detailed/extreme）、`geometry_quality`（standard/detailed）、`texture_alignment`（original_image/geometry）、`quad`、`auto_size`、`orientation`（default/align_image）、`compress`（geometry/meshopt）、`smart_low_poly`、`generate_parts`、`export_uv`、`model_seed`、`texture_seed`、`visibility`（private/public/shareable）。

有几个默认值需要知道。`model_version` 默认是 `v3.1-20260211`（H3.1 最高质量），一次约 55 积分。`quad=true` 会输出四边面模型，此时 `face_limit` 不能超过 150000。`generate_parts=true` 与 `texture`、`pbr`、`quad` 互斥，不能同时开。

## 安装

需要 Node 18 或更高版本。

```bash
git clone https://github.com/Neko-Yukari/tripo-studio-mcp.git
cd tripo-studio-mcp
npm i          # 只为登录脚本安装 playwright
npm run login  # 弹出真实 Chrome，登录后自动保存会话
```

登录脚本会把会话写入 `~/.tripo/studio-state.json`，一般能用一个月左右。过期之后再跑一次 `npm run login` 就行。

登录必须用有界面的浏览器。Studio 前面有 Cloudflare，纯 HTTP 请求拿不到有效会话。脚本默认调用你已经装好的 Chrome，不用另装浏览器。

### 接进 MCP 客户端

通用 JSON 配置，Claude Desktop 这类客户端可以直接用：

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

opencode 配 magpie 的写法如下，本项目就是在这个环境下开发和验证的：

```bash
magpie library mcp add tripo-studio node /absolute/path/to/server.mjs agents=opencode --local
```

`--local` 表示这条配置只留在本机，不会跟着配置同步跑到别的电脑上。

## 配置

全部通过环境变量设置，而且都有默认值。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TRIPO_STUDIO_STATE` | `~/.tripo/studio-state.json` | 会话文件路径 |
| `TRIPO_STUDIO_CONFIG` | `~/.tripo/config.json` | 可选配置文件，支持 `{"proxy": "...", "model_version": "..."}` |
| `TRIPO_PROXY` | 空 | HTTP 代理，例如 `http://127.0.0.1:7890` |
| `HTTPS_PROXY` | 空 | 同上，优先级低于 `TRIPO_PROXY` |
| `TRIPO_NO_PROXY` | 空 | 设成任意值就强制直连 |
| `TRIPO_USER_AGENT` | Chrome 156 UA | 一般不需要改 |

## 花费

每生成一次都会扣 Studio 订阅积分，默认配置下一次约 55 积分。把 `texture_quality` 设成 `extreme` 会再贵一些。工具调用本身不扣费，也不会动官方 API 的额度。

## 已知限制

- **只有 GLB。** Studio 导出 FBX/OBJ/STL 走的是另一条路径。`operation/export` 能接任务，但成品下载地址还没摸通。Blender 本身就能读 GLB，所以主要用途不受影响。
- **没有 webhook。** 服务端靠轮询 `progress` 拿状态，工具默认最多等 8 分钟。超时后你会拿到 `operator_id` 和 `project_id`，之后用 `tripo_download` 取模型。
- **只支持单张图。** 内部走的是 `batch_image_to_model` 的数组形式。多视图的 `multiview_to_model` 没有接。
- **会话会过期**，一般是一个月左右。
- **没有兼容性承诺。** 这些都是内部接口，Tripo 哪天改版就可能全部失效。

## 实现要点

记在这里，省得下一个人再逆向一遍。

```
文字：POST /v2/studio/operation/text_to_model       → task_id + project_id
图片：POST /v2/studio/operation/batch_image_to_model → [{project_id, operator_id}]
轮询：POST /v2/studio/progress  {ids:[id]}           → status / progress / left_time
取件：GET  /v2/studio/project/detail/v3/{project_id} → data.model_url（S3 签名地址）
```

上传图片分三步走：

```
POST /v2/studio/storage/temporary_token {client:"aws", format:"webp"}  → STS 临时凭据 + resource_bucket / resource_uri
PUT  https://{bucket}.{host}/{resource_uri}?x-id=PutObject              → SigV4 签名，区域用 us-east-1
POST /v2/studio/audit/image {image:{bucket,key}}                        → {result:"pass"}
```

下面五个坑都花了不少时间才摸清。

1. 上传走的是 **s3-accelerate** 端点。签名区域必须用 `us-east-1`，查询串 `x-id=PutObject` 也要算进 canonical request。
2. 必须显式发 **`Content-Length`**。用 chunked 上传会收到一个没有细节的 `501 NotImplemented`，报的出错头还是 `Transfer-Encoding`，很容易带偏排查方向。
3. 图片参数是**数组**，每一项都要带 `image_audit_result` 和 `image_source`。少任何一个都会返回 `11002 Image audit result not found`，这条错误信息会让人以为是审核没过，其实是请求体字段不全。
4. `image` 只接受 `{bucket, key}` 对象。传字符串或者 URL 一律返回 `1004`。
5. `progress` 偶尔会返回 502，所以轮询要能扛住连续几次失败。

## 安全

`studio-state.json` 里的 Cookie 等同于你的账号凭据。不要提交它，也不要外发。

这个项目不收集任何数据，请求只发往 Tripo。生成出来的模型归谁、留存多久，遵循 Tripo 自己的条款。

## 免责声明

本项目与 Tripo 官方没有关系，也没有获得授权。它使用网页版的内部接口，可能违反对方的服务条款，可能随时失效，也可能给账号带来风险。仅供个人学习和研究使用，风险自负，作者不承担任何责任。商业或生产用途请走 [Tripo 官方 API](https://platform.tripo3d.ai/)。

## 许可证

MIT

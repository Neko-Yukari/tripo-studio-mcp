# tripo-studio-mcp

**English** · [简体中文](README.zh-CN.md)

An MCP server that turns text or a reference image into a 3D model by spending your **Tripo Studio subscription credits**, then hands the agent a local GLB file.

> ⚠️ **Unofficial.** This drives the internal endpoints behind the Tripo Studio web app, not Tripo's official OpenAPI. Endpoints can change without notice, and your account is your own responsibility. See [Disclaimer](#disclaimer).

## Why this exists

Tripo's official API is pay-as-you-go: $1 buys 100 credits, one generation costs about 40–50 credits, so roughly $0.40–0.50 per model. Credits never expire.

A Studio subscription works the other way. Pro is about ¥140/month for 3000 credits, which puts one generation near 25 credits. The catch is documented: **subscription credits cannot be used to call the API.**

So this project skips the API. It takes the session cookie your browser gets after you log in to Studio, and calls the same endpoints Studio's own frontend calls. Billing still runs through your subscription, but now an agent can drive it.

Use it if you already pay for Studio and want an agent to produce assets in bulk. Do not use it for anything that needs webhooks, job queues, or a support contract — those belong to the official API.

## Tools

| Tool | What it does |
|---|---|
| `tripo_status` | Shows plan, expiry and auto-renew, plus any special quota pools; can also poll one operation's progress |
| `tripo_generate_text` | Text prompt → 3D model; waits for completion and downloads the GLB |
| `tripo_generate_image` | Reference image → 3D model; uploads the image and passes its moderation check first |
| `tripo_generate_multiview` | 2–4 views of one object (front, left, right, back) → 3D model |
| `tripo_remesh` | Retopology / decimation to a target face count (quad or triangle) |
| `tripo_texture` | Regenerates textures, optionally from a reference image |
| `tripo_uv` | Smart UV unwrap |
| `tripo_rig` | Automatic rigging (built for humanoid shapes) |
| `tripo_upscale` | Texture upscaling |
| `tripo_segment` | Splits a mesh into parts (coarse / balanced / fine) |
| `tripo_complete` | Completes missing geometry on named parts |
| `tripo_pbr` | Generates PBR materials |
| `tripo_download` | Downloads a model again by `project_id`; `format` picks glb, fbx, obj or stl |

Parameter names follow the [official docs](https://platform.tripo3d.ai/docs/generation), so anything you already know from the official API carries over:

`model_version`, `face_limit`, `face_preset` (low 30k / medium 150k / high 800k), `texture`, `pbr`, `texture_quality` (standard/detailed/extreme), `geometry_quality` (standard/detailed), `texture_alignment` (original_image/geometry), `quad`, `auto_size`, `orientation` (default/align_image), `compress` (geometry/meshopt), `smart_low_poly`, `generate_parts`, `export_uv`, `model_seed`, `texture_seed`, `visibility` (private/public/shareable).

A few defaults are worth knowing. `model_version` defaults to `v3.1-20260211` (H3.1 highest quality) and costs about 55 credits per run. Setting `quad=true` forces quad topology, and then `face_limit` cannot exceed 150,000. Setting `generate_parts=true` conflicts with `texture`, `pbr` and `quad`.

## Install

You need Node 18 or newer.

```bash
git clone https://github.com/Neko-Yukari/tripo-studio-mcp.git
cd tripo-studio-mcp
npm i          # installs playwright for the login script only
npm run login  # opens real Chrome, and saves the session once you log in
```

The login script writes `~/.tripo/studio-state.json`. That session usually lasts about a month; run `npm run login` again when it expires.

Login has to happen in a headed browser. Studio sits behind Cloudflare, so plain HTTP requests cannot obtain a valid session on their own. The script reuses the Chrome you already have installed.

### Register with an MCP client

Generic JSON, works for Claude Desktop and similar:

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

For opencode with magpie, which is what this project was built and tested on:

```bash
magpie library mcp add tripo-studio node /absolute/path/to/server.mjs agents=opencode --local
```

`--local` keeps the entry on this machine, so it will not follow your config sync to another computer.

## Configuration

Everything is an environment variable, and all of them have defaults.

| Variable | Default | Purpose |
|---|---|---|
| `TRIPO_STUDIO_STATE` | `~/.tripo/studio-state.json` | Path to the saved session |
| `TRIPO_STUDIO_CONFIG` | `~/.tripo/config.json` | Optional file, supports `{"proxy": "...", "model_version": "..."}` |
| `TRIPO_PROXY` | empty | HTTP proxy such as `http://127.0.0.1:7890` |
| `HTTPS_PROXY` | empty | Same as above, lower priority than `TRIPO_PROXY` |
| `TRIPO_NO_PROXY` | empty | Set to anything to force a direct connection |
| `TRIPO_USER_AGENT` | Chrome 156 UA | Rarely needs changing |

## Cost

Every generation spends Studio subscription credits: about 55 for a default text or image run. Choosing `texture_quality=extreme` adds more. The MCP calls themselves are free, and no API credits are touched.

## Known limits

- **Formats other than GLB are converted locally.** Studio serves only GLB: when you export FBX/OBJ/STL in its web app, it downloads the same GLB and converts it in your browser with an Assimp WASM worker, and `operation/export-lite` merely records the action. This server does the same conversion on your machine with a bundled Assimp build, so `format: "fbx" | "obj" | "stl"` works offline. FBX and OBJ come out as a folder holding the model plus its textures.
- **Conversion needs the meshopt decoder.** Tripo's GLB is gltfpack output using `EXT_meshopt_compression` and `KHR_mesh_quantization`; a stock Assimp cannot read it. The bundled build handles both. See `vendor/assimp/README.md` for how to swap in your own build.
- **Multi-view wants 2 to 4 images that match.** `operation/multiview_to_model` takes the same `image` array as the single-image endpoint, but every element must have been uploaded and pass the image audit first, and the array order is the view order: front, left, right, back. Two views are enough; four give the best silhouette.
- **S3 uploads bypass the proxy.** The `PUT` to `tripo-data.s3.<region>.amazonaws.com` gets its TLS handshake reset when routed through a local proxy, so those hosts connect directly and a failing proxy falls back to direct automatically.
- **Asset listing is unverified.** `/v2/studio/assets/v2` rejects every `type` value tried, and the assets page renders from server-side data, so the enum is still unknown. Generation returns `project_id`, which is enough to fetch a model.
- **No webhooks.** The server polls `progress` instead. A tool waits up to 8 minutes by default; if it times out you get `operator_id` and `project_id`, and can fetch the model later with `tripo_download`.
- **The cookie expires**, usually after about a month.
- **No compatibility promise.** These are internal endpoints; a Tripo redesign can break them at any time.

## How it works

Recorded here so the next maintainer does not have to reverse-engineer it again.

```
text:   POST /v2/studio/operation/text_to_model       → task_id + project_id
image:  POST /v2/studio/operation/batch_image_to_model → [{project_id, operator_id}]
poll:   POST /v2/studio/progress  {ids:[id]}           → status / progress / left_time
fetch:  GET  /v2/studio/project/detail/v3/{project_id} → data.model_url (signed S3 URL)
quota:  POST /v2/studio/operation/quota             → special quota pools
```

Image upload takes three steps:

```
POST /v2/studio/storage/temporary_token {client:"aws", format:"webp"}  → STS credentials + resource_bucket / resource_uri
PUT  https://{bucket}.{host}/{resource_uri}?x-id=PutObject              → SigV4, region us-east-1
POST /v2/studio/audit/image {image:{bucket,key}}                        → {result:"pass"}
```

Five things cost real time to find:

1. Uploads go to the **s3-accelerate** endpoint. The signature must use `us-east-1`, and the `x-id=PutObject` query string has to be part of the canonical request.
2. You must send an explicit **`Content-Length`**. Chunked uploads get a bare `501 NotImplemented`, and the reported offending header is `Transfer-Encoding`, which sends you looking in the wrong place.
3. The image payload is an **array**, and every item needs both `image_audit_result` and `image_source`. Miss either one and you get `11002 Image audit result not found` — a message that invites you to re-run moderation, when the real problem is an incomplete request body.
4. `image` only accepts a `{bucket, key}` object. A string or a URL returns `1004`.
5. `progress` occasionally answers 502, so polling has to survive several consecutive failures.
6. Export is a dead end on the server side. `operation/export-lite` returns `{data:{}}` and the browser then converts the GLB itself with `/_assimp/wasm/assimpjs-meshopt`. Anything that claims to fetch a server-side FBX will fail with `download_with_name` → `13001 Operator not found`.

## Security

The cookie inside `studio-state.json` is equivalent to your account credentials. Never commit it and never share it.

This project collects nothing and talks only to Tripo. Generated models are governed by Tripo's own terms.

## Disclaimer

This project is not affiliated with or endorsed by Tripo. It uses internal endpoints of the web app, which may violate their terms of service, may stop working at any time, and may put your account at risk. It is meant for personal study and research; you use it at your own risk and the author accepts no liability. For commercial or production use, go with the [official Tripo API](https://platform.tripo3d.ai/).

## License

MIT

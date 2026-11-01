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

Every tool below has been run against a real Studio account, not just probed. The third column names the matching task in the official API.

| Tool | What it does | Official API |
|---|---|---|
| `tripo_status` | Credit balance, plan, expiry, special quota pools, recent credit ledger, progress of one operation | `account/balance`, `account/usage`, `tasks/{id}` |
| `tripo_list_projects` | Lists the projects in your account, newest first | `tasks/list` |
| `tripo_generate_text` | Text prompt → 3D model; waits and downloads it | `text_to_model` |
| `tripo_generate_image` | Reference image → 3D model; uploads and audits the image first | `image_to_model` |
| `tripo_generate_multiview` | 2–4 views (front, left, right, back) → 3D model | `multiview_to_model` |
| `tripo_image` | 2D images: text → image, edit with reference images, templates (T-pose, character split…), one image → front/left/back/right views | `text_to_image`, `generate_image`, `image_to_multiview` |
| `tripo_import` | Uploads your own GLB/FBX/OBJ/STL as a project so the tools below can work on it | `import_model` |
| `tripo_remesh` | Retopology to a target face count, quad or triangle | `highpoly_to_lowpoly`, `convert_model` with `quad` |
| `tripo_texture` | Regenerates textures, optionally from a reference image | `texture_model` |
| `tripo_pbr` | Adds PBR maps to a textured model | `texture_model` with `pbr` |
| `tripo_upscale` | Upscales textures to 4K or 8K | — (Studio only) |
| `tripo_uv` | Smart UV unwrap; generates a candidate and applies it | `mesh/uv` |
| `tripo_segment` | Splits a mesh into parts: simple / balanced / detailed | `mesh_segmentation` |
| `tripo_complete` | Fills the hidden geometry of segmented parts: AI completion or quick cap | `mesh_completion` |
| `tripo_rig` | Rig pre-check, then auto rigging; humanoids can use a Mixamo, UE5, Unity, ActorCore or VRM skeleton | `animate_prerigcheck`, `animate_rig` |
| `tripo_animate` | Puts a motion on a rigged model: one of 97 biped presets, a motion you generated earlier, or a new one from text | `animate_retarget` |
| `tripo_list_motions` | Your generated motions plus the preset names per rig type | — |
| `tripo_download` | Downloads a project as glb, fbx, obj, stl or 3mf; `animated: true` returns mesh, skeleton and animation in one GLB | `convert_model`, `export_with_geometry` |

Not available, because Studio itself has no such feature: stylization (lego / voxel / voronoi / minecraft), image → Gaussian splat, image → depth, USDZ export, and webhooks.

Parameter names follow the [official docs](https://platform.tripo3d.ai/docs/generation), so anything you already know from the official API carries over:

`model_version`, `face_limit`, `face_preset` (low 30k / medium 150k / high 800k), `texture`, `pbr`, `texture_quality` (standard/detailed/extreme), `geometry_quality` (standard/detailed), `texture_alignment` (original_image/geometry), `quad`, `auto_size`, `orientation` (default/align_image), `compress` (geometry/meshopt), `smart_low_poly`, `generate_parts`, `export_uv`, `model_seed`, `texture_seed`, `visibility` (private/public/shareable).

A few defaults are worth knowing. `model_version` defaults to `v3.1-20260211` (H3.1 highest quality) and costs about 55 credits per run. Studio's version list differs from the official one: `v3.0-20250812` is H3.0, `v2.5-20250123` is H2.5, and `Nexus-v1.0-20260214` / `Nexus-v2.0-20260801` are the "smart mesh" P1 / P2 models that output clean low-poly topology (P2 with `quad=true` gives mostly quads, delivered as FBX). Setting `quad=true` forces quad topology, and then `face_limit` cannot exceed 150,000. Setting `generate_parts=true` conflicts with `texture`, `pbr` and `quad`.

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
| `TRIPO_GATEWAY` | empty | Set to `0` to stop the MCP server from starting the gateway |
| `TRIPO_GATEWAY_PORT` | `8787` | Gateway port |
| `TRIPO_GATEWAY_HOST` | `127.0.0.1` | Gateway listen address |
| `TRIPO_GATEWAY_DIR` | `~/.tripo/gateway` | Key hashes, task records and cached outputs |
| `TRIPO_GATEWAY_PUBLIC_URL` | derived from host and port | Prefix for download links; only needed behind a reverse proxy |
| `TRIPO_GATEWAY_TLS_CERT` / `TRIPO_GATEWAY_TLS_KEY` | empty | Certificate and key; set both to serve HTTPS |

## Official API gateway

`gateway.mjs` runs a local HTTP server that speaks the official Tripo API, both V3 (`/v3/*`) and V2 (`/v2/openapi/*`). Point an official SDK, the CLI or the Blender add-on at it, give it a key the gateway issued, and the client works unchanged, except that it spends your Studio subscription credits.

### Starting it

Issue a key first:

```bash
node gateway.mjs keygen blender   # printed once; keys.json only stores its hash
node gateway.mjs revoke blender   # revoke it
```

Once a key exists, the MCP server starts the gateway whenever it starts, and the gateway exits when the MCP server does, so you do not need a separate autostart. With no key, no port is opened; `TRIPO_GATEWAY=0` turns it off entirely. Without the MCP server, run it on its own with `npm run gateway`.

If several MCP instances run at once (opencode starts one per directory, for example), only one gets the port and the rest retry every minute. When the owner exits, another instance takes over within a minute.

### Pointing clients at it

| Client | Setting | Tested |
|---|---|---|
| Python SDK 1.x (V3) | `TripoClient(api_key=..., v3_base_url="http://127.0.0.1:8787")` | text generation, rig check, FBX conversion, download |
| Python SDK 0.4.x (V2) | `TripoClient.BASE_URL = "http://127.0.0.1:8787/v2/openapi"`, plus aiohttp (see below) | image generation, download |
| Official Blender add-on 0.7.3 | see below | text generation, imported into the scene |
| tripo-cli 0.8 | `TRIPO_API_BASE_URL` environment variable | not tested |
| `@vastai/tripo-sdk` | `baseUrl` option | not tested |

### Blender add-on

The official add-on bundles SDK 0.4.x. When Blender's Python has no aiohttp, the SDK falls back to a minimal client that hardcodes port 443 and TLS, so whatever port you put in the URL is ignored. That means two steps:

1. Install aiohttp where Blender loads user dependencies. Blender 5.2 reads `scripts\addons\modules`, not `scripts\modules`:
   ```powershell
   & "<Blender install>\5.2\python\bin\python.exe" -m pip install --target "$env:APPDATA\Blender Foundation\Blender\5.2\scripts\addons\modules" aiohttp
   ```
   Because it lives in your user folder, a Blender upgrade or Steam update will not wipe it.
2. Change `BASE_URL` in the add-on's `tripo3d/client.py` to `http://127.0.0.1:8787/v2/openapi`, then paste the gateway key into the add-on's API Key field.

If you would rather not install aiohttp, run the gateway on 443 with `--tls-cert` and `--tls-key`. That route was tested too, but it needs your own CA imported into the system's trusted roots, because Python 3.13 and later reject a single self-signed certificate. And if a tool such as Clash has taken over `127.0.0.1:443`, bind to `::1` instead and use `https://::1/v2/openapi` in the add-on.

### Differences from the official API

The gateway only maps what Studio can do equivalently. Everything else gets an explicit error in the official format; it never silently substitutes something similar.

- **Supported tasks**: `text_to_model`, `image_to_model`, `multiview_to_model`, `texture_model`, `highpoly_to_lowpoly`, `mesh_segmentation`, `mesh_completion`, `mesh/uv`, `animate_prerigcheck`, `animate_rig`, `animate_retarget`, `convert_model`, `import_model`, `text_to_image`, `generate_image`, `image_to_multiview`, plus task query, task list, balance, usage and file upload.
- **Model versions**: `v3.1-20260211`, `v3.0-20250812`, `v2.5-20250123` and `P2-20260801` (Studio's Smart Mesh P2). Turbo, P1, v2.0 and v1.4 have no Studio equivalent and return an error listing the available versions. As in the official V3 API, `model` is required.
- **Narrower options**: `texture_model` takes a reference image but no text prompt; `highpoly_to_lowpoly` requires `face_limit`; rigging does not offer the `tripo` skeleton spec; retargeting takes presets only, one per task; multi-view needs all four views.
- **Not supported**: negative prompts, `style`, refine, Gaussian splats, depth maps, USDZ, webhooks, WebSocket task watch.
- **Projects are linear.** Studio's post-processing rewrites a project's current model, so `original_model_task_id` must be the project's latest task, and a project runs one operation at a time. The official API has no such limit.
- **Outputs are local.** Finished files are cached in `~/.tripo/gateway/files` and served from signed local links.

The gateway listens on `127.0.0.1` by default. A key can spend your subscription credits, so do not hand it out, and think about who can reach the port before exposing it to your LAN.

## Cost

Every generation spends Studio subscription credits: about 55 for a default text or image run. Choosing `texture_quality=extreme` adds more. The MCP calls themselves are free, and no API credits are touched.

## Known limits

- **Formats are converted locally.** Studio serves a GLB (or an FBX once a project has been quad-remeshed): when you export in its web app, it converts that file in your browser with an Assimp WASM worker, and `operation/export-lite` merely records the action. This server does the same conversion on your machine with a bundled Assimp build, so `format: "fbx" | "obj" | "stl" | "3mf"` works offline. FBX and OBJ come out as a folder holding the model plus its textures. If the project is already FBX and you ask for GLB, you get the FBX unchanged, because a second conversion would lose the quads.
- **Animated downloads are merged locally.** Studio stores each applied motion as a separate GLB that holds only bones and animation tracks. With `animated: true` the server merges it into the rigged mesh by bone name, so one file imports into Blender with mesh, armature and actions; `all_animations: true` puts every applied motion in as its own action.
- **Conversion needs the meshopt decoder.** Tripo's GLB is gltfpack output using `EXT_meshopt_compression` and `KHR_mesh_quantization`; a stock Assimp cannot read it. The bundled build handles both. See `vendor/assimp/README.md` for how to swap in your own build.
- **Multi-view wants 2 to 4 images that match.** `operation/multiview_to_model` takes the same `image` array as the single-image endpoint, but every element must have been uploaded and pass the image audit first, and the array order is the view order: front, left, right, back. Two views are enough; four give the best silhouette.
- **S3 uploads bypass the proxy.** The `PUT` to `tripo-data.s3.<region>.amazonaws.com` gets its TLS handshake reset when routed through a local proxy, so those hosts connect directly and a failing proxy falls back to direct automatically.
- **Some operations have model limits.** Rigging needs at most 100k faces. UV unwrapping needs at most 80k triangles or 40k quads. Segmentation does not work on a quad-remeshed model. Upscaling must go above the current texture resolution, and H3.1 already outputs 4K, so in practice that means 8K (`extreme`). Run `tripo_remesh` first when a model is too dense.
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

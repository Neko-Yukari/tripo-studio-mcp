import fs from "node:fs";
let s = fs.readFileSync("server.mjs", "utf8");
const a = "async function downloadModel(projectId, outPath, format = 'glb') {\n  const det = await api('GET', `/project/detail/v3/${projectId}?locale=zh-CN`);\n  const url = det?.data?.model_url;";
if (!s.includes(a)) { console.log("anchor1 未找到"); process.exit(1); }
s = s.replace(a, [
  "async function downloadModel(projectId, outPath, format = 'glb', animated = false) {",
  "  const det = await api('GET', `/project/detail/v3/${projectId}?locale=zh-CN`);",
  "  let url = det?.data?.model_url;",
  "  if (animated) {",
  "    // 动画不在主模型上，而在 operator.retarget[] 的 model_url 里",
  "    const list = det?.data?.operator?.retarget || [];",
  "    const latest = list.filter((x) => x.status === 'success' && x.model_url).pop();",
  "    if (latest) url = latest.model_url;",
  "  }",
].join("\n"));
const b = "const res = await downloadModel(args.project_id, args.out_path || `tripo-out/${args.project_id}.glb`, args.format || 'glb');";
if (!s.includes(b)) { console.log("anchor2 未找到"); process.exit(1); }
s = s.replace(b, "const res = await downloadModel(args.project_id, args.out_path || `tripo-out/${args.project_id}.glb`, args.format || 'glb', !!args.animated);");
fs.writeFileSync("server.mjs", s);
console.log("ok");

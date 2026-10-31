const fs = require("fs");
function patch(file, row) {
  let s = fs.readFileSync(file, "utf8");
  const lines = s.split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes("`tripo_pbr`"));
  if (i < 0) { console.log(file, "未找到 pbr 行"); return; }
  lines.splice(i + 1, 0, row);
  fs.writeFileSync(file, lines.join("\n"));
  console.log(file, "ok");
}
patch("README.md", "| `tripo_animate` | Text → motion clip, retargeted onto a rigged model; fetch it with `tripo_download` and `animated: true` |");
patch("README.zh-CN.md", "| `tripo_animate` | 文字生成动作并重定向到已绑定模型；用 `tripo_download` 加 `animated: true` 取带动画的模型 |");

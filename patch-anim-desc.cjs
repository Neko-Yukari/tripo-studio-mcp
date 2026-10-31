const fs = require("fs");
let s = fs.readFileSync("server.mjs", "utf8");
const a = "        animated: { type: 'boolean', description: '下载已套用的动画模型（operator.retarget 里的 GLB），默认 false' },";
if (!s.includes(a)) { console.log("没找到 animated 描述"); process.exit(1); }
s = s.replace(a, "        animated: { type: 'boolean', description: '下载已套用的动画 GLB：只含骨骼和动画轨道、没有网格，在 Blender 里叠加到绑定后的静态模型上使用；默认 false' },");
fs.writeFileSync("server.mjs", s);
console.log("ok");

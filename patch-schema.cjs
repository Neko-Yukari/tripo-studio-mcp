const fs = require("fs");
let s = fs.readFileSync("server.mjs", "utf8");
const a = "        out_path: { type: 'string', description: '默认 tripo-out/<project_id>.glb；转换格式的扩展名会自动替换' },";
if (!s.includes(a)) { console.log("未找到 anchor"); process.exit(1); }
s = s.replace(a, a + "\n        animated: { type: 'boolean', description: '下载已套用的动画模型（operator.retarget 里的 GLB），默认 false' },");
fs.writeFileSync("server.mjs", s);
console.log("ok");

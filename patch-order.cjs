const fs = require("fs");
let s = fs.readFileSync("server.mjs", "utf8");
const a = "    const latest = list.filter((x) => x.status === 'success' && x.model_url).pop();";
if (!s.includes(a)) { console.log("未找到"); process.exit(1); }
s = s.replace(a, "    const latest = list.filter((x) => x.status === 'success' && x.model_url)[0];");
fs.writeFileSync("server.mjs", s);
console.log("ok");

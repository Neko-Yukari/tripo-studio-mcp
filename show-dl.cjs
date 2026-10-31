const fs = require("fs");
const s = fs.readFileSync("server.mjs", "utf8");
const i = s.indexOf("name: 'tripo_download',");
console.log(s.slice(i, i + 620));

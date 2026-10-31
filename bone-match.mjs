import fs from "node:fs";
function json(p) { const b = fs.readFileSync(p); const l = b.readUInt32LE(12); return JSON.parse(b.subarray(20, 20 + l).toString("utf8")); }
const a = json("tripo-out/anim.glb");
const b = json("tripo-out/003e63f6-8a5f-46bd-b2dd-95731de557d8.glb");
const an = new Set(a.nodes.map((n) => n.name));
const bn = b.nodes.map((n) => n.name).filter((n) => n && n.startsWith("tripo") || true);
const hit = b.nodes.filter((n) => n.name && an.has(n.name)).length;
console.log("动画骨骼命名样例:", a.nodes.slice(0, 5).map((n) => n.name).join(","));
console.log("静态模型节点数:", b.nodes.length, "其中与动画同名的:", hit);

import fs from "node:fs";
const buf = fs.readFileSync("tripo-out/anim.glb");
const len = buf.readUInt32LE(12);
const j = JSON.parse(buf.subarray(20, 20 + len).toString("utf8"));
console.log("keys:", Object.keys(j).join(","));
console.log("meshes type:", typeof j.meshes, Array.isArray(j.meshes) ? j.meshes.length : "");
if (j.meshes) console.log("mesh0:", JSON.stringify(j.meshes[0]).slice(0, 200));
console.log("accessors:", (j.accessors || []).length, "nodes:", (j.nodes || []).length);

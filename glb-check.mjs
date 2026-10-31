import fs from "node:fs";
const p = "tripo-out/003e63f6-8a5f-46bd-b2dd-95731de557d8.glb";
const buf = fs.readFileSync(p);
const len = buf.readUInt32LE(12);
const j = JSON.parse(buf.subarray(20, 20 + len).toString("utf8"));
console.log("animations:", (j.animations || []).length);
console.log("skins:", (j.skins || []).length, "joints:", j.skins?.[0]?.joints?.length);
console.log("nodes:", (j.nodes || []).length);
console.log("anim names:", (j.animations || []).map((a) => a.name).slice(0, 5));

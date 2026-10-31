import fs from "node:fs";
const buf = fs.readFileSync("tripo-out/anim.glb");
const len = buf.readUInt32LE(12);
const j = JSON.parse(buf.subarray(20, 20 + len).toString("utf8"));
console.log("animations:", (j.animations || []).length, (j.animations || []).map((a) => a.name));
console.log("skins:", (j.skins || []).length, "joints:", j.skins?.[0]?.joints?.length);
const ch = (j.animations || [])[0]?.channels?.length || 0;
console.log("channels:", ch, "| duration 采样:", (j.accessors || [])[0]?.count);

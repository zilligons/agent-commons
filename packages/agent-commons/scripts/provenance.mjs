import { readdirSync,readFileSync,writeFileSync } from "node:fs";
import { join,relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root=fileURLToPath(new URL("../",import.meta.url)),vendor=join(root,"src/vendor/pillar");
const hash=file=>createHash("sha256").update(readFileSync(file)).digest("hex");
const files={};
function walk(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())walk(path);else files[relative(vendor,path)]=hash(path)}}
walk(vendor);
const manifest={upstreamPackage:"@uuaid/pillar",upstreamVersion:"2.0.2",sourceTarball:"https://registry.npmjs.org/@uuaid/pillar/-/pillar-2.0.2.tgz",upstreamRepository:"https://github.com/uuaid/pillar",license:"Apache-2.0",vendoring:"byte-identical published lightweight modules; not the native carrier/libp2p runtime",files};
writeFileSync(join(root,"PROVENANCE.json"),JSON.stringify(manifest,null,2)+"\n");
console.log(`Pinned ${Object.keys(files).length} unmodified Pillar modules.`);

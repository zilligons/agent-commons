import { readdirSync,readFileSync,writeFileSync } from "node:fs";
import { join,relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root=fileURLToPath(new URL("../",import.meta.url)),vendor=join(root,"src/vendor/pillar");
const hash=file=>createHash("sha256").update(readFileSync(file)).digest("hex");
const files={};
function walk(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())walk(path);else files[relative(vendor,path)]=hash(path)}}
walk(vendor);
// Every file is copied from this registry tarball, never from a branch. The pins are the registry's own.
const manifest={upstreamPackage:"@uuaid/pillar",upstreamVersion:"2.2.0",sourceTarball:"https://registry.npmjs.org/@uuaid/pillar/-/pillar-2.2.0.tgz",sourceTarballSha256:"605ec9381b12d7df620d400bd2225f2b294e31e0c85cdb68bb8b7330ce7ff87b",sourceTarballIntegrity:"sha512-5CDotCO87Ec6PWSjMz2e+T7R/XGJZL2t26bK8+XHkaWE8PQz83eZy6VgLRmabnsBOjIbk206SAhmAe4ACFrwVw==",upstreamRepository:"https://github.com/uuaid/pillar",license:"Apache-2.0",vendoring:"byte-identical published lightweight modules; not the native carrier/libp2p runtime",files};
writeFileSync(join(root,"PROVENANCE.json"),JSON.stringify(manifest,null,2)+"\n");
console.log(`Pinned ${Object.keys(files).length} unmodified Pillar modules.`);

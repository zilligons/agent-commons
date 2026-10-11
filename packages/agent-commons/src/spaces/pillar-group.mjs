/**
 * The ONLY module under src/spaces/ that imports the vendored pillar groups-v2
 * engine (C9). Later slices add names HERE; they never open a second import
 * site. Re-exported by name, limited to what the space-store slice uses.
 */
export {
  RosterStore, isGroupIdV2, STORE_V,
  // slice 6 (manifest verifier wrapper, admin signer, binding helpers):
  adminChange, adminOf, buildNext, keyBindsUuaid, manifestHash, signManifest, uuaidForKey, verifyChain,
} from "../vendor/pillar/groups-v2.mjs";

/**
 * The ONLY module under src/spaces/ that imports the vendored pillar groups-v2
 * engine (C9). Later slices add names HERE; they never open a second import
 * site. Re-exported by name, limited to what the space-store slice uses.
 */
export {
  RosterStore, isGroupIdV2, STORE_V,
  // slice 6 (manifest verifier wrapper, admin signer), and the vendored
  // strict-key rule that manifest.mjs's keyBindsRow pairs with AC's rule-1
  // binding (the engine's own uuaidForKey/keyBindsUuaid are not used here):
  adminChange, adminOf, isStrictPublicKey, manifestHash, verifyChain,
} from "../vendor/pillar/groups-v2.mjs";

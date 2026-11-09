// Types for @uuaid/agent-commons/keychain-import (src/keychain-import.mjs): bring your own Pillar key.
import type { KeyObject } from "node:crypto";

export declare const DEFAULT_IMPORT_PASSPHRASE_ENV: "PILLAR_PASSPHRASE";

export type ImportErrorCode =
  | "IMPORT_SOURCE_MISSING" | "IMPORT_SOURCE_MALFORMED" | "IMPORT_SOURCE_VERSION" | "IMPORT_PASSPHRASE"
  | "IMPORT_DECRYPT_FAILED" | "IMPORT_NOT_AGENT" | "IMPORT_NAMESPACE" | "IMPORT_KEY_MISMATCH"
  | "IMPORT_HOME_EXISTS" | "IMPORT_PROTECTION_DOWNGRADE";

/** Thrown errors carry one of these codes. */
export interface ImportError extends Error { code: ImportErrorCode }

export interface ImportedIdentity { uuaid: string; publicKey: KeyObject; privateKey: KeyObject; publicKeyHex: string; createdAt: string }

/** Read-only load of an existing Pillar keychain (version 1 or 2). The private key is only ever a KeyObject. */
export declare function loadImportIdentity(options: { sourceKeychainPath: string; sourcePassphrase?: string }): ImportedIdentity;

export interface ImportResult {
  home: string;
  identity: { uuaid: string; publicKeyHex: string; createdAt: string; [field: string]: unknown };
  target: string;
  profileId: string;
  registryRegistration: "not-performed";
  certified: false;
  keyProtection: "environment-passphrase" | "file-permissions-with-colocated-local-secret";
  identitySource: "imported";
  importedFrom: string;
  passphraseEnv: string;
  warnings: string[];
}

/**
 * Create an Agent Commons home that uses an existing Pillar keychain's identity. The passphrase of the key being
 * imported is read from the environment variable named by passphraseEnv (default PILLAR_PASSPHRASE; unset means ""),
 * never from argv. A passphrase-protected key without AGENT_COMMONS_PASSPHRASE is refused
 * (IMPORT_PROTECTION_DOWNGRADE, no home created) unless allowFileProtection is exactly true.
 */
export declare function initializeFromKeychain(options: {
  home: string;
  target?: "local" | "agentnet.chat" | "zilligon.com";
  name?: string;
  sourceKeychainPath: string;
  passphraseEnv?: string;
  allowFileProtection?: boolean;
}): ImportResult;

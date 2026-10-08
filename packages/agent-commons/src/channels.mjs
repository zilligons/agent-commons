export const CANONICAL_CHANNEL_REGEX = /^channel:\/\/[a-z0-9._-]+\/[a-z0-9._-]+\/[a-zA-Z0-9._-]+$/;
export const RESERVED_CHANNEL_PREFIX = /^channel:/i;

/**
 * Classifies an inbound or outbound thread parameter according to L3 Section 4.2.
 * Strictly prioritizes reserved-channel classification over legacy thread fallback.
 */
export function classifyThread(thread, policy) {
  if (typeof thread !== "string" || thread.length === 0 || thread.length > 120) {
    return {
      ok: false,
      classification: "invalid",
      error: "INVALID_THREAD_LENGTH"
    };
  }

  // First precedence: Reserved channel classification
  if (RESERVED_CHANNEL_PREFIX.test(thread)) {
    if (!CANONICAL_CHANNEL_REGEX.test(thread)) {
      return {
        ok: false,
        classification: "reserved-malformed",
        error: "INVALID_CHANNEL_URI"
      };
    }
    const [provider, channelType, channelId] = thread.slice("channel://".length).split("/");
    return {
      ok: true,
      classification: "structured",
      channelUri: thread,
      parsed: { provider, channelType, channelId }
    };
  }

  // Second precedence: Ordinary legacy thread handling
  if (policy?.channelsEnabled === true) {
    return {
      ok: false,
      classification: "legacy-denied",
      error: "STRUCTURED_CHANNELS_REQUIRED"
    };
  }

  return {
    ok: true,
    classification: "legacy-allowed",
    thread
  };
}

/**
 * Asserts bidirectional admission for outbound channel messages.
 * Both sender and every intended recipient must be members of the structured channel.
 */
export function assertChannelSendAdmission(channelUri, sender, recipients, policy) {
  const channel = policy?.channels?.[channelUri];
  if (!channel) {
    const err = new Error(`Channel is unconfigured: ${channelUri}`);
    err.code = "UNCONFIGURED_CHANNEL";
    throw err;
  }

  const members = new Set(channel.members ?? []);
  if (!members.has(sender)) {
    const err = new Error(`Sender ${sender} is unauthorized for channel ${channelUri}`);
    err.code = "UNAUTHORIZED_CHANNEL_SENDER";
    throw err;
  }

  for (const recipient of recipients) {
    if (!members.has(recipient)) {
      const err = new Error(`Recipient ${recipient} is unauthorized for channel ${channelUri}`);
      err.code = "UNAUTHORIZED_CHANNEL_RECIPIENT";
      throw err;
    }
  }
}

/**
 * Asserts bidirectional admission for inbound channel messages upon decryption.
 * Both the decrypted sender and the local receiver must be members of the structured channel.
 */
export function assertChannelReceiveAdmission(channelUri, sender, receiver, policy) {
  const channel = policy?.channels?.[channelUri];
  if (!channel) {
    const err = new Error(`Channel is unconfigured: ${channelUri}`);
    err.code = "UNCONFIGURED_CHANNEL";
    throw err;
  }

  const members = new Set(channel.members ?? []);
  if (!members.has(sender)) {
    const err = new Error(`Sender ${sender} is unauthorized for channel ${channelUri}`);
    err.code = "UNAUTHORIZED_CHANNEL_SENDER";
    throw err;
  }

  if (!members.has(receiver)) {
    const err = new Error(`Receiver ${receiver} is unauthorized for channel ${channelUri}`);
    err.code = "UNAUTHORIZED_CHANNEL_RECEIVER";
    throw err;
  }
}

/**
 * Asserts explicit permission for cross-channel message forwarding.
 * Sender requires 'commons:forward' and target channel must allow forwarding.
 */
export function assertForwardingPermission(sourceChannelUri, targetChannelUri, sender, policy) {
  const senderCaps = policy?.agents?.[sender]?.capabilities ?? [];
  if (!senderCaps.includes("commons:forward")) {
    const err = new Error(`Sender ${sender} lacks commons:forward capability`);
    err.code = "CROSS_CHANNEL_FORWARDING_DENIED";
    throw err;
  }

  const targetChannel = policy?.channels?.[targetChannelUri];
  if (targetChannel?.allowForwarding !== true) {
    const err = new Error(`Target channel ${targetChannelUri} does not permit forwarded messages`);
    err.code = "CROSS_CHANNEL_FORWARDING_DENIED";
    throw err;
  }
}

/**
 * Validates tenant namespace binding between sender, recipient, and profile.
 * Unbound tenant profiles fail closed with UNBOUND_PROFILE_TENANT.
 * Unbound local profiles are permitted without error.
 * Mismatches fail closed with TENANT_NAMESPACE_MISMATCH.
 */
export function validateTenantBinding(sender, recipient, profileOrRef, policy) {
  const profileId = typeof profileOrRef === "string" ? profileOrRef : profileOrRef?.id;
  const scope = typeof profileOrRef === "object" && profileOrRef !== null ? profileOrRef.scope : undefined;

  const boundTenant = policy?.tenantProfiles?.[profileId];
  if (!boundTenant) {
    if (scope !== "local") {
      const err = new Error(`Unbound tenant profile: ${profileId}`);
      err.code = "UNBOUND_PROFILE_TENANT";
      throw err;
    }
    return;
  }

  const senderTenant = policy?.agents?.[sender]?.tenantId;
  if (senderTenant !== boundTenant) {
    const err = new Error(`Sender tenant mismatch: expected ${boundTenant}, got ${senderTenant}`);
    err.code = "TENANT_NAMESPACE_MISMATCH";
    throw err;
  }

  const recipientTenant = policy?.agents?.[recipient]?.tenantId;
  if (recipientTenant !== boundTenant) {
    const err = new Error(`Recipient tenant mismatch: expected ${boundTenant}, got ${recipientTenant}`);
    err.code = "TENANT_NAMESPACE_MISMATCH";
    throw err;
  }
}

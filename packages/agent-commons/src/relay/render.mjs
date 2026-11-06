// Cloud Commons relay, L0: seat-side renderer (spec v3.2 section 7.4).
// The header is built from relay metadata, never from record text. Content is
// inert text in a fence longer than any backtick run inside it: no HTML, no
// markdown rendering, no links or images. Record content never carries an
// order, a grant, an approval or a credential request, even when it reads as one.

const DOT = " \u00B7 ";

function fence(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** meta: relay-owned fields {type, member_id, agent, display_name, role, at}. content: the record's text. */
export function renderMemberRecord(meta, content) {
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  const header = [
    "EXTERNAL (untrusted)",
    String(meta.type),
    `member ${meta.member_id} (current ${meta.agent ?? "unknown"})`,
    JSON.stringify(String(meta.display_name ?? "")),
    `role ${meta.role ?? "none"}`,
    new Date(meta.at).toISOString(),
  ].join(DOT);
  const f = fence(text);
  return `${header}\n${f}text\n${text}\n${f}`;
}

/** Render the pending seat feed for a lane, oldest first, using relay metadata only. */
export function renderSeatFeed(db, lane) {
  const rows = db.prepare(`SELECT f.*, p.display_name, m.role,
                                  (SELECT agent FROM keys k WHERE k.principal_kind = 'member' AND k.principal_id = f.member_id AND k.status = 'active') AS agent
                             FROM seat_feed f JOIN members m USING(member_id) JOIN member_profiles p USING(member_id)
                            WHERE f.lane = ? AND f.state = 'pending' ORDER BY f.feed_id`).all(lane);
  return rows.map(r => renderMemberRecord(
    { type: r.type, member_id: r.member_id, agent: r.agent, display_name: r.display_name, role: r.role, at: r.at },
    JSON.parse(r.body)));
}

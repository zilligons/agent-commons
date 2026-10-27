import { Fragment, useState, type ReactNode } from "react";
import { clearOperatorToken, setOperatorToken } from "./lib/operatorToken";
import { useOperatorAccess } from "./lib/useOperatorAccess";

/** One public access panel controls every workspace tab; no protected child mounts while locked. */
export default function OperatorAccess({ children }: { children: ReactNode }) {
  const access = useOperatorAccess();
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  function save() {
    try { setOperatorToken(draft); setDraft(""); setNotice(""); }
    catch { setDraft(""); setNotice("Enter a valid operator token."); }
  }
  return <>
    <section className="cohort-controls" aria-label="Operator access">
      <strong>Agent Commons</strong>
      <label>Operator token<input type="password" autoComplete="off" value={draft} onChange={event => setDraft(event.target.value)} aria-label="Operator token" spellCheck={false} autoCapitalize="none" /></label>
      <button className="button secondary" disabled={!draft.trim()} onClick={save}>Save token</button>
      <button className="button secondary" onClick={() => { clearOperatorToken(); setDraft(""); setNotice(""); }}>Clear token</button>
      <span role="status">{access.configured ? "Operator token saved for this page" : "Workspace locked. Save an operator token to continue."}</span>
      {notice && <p role="alert">{notice}</p>}
    </section>
    {access.configured ? <Fragment key={access.version}>{children}</Fragment> : null}
  </>;
}

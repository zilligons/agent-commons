// Forms in which a sealed envelope could carry a plaintext without containing it verbatim. The envelope is checked as
// JSON text, and the codebase already writes binary as hex (enc.ct) and base64, so a regression would most likely leak
// in one of those encodings. Base64 output depends on where the plaintext sits in the encoded buffer, so one variant is
// listed per byte alignment; each covers only the whole 3-byte groups inside the plaintext, which encode the same way
// wherever the plaintext lands. In `base64@s`, s is the number of leading plaintext bytes skipped to reach a group
// boundary. A form shorter than 6 bytes is skipped, so for a plaintext under 8 bytes base64 coverage is partial (some
// alignments go unchecked); the text and hex forms have no length floor.
export function leakForms(plaintext) {
  const pt = Buffer.from(plaintext, "utf8");
  const forms = [["text", JSON.stringify(plaintext).slice(1, -1)], ["hex", pt.toString("hex")]];
  for (let s = 0; s < 3; s++) {
    const core = pt.subarray(s, s + 3 * Math.floor((pt.length - s) / 3));
    if (core.length < 6) continue; // too short to match without false hits
    forms.push([`base64@${s}`, core.toString("base64")], [`base64url@${s}`, core.toString("base64url")]);
  }
  return forms;
}

// Names of the forms of `plaintext` found in `text`. Hex is matched case-insensitively; the other forms are exact.
export function leakedForms(text, plaintext) {
  const lower = text.toLowerCase();
  return leakForms(plaintext).filter(([name, form]) => (name === "hex" ? lower : text).includes(form)).map(([name]) => name);
}

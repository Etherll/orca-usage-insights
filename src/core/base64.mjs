// Base64 for typed arrays in JSON cache files. Pure: uses Buffer when there is one, else btoa/atob.

export function toBase64(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (globalThis.Buffer) return globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

// The bytes as a typed array of `Type`, in a fresh aligned buffer (Buffer.from may hand back a slice
// of a shared pool). Throws when the byte count is not a whole number of elements.
export function fromBase64(text, Type) {
  const bytes = globalThis.Buffer ? globalThis.Buffer.from(text, 'base64') : Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (bytes.byteLength % Type.BYTES_PER_ELEMENT !== 0) throw new Error('bad base64 column');
  const out = new Type(bytes.byteLength / Type.BYTES_PER_ELEMENT);
  new Uint8Array(out.buffer).set(bytes);
  return out;
}

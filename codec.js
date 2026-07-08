/**
 * codec.js — framing for the quickjs-debugger wire protocol.
 *
 * Wire format (see quickjs-debugger.c, js_transport_write_message_newline):
 *
 *     %08x '\n' <json> '\n'
 *
 * where the 8-hex-digit length counts the BYTES of <json> plus the trailing
 * newline. This module is environment-free: no qjs-modules imports, no DOM.
 * Text en/decoding is injectable so it runs identically in the browser
 * (globalThis.TextEncoder/TextDecoder) and in QuickJS ('textcode').
 *
 * Layers above this never see framing; layers below never see JSON.
 */

const HEADER_LEN = 9; /* 8 hex digits + '\n' */

/** Frame a JSON string. byteLength must be the UTF-8 byte count of `json`. */
export function frameMessage(json, byteLength = json.length) {
  return (byteLength + 1).toString(16).padStart(8, '0') + '\n' + json + '\n';
}

/**
 * Incremental, push-based frame decoder for stream transports (TCP).
 * Feed it arbitrary chunks (Uint8Array/ArrayBuffer); it emits complete JSON
 * strings via onFrame. Handles frames split across chunks and multiple
 * frames per chunk. Byte-accurate: multi-byte UTF-8 cannot desynchronize it.
 */
export class FrameDecoder {
  #buf = new Uint8Array(0);
  #need = -1; /* -1: waiting for header, otherwise payload bytes wanted */

  constructor({ decodeText, onFrame } = {}) {
    /* injectable for QuickJS: pass `new TextDecoder()` from 'textcode' */
    this.decodeText = decodeText ?? (bytes => new TextDecoder().decode(bytes));
    this.onFrame = onFrame ?? (() => {});
  }

  push(chunk) {
    if(chunk instanceof ArrayBuffer) chunk = new Uint8Array(chunk);

    const buf = new Uint8Array(this.#buf.length + chunk.length);
    buf.set(this.#buf, 0);
    buf.set(chunk, this.#buf.length);
    this.#buf = buf;

    for(;;) {
      if(this.#need < 0) {
        if(this.#buf.length < HEADER_LEN) return;

        let len = 0;

        for(let i = 0; i < 8; i++) {
          const c = this.#buf[i];
          const d = c >= 0x61 ? c - 0x57 : c >= 0x41 ? c - 0x37 : c - 0x30;
          if(d < 0 || d > 15)
            throw new Error(
              `FrameDecoder: bad header byte 0x${c.toString(16)} at offset ${i}`,
            );
          len = len * 16 + d;
        }

        this.#buf = this.#buf.subarray(HEADER_LEN);
        this.#need = len;
      }

      if(this.#buf.length < this.#need) return;

      const payload = this.#buf.subarray(0, this.#need);
      this.#buf = this.#buf.subarray(this.#need);
      this.#need = -1;

      /* the counted length includes the trailing '\n'; JSON.parse tolerates
         it, but trim for cleanliness */
      let json = this.decodeText(payload);
      if(json.endsWith('\n')) json = json.slice(0, -1);

      this.onFrame(json);
    }
  }

  reset() {
    this.#buf = new Uint8Array(0);
    this.#need = -1;
  }
}

//export default { frameMessage, FrameDecoder };

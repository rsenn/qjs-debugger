/* wire-codec.js — message <-> wire framing strategies for the QuickJS debugger protocol.
 *
 * Two interchangeable codecs, no I/O, no socket imports:
 *
 *   LengthPrefixedJsonCodec — the native framing of quickjs-debugger.c:
 *       "%08x\n" <json> "\n"     (the hex length counts <json> plus the trailing \n)
 *
 *   JsonMessageCodec        — one JSON document per transport message, no prefix.
 *       For message-oriented transports (WebSocket via qjs-lws / qjs-net).
 *
 * Codec interface:
 *   name                      string
 *   encode(obj)   -> string   serialize one protocol object for the wire
 *   feed(chunk)   -> object[] push received bytes/text, get back complete messages
 *   reset()                   drop any partial reassembly state
 */

import { TextEncoder, TextDecoder } from 'textcode';

const utf8encoder = new TextEncoder();
const utf8decoder = new TextDecoder();
const utf8encode = s => utf8encoder.encode(s);
const utf8decode = b => utf8decoder.decode(b);

function toBytes(chunk) {
  if(chunk instanceof Uint8Array) return chunk;
  if(chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if(ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if(typeof chunk == 'string') return utf8encode(chunk);
  throw new TypeError('wire-codec: unsupported chunk type');
}

export class LengthPrefixedJsonCodec {
  #buf = new Uint8Array(0);

  get name() {
    return 'length-prefixed JSON';
  }

  encode(obj) {
    const json = JSON.stringify(obj);
    const len = utf8encode(json).length + 1; /* + trailing newline, see js_transport_write_message_newline() */
    return ('0000000' + len.toString(16)).slice(-8) + '\n' + json + '\n';
  }

  feed(chunk) {
    const add = toBytes(chunk);

    if(add.length) {
      const merged = new Uint8Array(this.#buf.length + add.length);
      merged.set(this.#buf, 0);
      merged.set(add, this.#buf.length);
      this.#buf = merged;
    }

    const out = [];

    for(;;) {
      if(this.#buf.length < 9) break;

      let header = '';
      for(let i = 0; i < 8; i++) header += String.fromCharCode(this.#buf[i]);

      const len = parseInt(header, 16);

      if(!(len > 0)) {
        /* resync: skip one byte rather than wedging the stream */
        this.#buf = this.#buf.subarray(1);
        continue;
      }

      if(this.#buf.length < 9 + len) break;

      const body = utf8decode(this.#buf.subarray(9, 9 + len)).replace(/\n+$/, '');
      this.#buf = this.#buf.slice(9 + len);

      try {
        out.push(JSON.parse(body));
      } catch(e) {
        out.push({ type: 'protocol-error', error: e.message, raw: body });
      }
    }

    return out;
  }

  reset() {
    this.#buf = new Uint8Array(0);
  }
}

export class JsonMessageCodec {
  get name() {
    return 'bare JSON messages';
  }

  encode(obj) {
    return JSON.stringify(obj);
  }

  feed(chunk) {
    const text = typeof chunk == 'string' ? chunk : utf8decode(toBytes(chunk));
    if(text.trim() === '') return [];

    try {
      return [JSON.parse(text)];
    } catch(e) {
      /* tolerate several newline-separated documents in one message */
      const out = [];
      for(const line of text.split('\n')) {
        if(line.trim() === '') continue;
        try {
          out.push(JSON.parse(line));
        } catch(e2) {
          out.push({ type: 'protocol-error', error: e2.message, raw: line });
        }
      }
      return out;
    }
  }

  reset() {}
}

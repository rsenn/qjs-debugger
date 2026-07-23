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

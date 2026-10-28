#!/usr/bin/env python3
"""Encode decoded.json back into decode.txt's format (inverse of decode.py).

    serialize tree -> payload bytes
    hexbyte[i] = (plain[i] + 7*i + 13) mod 256  -> uppercase hex
Tables are the ordered {"__table__":[[k,v],...]} pair lists decode.py emits,
so numeric vs string keys and key order are preserved exactly.
"""
import struct, sys, json

def enc_value(v, out):
    if isinstance(v, bool):
        out.append(0x03 if v else 0x02)
    elif isinstance(v, dict) and "__table__" in v:
        out.append(0x08)
        for k, val in v["__table__"]:
            enc_key(k, out); enc_value(val, out)
        out.append(0x00)
    elif isinstance(v, (int, float)):
        out += b"\x05" + struct.pack("<d", float(v))
    elif isinstance(v, str):
        b = v.encode(); out += b"\x06" + struct.pack("<H", len(b)) + b
    else:
        raise TypeError(type(v))

def enc_key(k, out):
    # Keys keep whatever type decode.py read: the tool writes waypoint map keys
    # as STRINGS ('1','2',...), never as doubles. Never coerce here.
    enc_value(k, out)

def serialize(tree):
    out = bytearray(b"\xf4")          # file-header byte
    enc_value(tree, out)
    return bytes(out)

def cipher(payload):
    return bytes((payload[i] + 7 * i + 13) & 0xFF for i in range(len(payload)))

if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "decoded.json"
    tree = json.load(open(src))
    hexstr = cipher(serialize(tree)).hex().upper()
    # Every file the tool emits starts with the literal marker 'O' in place of
    # the first hex digit. Without it the tool rejects the file.
    hexstr = "O" + hexstr[1:]
    open("encoded.txt", "w").write(hexstr)
    print(hexstr[:80], "...", "len", len(hexstr))

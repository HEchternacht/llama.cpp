#!/usr/bin/env python3
"""Decode decode.txt -> readable YAML + lossless JSON.

Cipher : plain[i] = (hexbyte[i] - 7*i - 13) mod 256
Payload (little custom serialization):
    0xF4  one file-header byte (skipped)
    0x08  table begin              0x00  table end
    0x06  string  (u16 LE length + utf8 bytes)
    0x05  double  (8 bytes IEEE-754 LE)
    0x03  bool true                0x02  bool false
A table is a flat run of key,value,key,value,... ; keys are string or number.
Tables are kept as ordered [key,value] pair lists so duplicate/odd numeric
keys survive (this file has some) and re-encoding is byte-exact.
"""
import struct, sys, json

def decipher(text):
    s = text.strip().replace("O", "0")          # leading 'O' marker -> '0'
    raw = bytes.fromhex(s)
    return bytes((raw[i] - 7 * i - 13) & 0xFF for i in range(len(raw)))

def load_bytes(path):
    return decipher(open(path, "rb").read().decode())

class Reader:
    def __init__(self, buf): self.b, self.i = buf, 0
    def u8(self):  v = self.b[self.i];                         self.i += 1; return v
    def u16(self): v = struct.unpack_from("<H", self.b, self.i)[0]; self.i += 2; return v
    def f64(self): v = struct.unpack_from("<d", self.b, self.i)[0]; self.i += 8; return v
    def value(self):
        t = self.u8()
        if t == 0x05:
            d = self.f64(); return int(d) if d.is_integer() else d
        if t == 0x06:
            n = self.u16(); s = self.b[self.i:self.i + n].decode(); self.i += n; return s
        if t == 0x03: return True
        if t == 0x02: return False
        if t == 0x08:
            pairs = []
            while self.b[self.i] != 0x00:
                k = self.value(); v = self.value(); pairs.append([k, v])
            self.i += 1
            return {"__table__": pairs}
        raise ValueError(f"unknown tag {t:#x} at {self.i-1}")

def parse(buf):
    r = Reader(buf)
    if r.b[r.i] == 0xF4: r.i += 1
    return r.value()

def fmt(v):
    if isinstance(v, bool): return "true" if v else "false"
    return str(v)

def to_yaml(node, ind=0, lines=None):
    top = lines is None
    if top: lines = []
    pad = "  " * ind
    if isinstance(node, dict) and "__table__" in node:
        for k, v in node["__table__"]:
            if isinstance(v, dict) and "__table__" in v:
                lines.append(f"{pad}{k}:"); to_yaml(v, ind + 1, lines)
            else:
                lines.append(f"{pad}{k}: {fmt(v)}")
    else:
        lines.append(f"{pad}{fmt(node)}")
    return "\n".join(lines) if top else None

if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "decode.txt"
    tree = parse(load_bytes(src))
    yaml = to_yaml(tree)
    open("decoded.yaml", "w").write(yaml + "\n")
    json.dump(tree, open("decoded.json", "w"), indent=2)
    print(yaml)

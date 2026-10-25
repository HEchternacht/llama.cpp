#!/usr/bin/env python3
"""stdin -> decode -> transform -> encode -> stdout.

Reads an encoded waypoint blob on stdin, applies transform.transform(), writes
the re-encoded blob on stdout. Any problem goes to stderr with exit code 1 so
the caller can leave the clipboard untouched.
"""
import sys, re
from decode import decipher, Reader
from encode import serialize, cipher
from transform import transform, wp_get, wp_set

def parse_strict(buf):
    r = Reader(buf)
    if not buf or buf[0] != 0xF4:
        raise ValueError("missing 0xF4 header byte")
    r.i = 1
    tree = r.value()
    if r.i != len(buf):
        raise ValueError(f"trailing data: {len(buf) - r.i} bytes unconsumed")
    return tree

def main():
    text = sys.stdin.read().strip()
    if not text:
        raise ValueError("clipboard is empty")
    if not re.fullmatch(r"O?[0-9A-Fa-f]+", text):
        raise ValueError("clipboard does not look like an encoded blob")
    if len(text) % 2:
        raise ValueError("odd number of hex digits")

    tree = parse_strict(decipher(text))
    if wp_get(tree, "waypoints") is None:
        raise ValueError("no 'waypoints' table found")

    before = len(wp_get(tree, "waypoints")["__table__"])
    transform(tree)

    # Append 'transformed' suffix to the 'name' field.
    name_val = wp_get(tree, "name")
    if name_val is not None and isinstance(name_val, str):
        wp_set(tree, "name", name_val + "transformed")

    after = len(wp_get(tree, "waypoints")["__table__"])

    sys.stdout.write("O" + cipher(serialize(tree)).hex().upper()[1:])
    print(f"waypoints: {before} -> {after}", file=sys.stderr)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

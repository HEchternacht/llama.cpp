#!/usr/bin/env python3
"""Lure/stop waypoint doubler.

    python transform1.py SPEED STOP RESUME [INTER] [IN] [OUT]

Per original waypoint emit a lure waypoint; every INTER-th one also gets a
stop copy at the same coords:
  A: lure=true,  speed SPEED, creatures 0,    resume 0      (always)
  B: lure=false, speed SPEED, creatures STOP, resume RESUME (every INTER-th)
INTER 1 = a stop copy after every waypoint (default)
INTER 2 = one yes, one no ; INTER 3 = one yes, two no ; ...
Defaults: IN=data1.txt  OUT=encoded_data1.txt
"""
import copy, sys
from decode import load_bytes, parse
from encode import serialize, cipher
from transform import wp_get, wp_set
from edit1 import retag

def transform(tree, speed, stop, resume, inter=1):
    wps = wp_get(tree, "waypoints")["__table__"]
    new_pairs = []
    idx = 0
    for n, (_, wp) in enumerate(wps):
        idx += 1
        a = copy.deepcopy(wp)
        wp_set(a, "index", idx)
        wp_set(a, "lure", True)
        wp_set(a, "creatures", 0)
        wp_set(a, "resume", 0)
        wp_set(a, "speed", speed)
        new_pairs.append([idx, a])          # integer key, like the tool writes

        if n % inter:                       # not an INTER-th waypoint -> no stop copy
            continue

        idx += 1
        b = copy.deepcopy(wp)
        wp_set(b, "index", idx)
        wp_set(b, "lure", False)
        wp_set(b, "creatures", stop)
        wp_set(b, "resume", resume)
        wp_set(b, "speed", speed)
        new_pairs.append([idx, b])

    wp_get(tree, "waypoints")["__table__"] = new_pairs
    return tree

if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) < 3:
        sys.exit(__doc__)
    speed, stop, resume = (int(a) for a in args[:3])
    rest = args[3:]
    inter = int(rest.pop(0)) if rest and rest[0].isdigit() else 1
    src = rest[0] if len(rest) > 0 else "data1.txt"
    dst = rest[1] if len(rest) > 1 else "encoded_data1.txt"

    tree = transform(parse(load_bytes(src)), speed, stop, resume, inter)
    name = retag(tree, inter)
    hexstr = "O" + cipher(serialize(tree)).hex().upper()[1:]
    open(dst, "w").write(hexstr)
    print(f"{src} -> {dst}  waypoints: {len(wp_get(tree, 'waypoints')['__table__'])}"
          f"  inter={inter}  name: {name}")

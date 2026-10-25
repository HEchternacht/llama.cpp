#!/usr/bin/env python3
"""Edit an already-transformed map (specs only; order/index untouched).

    python edit1.py SPEED STOP RESUME [INTER] [IN] [OUT] [--renumber]

SPEED  -> every waypoint
STOP   -> creatures on the stop waypoint of each active pair
RESUME -> resume    on the stop waypoint of each active pair
INTER  -> '-' leaves the pairing (and the name) untouched: fixer mode, pair
          with --renumber to repair load order only.
          Otherwise keep the stop waypoint on every INTER-th coord pair; the stop
          waypoint of a skipped pair is turned into a lure one (0/0), so
          nothing is added or removed and INTER stays reversible.
          1 = every pair stops (default), 2 = one yes one no, 3 = one yes two no.
Use '-' for SPEED/STOP/RESUME to leave that value unchanged.
--renumber : rewrite keys/index 1..N in file order. Needed only when the source
             has duplicate or missing indexes -- the tool orders by index, so
             those waypoints load out of place.
Defaults: IN=encoded_data1.txt  OUT=(same as IN)
"""
import re, sys
from collections import Counter
from decode import load_bytes, parse
from encode import serialize, cipher
from transform import wp_get, wp_set

def edit(tree, speed, stop, resume, inter=1, renumber=False):
    """inter None -> leave lure/creatures/resume pairing alone (fixer mode)."""
    pairs = wp_get(tree, "waypoints")["__table__"]
    for i, (_, wp) in enumerate(pairs, 1):
        if renumber:
            pairs[i - 1][0] = i
            wp_set(wp, "index", i)
        if speed is not None:
            wp_set(wp, "speed", speed)

        # Waypoints come in coord pairs: odd = lure, even = its stop copy.
        if inter is not None and i % 2 == 0:
            active = ((i // 2) - 1) % inter == 0
            wp_set(wp, "lure", not active)
            wp_set(wp, "creatures", (stop if stop is not None
                                     else wp_get(wp, "creatures")) if active else 0)
            wp_set(wp, "resume", (resume if resume is not None
                                  else wp_get(wp, "resume")) if active else 0)
    return tree

def retag(tree, inter=1):
    """name -> '<base> s<speed>s<stop>r<resume>[i<inter>]', read back from the
    edited tree so '-' (keep) shows what is actually in the file. Any existing
    tag is stripped first so repeated edits do not stack suffixes."""
    wps = [wp for _, wp in wp_get(tree, "waypoints")["__table__"]]
    stopper = next((w for w in wps if not wp_get(w, "lure")), wps[0])
    tag = (f"s{wp_get(wps[0], 'speed')}"
           f"s{wp_get(stopper, 'creatures')}"
           f"r{wp_get(stopper, 'resume')}"
           + (f"i{inter}" if inter > 1 else ""))
    base = re.sub(r"\s+s\d+s\d+r\d+(i\d+)?$", "", str(wp_get(tree, "name")))
    wp_set(tree, "name", f"{base} {tag}")
    return f"{base} {tag}"

def warn_order(tree):
    ix = [wp_get(wp, "index") for _, wp in wp_get(tree, "waypoints")["__table__"]]
    dup = sorted(k for k, c in Counter(ix).items() if c > 1)
    gap = sorted(set(range(1, len(ix) + 1)) - set(ix))
    if dup or gap:
        print(f"WARNING: duplicate index {dup}, missing index {gap} -- "
              f"these waypoints will load out of order. Re-run with --renumber to fix.")

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--renumber"]
    renumber = "--renumber" in sys.argv
    if len(args) < 3:
        sys.exit(__doc__)
    speed, stop, resume = (None if a == "-" else int(a) for a in args[:3])
    rest = args[3:]
    if rest and (rest[0].isdigit() or rest[0] == "-"):
        inter = None if rest.pop(0) == "-" else int(args[3])
    else:
        inter = 1
    src = rest[0] if len(rest) > 0 else "encoded_data1.txt"
    dst = rest[1] if len(rest) > 1 else src

    tree = edit(parse(load_bytes(src)), speed, stop, resume, inter, renumber)
    touched = any(v is not None for v in (speed, stop, resume, inter))
    name = retag(tree, inter or 1) if touched else wp_get(tree, "name")
    hexstr = "O" + cipher(serialize(tree)).hex().upper()[1:]
    open(dst, "w").write(hexstr)
    print(f"{src} -> {dst}  waypoints: {len(wp_get(tree, 'waypoints')['__table__'])}"
          f"  inter={inter}  name: {name}  renumber={renumber}")
    if not renumber:
        warn_order(tree)

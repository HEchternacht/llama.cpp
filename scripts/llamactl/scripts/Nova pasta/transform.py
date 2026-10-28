#!/usr/bin/env python3
"""Interleave a lure:false copy after each waypoint and reindex.

As a module:  transform(tree) -> tree   (mutates and returns it)
As a script:  decode.txt -> output_transform.txt
"""
import copy
from decode import load_bytes, parse
from encode import serialize, cipher

def wp_get(wp, key):
    for k, v in wp["__table__"]:
        if k == key:
            return v

def wp_set(wp, key, val):
    for pair in wp["__table__"]:
        if pair[0] == key:
            pair[1] = val
            return

def transform(tree):
    wps = wp_get(tree, "waypoints")["__table__"]
    new_pairs = []
    idx = 0
    for _, wp in wps:
        idx += 1
        orig = copy.deepcopy(wp)
        wp_set(orig, "index", idx)
        wp_set(orig, "resume", 9)
        new_pairs.append([str(idx), orig])      # string key, like the tool writes

        idx += 1
        dup = copy.deepcopy(wp)
        wp_set(dup, "index", idx)
        wp_set(dup, "lure", False)
        wp_set(dup, "creatures", 10)
        wp_set(dup, "resume", 9)
        wp_set(dup, "speed", 13)
        new_pairs.append([str(idx), dup])       # string key

    wp_get(tree, "waypoints")["__table__"] = new_pairs
    return tree

if __name__ == "__main__":
    tree = transform(parse(load_bytes("decode.txt")))
    hexstr = "O" + cipher(serialize(tree)).hex().upper()[1:]   # 'O' marker
    open("output_transform.txt", "w").write(hexstr)
    n = len(wp_get(tree, "waypoints")["__table__"])
    print(f"waypoints: {n} -> output_transform.txt")

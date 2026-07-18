import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

MODEL_DIR = r"C:\cmodels"
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model_args.json")
SERVER_EXE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "llama-server.exe")

EXAMPLE_ARGS = (
    '-ngl all --jinja -fa on --models-max 1 --prio 2 -np 1 -c 65536 --api-key test '
    '-ncmoe 38 --cache-ram 0 --fit off --threads 6 --poll 50 --prio-batch 2 '
    '--log-timestamps --log-colors auto -b 4096 -ub 2048 --no-mmap '
    '-C 0xFFF -Cb 0xFFF --n-predict 32768 --ctx-checkpoints 32 --reasoning on '
    '--alias "my model" --kv-offload --slot-save-path cache '
    '--chat-template-kwargs "{\\"enable_thinking\\":true,\\"preserve_thinking\\":true}" '
    '--temp 0.0 --top-k 40 --top-p 0.95 --no-direct-io -ctk q8_0 -ctv q8_0 -lv 4'
)


def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_config(cfg):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


def list_models():
    models = sorted(
        f for f in os.listdir(MODEL_DIR) if f.lower().endswith(".gguf")
    )
    return models


MMPROJ_PATH = r"C:\cmodels\ornithmmproj\mmproj.gguf"


def mmproj_args(args):
    # bump -ncmoe / --n-cpu-moe by 4 and offload mmproj to VRAM
    def bump(m):
        return f"{m.group(1)}{int(m.group(2)) + 4}"

    args = re.sub(r"(-ncmoe\s+|--n-cpu-moe\s+)(\d+)", bump, args)
    return f'{args} --mmproj "{MMPROJ_PATH}"'


def pick_model(models, cfg):
    entries = []  # (model_file, use_mmproj)
    for m in models:
        entries.append((m, False))
        if "ornith" in m.lower():
            entries.append((m, True))

    print("\nAvailable models:\n")
    for i, (m, mp) in enumerate(entries, 1):
        tag = " [saved]" if m in cfg else ""
        name = os.path.splitext(m)[0] + ("+MMPROJ" if mp else "")
        print(f"  {i}  {name}{tag}")
    print()
    raw = input(f"Choose model (1-{len(entries)}): ").strip()
    idx = int(raw) - 1
    if not (0 <= idx < len(entries)):
        print("Invalid choice.")
        sys.exit(1)
    return entries[idx]


def get_args_for_model(model_name, cfg):
    if model_name in cfg:
        print(f"\nUsing saved args for: {model_name}")
        return cfg[model_name]

    model_path = os.path.join(MODEL_DIR, model_name)
    print(f"\nNo saved args for: {model_name}")
    print("\nExample command (copy-paste and modify):")
    print(f'\n  llama-server.exe -m "{model_path}" {EXAMPLE_ARGS}\n')
    print("Enter all args EXCEPT -m / model path.")
    print("(Paste your args and press Enter)\n")
    args = input("Args: ").strip()
    if not args:
        print("No args provided, aborting.")
        sys.exit(1)
    cfg[model_name] = args
    save_config(cfg)
    print("\nArgs saved.")
    return args


def prefix_cache(model_name, args):
    # per-model persistent prompt-prefix cache:
    # - on startup: restore cache/<model>-prefix.bin if present
    # - after the first request: validate the prefix still matches; if stale or
    #   missing, rebuild it as the longest common token prefix between this
    #   session's prompt and the previous session's (stored in the sidecar)
    stem = os.path.splitext(model_name)[0]
    prefix_file = stem + "-prefix.bin"
    slot_dir_m = re.search(r'--slot-save-path\s+"?([^\s"]+)', args)
    slot_dir = os.path.join(os.path.dirname(SERVER_EXE), slot_dir_m.group(1) if slot_dir_m else "cache")
    os.makedirs(slot_dir, exist_ok=True)
    bin_path = os.path.join(slot_dir, prefix_file)
    meta_path = os.path.join(slot_dir, stem + "-prefix.meta.json")
    port_m = re.search(r"--port\s+(\d+)", args)
    base = f"http://127.0.0.1:{port_m.group(1) if port_m else '8080'}"
    key_m = re.search(r'--api-key\s+"?([^\s"]+)', args)
    headers = {"Content-Type": "application/json"}
    if key_m:
        headers["Authorization"] = "Bearer " + key_m.group(1)

    def http(path, payload=None, timeout=120):
        body = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(base + path, data=body, headers=headers,
                                     method="POST" if body is not None else "GET")
        return json.load(urllib.request.urlopen(req, timeout=timeout))

    def worker():
        for _ in range(600):
            time.sleep(1)
            try:
                if http("/health", timeout=2).get("status") == "ok":
                    break
            except Exception:
                continue
        else:
            return

        restored = False
        if os.path.exists(bin_path):
            try:
                res = http("/slots/0?action=restore", {"filename": prefix_file})
                print(f"[prefix-cache] restored {res.get('n_restored')} tokens")
                restored = True
            except Exception as e:
                print(f"[prefix-cache] restore failed: {e}")

        meta = {}
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                meta = {}

        # wait for the first completed request (needs LLAMA_SERVER_SLOTS_DEBUG=1)
        prompt_text = None
        while prompt_text is None:
            time.sleep(3)
            try:
                s = http("/slots", timeout=10)[0]
                if s.get("id_task", -1) != -1 and not s.get("is_processing") and s.get("prompt"):
                    prompt_text = s["prompt"]
            except Exception:
                pass

        try:
            new_tokens = http("/tokenize", {"content": prompt_text})["tokens"]
        except Exception as e:
            print(f"[prefix-cache] tokenize failed: {e}")
            return

        prefix = meta.get("prefix_tokens") if restored else None
        if prefix and new_tokens[:len(prefix)] == prefix:
            print(f"[prefix-cache] prefix valid ({len(prefix)} tokens)")
        else:
            last = meta.get("last_prompt_tokens")
            cand = None
            if last:
                n = min(len(new_tokens), len(last))
                i = 0
                while i < n and new_tokens[i] == last[i]:
                    i += 1
                cand = new_tokens[:i]
            if cand and len(cand) >= 512:
                try:
                    http("/completion", {"prompt": cand, "n_predict": 0, "cache_prompt": True}, timeout=600)
                    res = http("/slots/0?action=save", {"filename": prefix_file})
                    meta["prefix_tokens"] = cand
                    print(f"[prefix-cache] rebuilt: saved {res.get('n_saved')} tokens")
                except Exception as e:
                    print(f"[prefix-cache] rebuild failed: {e}")
            else:
                print("[prefix-cache] no usable common prefix yet, will build next session")

        meta["last_prompt_tokens"] = new_tokens
        try:
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f)
        except Exception as e:
            print(f"[prefix-cache] meta write failed: {e}")

    threading.Thread(target=worker, daemon=True).start()


def run(model_name, args):
    model_path = os.path.join(MODEL_DIR, model_name)
    cmd = f'"{SERVER_EXE}" -m "{model_path}" {args}'
    print(f"\n{cmd}\n")
    os.environ["LLAMA_SERVER_SLOTS_DEBUG"] = "1"
    prefix_cache(model_name, args)
    subprocess.run(cmd, shell=True)


def main():
    models = list_models()
    if not models:
        print("No .gguf models found in", MODEL_DIR)
        sys.exit(1)

    cfg = load_config()
    model_name, use_mmproj = pick_model(models, cfg)
    args = get_args_for_model(model_name, cfg)
    if use_mmproj:
        args = mmproj_args(args)
    run(model_name, args)


if __name__ == "__main__":
    main()

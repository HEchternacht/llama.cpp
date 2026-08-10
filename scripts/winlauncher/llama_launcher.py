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
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")


def log_event(msg):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(os.path.join(LOG_DIR, "launcher.log"), "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}\n")
    except Exception:
        pass

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


def pop_flag(name, args):
    # launcher-only flags, never passed to llama-server
    stripped = re.sub(r"\s*--" + name + r"\b", "", args)
    return stripped.strip(), stripped != args


def prefix_cache(model_name, args, getcache, norestore):
    # per-model persistent prompt-prefix cache:
    # - on startup: restore cache/<model>-prefix.bin if present (unless --norestore)
    # - with --getcache, after the first request: validate the prefix still
    #   matches; if stale or missing, rebuild it as the longest common token
    #   prefix between this session's prompt and the previous session's
    #   (stored in the sidecar)
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
        def note(msg):
            print(f"[prefix-cache] {msg}")
            log_event(f"prefix-cache [{model_name}]: {msg}")

        # wait until the server on this port is healthy AND is actually running
        # our model (on model switch the previous server may still hold the port,
        # and touching its slots would corrupt this model's cache)
        warned = False
        for _ in range(600):
            time.sleep(1)
            try:
                if http("/health", timeout=2).get("status") != "ok":
                    continue
                mp = http("/props", timeout=5).get("model_path", "")
                if os.path.basename(mp) == model_name:
                    break
                if not warned:
                    note(f"waiting: port still served by {os.path.basename(mp) or 'another model'}")
                    warned = True
            except Exception:
                continue
        else:
            return

        restored = False
        if norestore:
            note("restore disabled (--norestore)")
        elif os.path.exists(bin_path):
            try:
                res = http("/slots/0?action=restore", {"filename": prefix_file})
                note(f"restored {res.get('n_restored')} tokens")
                restored = True
            except Exception as e:
                note(f"restore failed: {e}")
        elif getcache:
            note("no cache file yet, will build from first request")
        else:
            note("no cache file yet (--getcache off, nothing to build)")

        if not getcache:
            note("restore-only mode, prefix watcher disabled (add --getcache to build)")
            return

        meta = {}
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                meta = {}

        # watch every completed request for the whole session (needs
        # LLAMA_SERVER_SLOTS_DEBUG=1); compare each prompt against the
        # previous session's longest prompt and rebuild the saved prefix
        # whenever a meaningfully longer common prefix appears
        last = meta.get("last_prompt_tokens") or []   # previous session's longest
        prefix = (meta.get("prefix_tokens") or []) if restored else []
        session_longest = []
        seen = None
        while True:
            time.sleep(3)
            try:
                s = http("/slots", timeout=10)[0]
            except Exception:
                continue
            if s.get("id_task", -1) == -1 or s.get("is_processing") or not s.get("prompt"):
                continue
            if s["prompt"] == seen:
                continue
            seen = s["prompt"]
            try:
                new_tokens = http("/tokenize", {"content": seen})["tokens"]
            except Exception as e:
                print(f"[prefix-cache] tokenize failed: {e}")
                continue

            if len(new_tokens) > len(session_longest):
                session_longest = new_tokens
                meta["last_prompt_tokens"] = session_longest
                try:
                    with open(meta_path, "w", encoding="utf-8") as f:
                        json.dump(meta, f)
                except Exception as e:
                    print(f"[prefix-cache] meta write failed: {e}")

            def lcp(a, b):
                n = min(len(a), len(b))
                i = 0
                while i < n and a[i] == b[i]:
                    i += 1
                return i

            cand = new_tokens[:lcp(new_tokens, last)]

            # never cache past the first user turn
            marks = ["<|im_start|>user", "<|user|>", "<|User|>", "[INST]",
                     "<start_of_turn>user", "<|start_header_id|>user"]
            pos = min((p for p in (seen.find(m) for m in marks) if p != -1), default=-1)
            if pos > 0:
                try:
                    head = http("/tokenize", {"content": seen[:pos]})["tokens"]
                    cand = cand[:lcp(new_tokens, head)]
                except Exception:
                    pass
            valid = bool(prefix) and new_tokens[:len(prefix)] == prefix
            # rebuild only when missing, or when a comparably-sized request
            # proves the prefix stale (short side-requests can't judge - ignore)
            stale = prefix and not valid and len(new_tokens) * 4 >= len(prefix) * 3
            if (not prefix or stale) and len(cand) >= 512:
                try:
                    http("/completion", {"prompt": cand, "n_predict": 0, "cache_prompt": True}, timeout=600)
                    res = http("/slots/0?action=save", {"filename": prefix_file})
                    note(f"rebuilt: saved {res.get('n_saved')} tokens (was {len(prefix)})")
                    prefix = cand
                    meta["prefix_tokens"] = cand
                    with open(meta_path, "w", encoding="utf-8") as f:
                        json.dump(meta, f)
                    return
                except Exception as e:
                    note(f"rebuild failed: {e}")
            elif valid:
                note(f"prefix valid ({len(prefix)} tokens)")
                return
            elif prefix:
                note(f"prefix not matched by this request ({len(new_tokens)} tokens, lcp {len(cand)})")

    # nothing to restore and nothing to build - don't even poll the server
    if norestore and not getcache:
        return

    threading.Thread(target=worker, daemon=True).start()


def run(model_name, args):
    args, getcache = pop_flag("getcache", args)
    args, norestore = pop_flag("norestore", args)
    model_path = os.path.join(MODEL_DIR, model_name)
    cmd = f'"{SERVER_EXE}" -m "{model_path}" {args}'
    print(f"\n{cmd}\n")
    # only the prefix watcher needs slots debug (it reads the prompt text off
    # /slots); it also costs a copy of every generated text and a token dump on
    # each cache mismatch, so keep it off otherwise
    if getcache:
        os.environ["LLAMA_SERVER_SLOTS_DEBUG"] = "1"
    else:
        os.environ.pop("LLAMA_SERVER_SLOTS_DEBUG", None)
    prefix_cache(model_name, args, getcache, norestore)

    os.makedirs(LOG_DIR, exist_ok=True)
    run_log = os.path.join(LOG_DIR, f"server-{time.strftime('%Y%m%d-%H%M%S')}.log")
    log_event(f"server start: {model_name} | full output: {os.path.basename(run_log)}")
    log_event(f"  args: {args}")
    # tee server output: console + full per-run log file
    p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    with open(run_log, "wb") as lf:
        for line in p.stdout:
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
            lf.write(line)
    rc = p.wait()
    if rc == 0:
        log_event(f"server exit: {model_name} (clean)")
    else:
        log_event(f"server CRASH/kill: {model_name} exit code {rc} - see {os.path.basename(run_log)}")


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
    try:
        main()
    except KeyboardInterrupt:
        pass
    except SystemExit:
        raise
    except Exception:
        import traceback
        log_event("launcher traceback:\n" + traceback.format_exc())
        raise

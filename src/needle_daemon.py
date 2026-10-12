#!/usr/bin/env python3
"""Persistent Needle inference daemon (newline-delimited JSON over stdio).

Keeps the ~35 MB weights + native engine loaded once so repeated on-device
turns skip the ~10 s process/model startup of one-shot `needle_bridge.py`
calls (warm turns cost decode only, ~3-5 s on CPU).

Spawned and supervised by src/needle.js; never run by hand except to debug:
    python3 src/needle_daemon.py
    {"id": 1, "mode": "complete", "text": "...", "tools": [...],
     "max_new_tokens": 128}

Request:  {"id": <any>, "mode": "complete"|"extract"|"embed"|"status"|"shutdown",
           "text": "...", "tools": [...], "schema": {...}, "system": "...",
           "weights": "<.cact path>", "max_new_tokens": 128}
Response: {<result...>, "id": <same>}  (one JSON object per line)

`complete` reuses one agent per (tools, system, weights) triple and calls
reset() before every turn so unrelated user turns never share context.
"""

import json
import os
import sys


def _ensure_engine():
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        from needle_bridge import ensure_engine
        return ensure_engine()
    except Exception:
        return None


def main():
    _ensure_engine()
    import needle

    agents = {}

    def get_agent(tools, system, weights):
        import hashlib
        key = hashlib.sha256(json.dumps(
            {"t": tools or [], "s": system or "", "w": weights or ""},
            sort_keys=True).encode()).hexdigest()
        if key not in agents:
            kw = {}
            if system:
                kw["system"] = system
            if weights:
                kw["weights"] = weights
            agents[key] = needle.Needle(tools=tools or [], **kw)
        return agents[key]

    stdin = sys.stdin
    stdout = sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            stdout.write(json.dumps({"id": None, "success": False,
                                     "error": f"bad request: {exc}"}) + "\n")
            stdout.flush()
            continue
        rid = req.get("id")
        mode = str(req.get("mode") or "complete").lower()
        try:
            if mode == "complete":
                text = str(req.get("text") or "")
                if not text.strip():
                    res = {"success": False, "error": "empty text"}
                else:
                    agent = get_agent(req.get("tools"), req.get("system"),
                                      req.get("weights"))
                    try:
                        agent.reset()
                    except Exception:
                        pass
                    res = dict(agent.complete(
                        text, max_new_tokens=int(req.get("max_new_tokens") or 128)) or {})
                    res["success"] = True
            elif mode == "extract":
                out = needle.extract(
                    str(req.get("text") or ""), req.get("schema") or {},
                    max_new_tokens=int(req.get("max_new_tokens") or 256))
                if out is None:
                    res = {"success": True, "result": None, "refused": True}
                elif hasattr(out, "model_dump"):
                    res = {"success": True, "result": out.model_dump(), "refused": False}
                else:
                    res = {"success": True, "result": out, "refused": False}
            elif mode == "embed":
                agent = get_agent([], None, req.get("weights"))
                vec = agent.embed(str(req.get("text") or ""))
                res = {"success": True, "embedding": list(vec), "dim": len(vec)}
            elif mode == "status":
                res = {"success": True, "installed": True, "daemon": True}
            elif mode == "shutdown":
                stdout.write(json.dumps({"id": rid, "success": True}) + "\n")
                stdout.flush()
                break
            else:
                res = {"success": False, "error": f"unknown mode: {mode}"}
        except Exception as exc:
            res = {"success": False, "error": f"needle error: {exc}"}
        res["id"] = rid
        stdout.write(json.dumps(res, default=str) + "\n")
        stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

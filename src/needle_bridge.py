#!/usr/bin/env python3
"""Stdin/stdout bridge between the Bun assistant (src/needle.js) and cactus-needle.

Protocol: JS spawns `python3 src/needle_bridge.py`, writes one JSON object to
stdin, reads one JSON object from stdout.

Request: {
  "mode": "status" | "complete" | "extract" | "embed",
  "text": "<user request>",            # complete / extract / embed
  "tools": [ {...}, ... ],             # complete (raw JSON-schema dicts)
  "schema": {...},                     # extract (raw JSON-schema dict)
  "system": "<facts string>",          # optional, complete / extract
  "weights": "<path to .cact>",        # optional, complete / extract
  "max_new_tokens": 512,               # optional
  "strict": true                       # optional, complete / extract
}

Response: {"success": true, ...} or {"success": false, "error": "..."}.
`status` never loads a model (no weight download); the other modes load the
base archive (fetched once from Hugging Face, then cached) on first use.
"""

import json
import sys


def ensure_engine():
    """Make sure the native Needle engine library is cached locally.

    Works around upstream packaging skew: the PyPI release pins an engine
    wheel version that may not (yet) be published on the Hugging Face repo
    (e.g. cactus-needle 3.0.5 asks for 3.0.2 while only 3.0.0/3.0.1 wheels
    exist). When the pinned fetch 404s, fall back to the newest published
    wheel for this platform tag and seed it into the pinned version's cache
    slot. Returns the library path. Raises RuntimeError when offline with
    no cached engine.
    """
    import os
    from needle.agent import fetch

    generation = 3
    version = fetch.engine_version(generation)
    cache = os.path.join(os.path.expanduser("~"), ".cache", "cactus-needle",
                         f"v{generation}", version)
    cached = os.path.join(cache, fetch._lib_name())
    if os.path.exists(cached):
        return cached
    try:
        return fetch.fetch_library(version, cache, generation=generation)
    except Exception:
        pass
    from huggingface_hub import hf_hub_download, list_repo_files
    tag = fetch._platform_tag()
    try:
        files = list_repo_files(fetch.engine_repo(generation))
    except Exception as exc:
        raise RuntimeError(f"needle engine download failed (offline?): {exc}")
    cands = sorted((f for f in files
                    if f.startswith("python/cactus_needle-") and tag in f),
                   reverse=True)
    if not cands:
        raise RuntimeError("no compatible needle engine wheel published")
    import zipfile
    path = hf_hub_download(repo_id=fetch.engine_repo(generation),
                           filename=cands[0], repo_type="model")
    with zipfile.ZipFile(path) as archive:
        data = archive.read("needle/libneedle3.so")
    os.makedirs(cache, exist_ok=True)
    with open(cached, "wb") as handle:
        handle.write(data)
    return cached


def _status():
    try:
        import needle  # noqa: F401
        import importlib.metadata as md
    except Exception as exc:
        return {"success": False, "installed": False, "error": f"cactus-needle not installed: {exc}"}
    try:
        version = md.version("cactus-needle")
    except Exception:
        version = "unknown"
    return {"success": True, "installed": True, "package": "cactus-needle", "version": version}


def _complete(req):
    import needle

    ensure_engine()
    text = str(req.get("text") or req.get("query") or "")
    if not text.strip():
        return {"success": False, "error": "Usage: provide text to route."}
    tools = req.get("tools") or []
    system = req.get("system") or None
    weights = req.get("weights") or None
    max_tokens = int(req.get("max_new_tokens") or 512)
    kwargs = {}
    if system:
        kwargs["system"] = system
    if weights:
        kwargs["weights"] = weights
    agent = needle.Needle(tools=tools, **kwargs)
    try:
        res = agent.complete(text, max_new_tokens=max_tokens)
    finally:
        try:
            agent.close()
        except Exception:
            pass
    res = dict(res or {})
    res["success"] = True
    return res


def _extract(req):
    import needle

    ensure_engine()
    text = str(req.get("text") or "")
    schema = req.get("schema")
    if not text.strip():
        return {"success": False, "error": "Usage: provide text to extract from."}
    if not isinstance(schema, dict):
        return {"success": False, "error": "Usage: provide a JSON object schema."}
    system = req.get("system") or None
    weights = req.get("weights") or None
    max_tokens = int(req.get("max_new_tokens") or 512)
    strict = bool(req.get("strict", True))
    kwargs = {"strict": strict}
    if system is not None:
        kwargs["system"] = system
    if weights is not None:
        kwargs["weights"] = weights
    try:
        out = needle.extract(text, schema, max_new_tokens=max_tokens, **kwargs)
    except TypeError:
        # Older engine: no strict kwarg.
        kwargs.pop("strict", None)
        out = needle.extract(text, schema, max_new_tokens=max_tokens, **kwargs)
    if out is None:
        return {"success": True, "result": None, "refused": True}
    if hasattr(out, "model_dump"):
        return {"success": True, "result": out.model_dump(), "refused": False}
    if hasattr(out, "dict"):
        try:
            return {"success": True, "result": out.dict(), "refused": False}
        except Exception:
            pass
    return {"success": True, "result": out, "refused": False}


def _embed(req):
    import needle

    ensure_engine()
    text = str(req.get("text") or "")
    if not text.strip():
        return {"success": False, "error": "Usage: provide text to embed."}
    weights = req.get("weights") or None
    kwargs = {}
    if weights:
        kwargs["weights"] = weights
    agent = needle.Needle(**kwargs)
    try:
        vec = agent.embed(text)
    finally:
        try:
            agent.close()
        except Exception:
            pass
    return {"success": True, "embedding": list(vec), "dim": len(vec)}


def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        sys.stdout.write(json.dumps({"success": False, "error": f"Invalid bridge request: {exc}"}))
        return 0
    mode = str(req.get("mode") or "complete").lower()
    try:
        if mode == "status":
            res = _status()
        elif mode == "complete":
            res = _complete(req)
        elif mode == "extract":
            res = _extract(req)
        elif mode == "embed":
            res = _embed(req)
        else:
            res = {"success": False, "error": f"Unknown bridge mode: {mode}"}
    except Exception as exc:
        res = {"success": False, "error": f"needle error: {exc}"}
    sys.stdout.write(json.dumps(res, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

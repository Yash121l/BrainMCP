// The one hook that survives on a machine: PostToolUse telemetry.
//
// Everything else the vault used to do with local shell scripts (session
// bootstrap, rules, skills, decisions, saves) now comes from the MCP server, so
// it works identically on a laptop, a VPS, and claude.ai. Tool-call telemetry
// is the exception: only a hook-capable client can see tool calls at all.
//
// Served as a self-extracting installer from GET /hooks/install.sh:
//   curl -fsSL -H "Authorization: Bearer $KEY" https://<host>/hooks/install.sh | sh

export const HOOK_VERSION = '1';

/** The hook script itself. Records are redacted here, before they leave the machine. */
function hookScript(origin) {
  return `#!/usr/bin/env bash
# BrainMCP telemetry hook (PostToolUse) — version ${HOOK_VERSION}
# Appends one redacted record per tool call to a local spool, then flushes the
# spool to the brain from a detached background process. Never blocks the agent
# and never fails a tool call: every path exits 0.
set -uo pipefail

BRAIN_URL="\${BRAIN_URL:-${origin}}"
BRAIN_HOOK_VERSION="${HOOK_VERSION}"
CRED="\${BRAIN_CREDENTIALS:-$HOME/.config/brain-mcp/credentials}"
# shellcheck disable=SC1090
[ -f "$CRED" ] && . "$CRED" 2>/dev/null
KEY="\${BRAIN_KEY:-\${BRAIN_TOKEN:-}}"
[ -n "$KEY" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

SPOOL="\${BRAIN_SPOOL:-\${TMPDIR:-/tmp}/brain-spool}"
mkdir -p "$SPOOL" 2>/dev/null || exit 0

INPUT="$(cat 2>/dev/null || true)"
[ -n "$INPUT" ] || exit 0

DECISION="$(BRAIN_INPUT="$INPUT" BRAIN_SPOOL="$SPOOL" BRAIN_FALLBACK_CWD="$(pwd 2>/dev/null || echo "")" \\
  BRAIN_SURFACE="\${BRAIN_SURFACE:-claude-code}" python3 -c "$(cat <<'PYAPPEND'
${PY_APPEND}
PYAPPEND
)" 2>/dev/null || echo "")"

if [ "$DECISION" = "flush" ]; then
  (
    BRAIN_SPOOL="$SPOOL" BRAIN_URL="$BRAIN_URL" BRAIN_KEY="$KEY" python3 -c "$(cat <<'PYFLUSH'
${PY_FLUSH}
PYFLUSH
)"
  ) >/dev/null 2>&1 &
fi
exit 0
`;
}

// Redact first, spool second, and only then decide whether to flush. A record
// that never matches a pattern still passes through the same path, so there is
// no "fast path" that skips scrubbing.
const PY_APPEND = String.raw`
import json, os, re, sys, time, glob

FLUSH_AT = 25
MAX_SPOOL_LINES = 5000

PATTERNS = [
    (re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----'), '<REDACTED>'),
    (re.compile(r'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'), '<REDACTED>'),
    (re.compile(r'(?i)\b(authorization\s*:\s*(?:bearer|token|basic))\s+\S+'), r'\1 <REDACTED>'),
    (re.compile(r'(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{12,}'), 'bearer <REDACTED>'),
    (re.compile(r'\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}'), '<REDACTED>'),
    (re.compile(r'\bgh[pousr]_[A-Za-z0-9]{16,}'), '<REDACTED>'),
    (re.compile(r'\bxox[abprse]-[A-Za-z0-9-]{10,}'), '<REDACTED>'),
    (re.compile(r'\bAKIA[0-9A-Z]{16}\b'), '<REDACTED>'),
    (re.compile(r'(?i)(--(?:password|token|secret|api-key|apikey)[= ])\S+'), r'\1<REDACTED>'),
    (re.compile(r'(?i)\b([A-Za-z0-9_]*(?:secret|token|passwd|password|api[_-]?key|apikey|access[_-]?key)[A-Za-z0-9_]*)(\s*[:=]\s*)["\x27]?[^\s"\x27&;|]{8,}'), r'\1\2<REDACTED>'),
    (re.compile(r'\b[0-9a-fA-F]{48,}\b'), '<REDACTED>'),
]


def redact(v):
    if isinstance(v, str):
        for pat, rep in PATTERNS:
            v = pat.sub(rep, v)
        return v
    if isinstance(v, dict):
        return {k: redact(x) for k, x in v.items()}
    if isinstance(v, list):
        return [redact(x) for x in v]
    return v


def detect_slug(cwd):
    """Project slug = the MAIN checkout's directory name, so a linked worktree
    resolves to the project it belongs to. Empty in $HOME or outside any repo."""
    home = os.path.expanduser("~")
    try:
        d = os.path.realpath(cwd)
    except Exception:
        return ""
    if not d or d == os.path.realpath(home):
        return ""
    while True:
        g = os.path.join(d, ".git")
        if os.path.isdir(g):
            return os.path.basename(d)
        if os.path.isfile(g):
            try:
                line = open(g, encoding="utf-8").read().strip()
            except OSError:
                return os.path.basename(d)
            if line.startswith("gitdir:"):
                gd = line.split(":", 1)[1].strip()
                if not os.path.isabs(gd):
                    gd = os.path.join(d, gd)
                gd = os.path.realpath(gd)
                marker = os.sep + ".git" + os.sep + "worktrees" + os.sep
                if marker in gd:
                    return os.path.basename(gd.split(marker)[0])
            return os.path.basename(d)
        parent = os.path.dirname(d)
        if parent == d or d == os.path.realpath(home):
            return ""
        d = parent


try:
    data = json.loads(os.environ.get("BRAIN_INPUT", "") or "{}")
except Exception:
    data = {}

sid = "".join(c for c in str(data.get("session_id", "") or "") if c.isalnum() or c in "-_")[:40]
if not sid:
    sys.exit(0)

tool = data.get("tool_name") or data.get("tool") or "unknown"
ti = data.get("tool_input", {}) or {}

summary = {}
if tool == "Bash":
    summary["command"] = (ti.get("command") or "")[:500]
elif tool in ("Edit", "Write", "Read", "NotebookEdit"):
    summary["path"] = ti.get("file_path") or ti.get("notebook_path")
elif tool in ("WebFetch", "WebSearch"):
    summary["url"] = ti.get("url")
    summary["query"] = ti.get("query") or ti.get("prompt")
elif str(tool).startswith("mcp__"):
    parts = str(tool).split("__")
    summary["mcp_server"] = parts[1] if len(parts) > 1 else ""
    summary["mcp_action"] = parts[2] if len(parts) > 2 else ""
    summary["args"] = {k: v for k, v in ti.items()
                       if isinstance(v, (str, int, float, bool)) and len(str(v)) < 120}
else:
    summary["args"] = {k: v for k, v in ti.items()
                       if isinstance(v, (str, int, float, bool)) and len(str(v)) < 120}

cwd = str(data.get("cwd") or os.environ.get("BRAIN_FALLBACK_CWD", "") or "")

rec = {
    "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "session": sid,
    "surface": os.environ.get("BRAIN_SURFACE", "claude-code"),
    "cwd": cwd[:300],
    "project": detect_slug(cwd),
    "tool": tool,
}
rec.update(redact(summary))

spool = os.environ["BRAIN_SPOOL"]
path = os.path.join(spool, sid + ".jsonl")
try:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    with open(path, "rb") as f:
        lines = sum(1 for _ in f)
except OSError:
    sys.exit(0)

# A spool that never drains (offline for days) must not grow without bound.
if lines > MAX_SPOOL_LINES:
    try:
        os.replace(path, os.path.join(spool, "%s.%d.batch" % (sid, int(time.time()))))
    except OSError:
        pass
    print("flush")
    sys.exit(0)

pending = glob.glob(os.path.join(spool, "*.batch"))
print("flush" if lines >= FLUSH_AT or pending else "")
`;

// Rotate, then POST every pending batch. A batch is deleted only on a 2xx, so a
// failed flush is retried on the next tool call rather than dropped.
const PY_FLUSH = String.raw`
import json, os, glob, time, urllib.request, urllib.error

spool = os.environ["BRAIN_SPOOL"]
url = os.environ["BRAIN_URL"].rstrip("/") + "/ingest/tool-calls"
key = os.environ["BRAIN_KEY"]
MAX_AGE = 7 * 86400
CHUNK = 400

for live in glob.glob(os.path.join(spool, "*.jsonl")):
    try:
        os.replace(live, "%s.%d.batch" % (live[:-6], int(time.time())))
    except OSError:
        pass

for batch in sorted(glob.glob(os.path.join(spool, "*.batch"))):
    try:
        if time.time() - os.path.getmtime(batch) > MAX_AGE:
            os.remove(batch)
            continue
        with open(batch, encoding="utf-8") as f:
            records = [json.loads(l) for l in f if l.strip()]
    except (OSError, ValueError):
        try:
            os.remove(batch)
        except OSError:
            pass
        continue
    if not records:
        try:
            os.remove(batch)
        except OSError:
            pass
        continue

    ok = True
    for i in range(0, len(records), CHUNK):
        body = json.dumps({"records": records[i:i + CHUNK]}).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                if r.status // 100 != 2:
                    ok = False
                    break
        except Exception:
            ok = False
            break
    if ok:
        try:
            os.remove(batch)
        except OSError:
            pass
`;

/**
 * The installer: drops the hook, registers it in settings.json, and stores the
 * key. Idempotent — re-running it upgrades an older hook in place.
 */
export function hookInstaller(origin) {
  const script = hookScript(origin)
    .replace('${PY_APPEND}', PY_APPEND.trim())
    .replace('${PY_FLUSH}', PY_FLUSH.trim());

  const b64 = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/(.{76})/g, '$1\n');
  };

  return `#!/bin/sh
# BrainMCP telemetry hook installer (hook version ${HOOK_VERSION})
# Re-run any time to upgrade; it overwrites the hook and leaves everything else alone.
set -eu

: "\${HOOK_DEST:=$HOME/.claude/hooks}"
: "\${SETTINGS:=$HOME/.claude/settings.json}"
: "\${CRED:=$HOME/.config/brain-mcp/credentials}"

if printf QQ== | base64 -d >/dev/null 2>&1; then B64D=-d; else B64D=-D; fi
mkdir -p "$HOOK_DEST" "$(dirname "$CRED")"

base64 $B64D > "$HOOK_DEST/brain-telemetry.sh" <<'B64_EOF'
${b64(script)}
B64_EOF
chmod +x "$HOOK_DEST/brain-telemetry.sh"
echo "hook  -> $HOOK_DEST/brain-telemetry.sh (version ${HOOK_VERSION})"

if [ -n "\${BRAIN_KEY:-}" ]; then
  umask 077
  printf 'BRAIN_KEY=%s\\n' "$BRAIN_KEY" > "$CRED"
  echo "key   -> $CRED"
elif [ -f "$CRED" ]; then
  echo "key   -> $CRED (kept)"
else
  echo "key   -> NOT SET. Re-run with BRAIN_KEY=<key> or write it to $CRED yourself." >&2
fi

python3 - "$SETTINGS" "$HOOK_DEST/brain-telemetry.sh" <<'PY'
import json, os, sys

settings_path, hook_path = sys.argv[1], sys.argv[2]
try:
    with open(settings_path, encoding="utf-8") as f:
        settings = json.load(f)
except (OSError, ValueError):
    settings = {}

hooks = settings.setdefault("hooks", {})
entries = hooks.setdefault("PostToolUse", [])

# Drop any previous brain hook (this one, or the retired vault-checkout hook)
# so re-running never double-registers and never leaves the old one behind.
stale = ("brain-telemetry.sh", "post-tool-use.sh")
for entry in entries:
    entry["hooks"] = [h for h in entry.get("hooks", [])
                      if not any(s in str(h.get("command", "")) for s in stale)]
entries[:] = [e for e in entries if e.get("hooks")]
entries.append({"matcher": "*", "hooks": [{"type": "command", "command": hook_path}]})

# The vault's SessionStart hook is dead: get_context replaces it on every surface.
starts = hooks.get("SessionStart", [])
for entry in starts:
    entry["hooks"] = [h for h in entry.get("hooks", [])
                      if "session-start.sh" not in str(h.get("command", ""))]
hooks["SessionStart"] = [e for e in starts if e.get("hooks")]
if not hooks["SessionStart"]:
    del hooks["SessionStart"]

os.makedirs(os.path.dirname(settings_path) or ".", exist_ok=True)
with open(settings_path, "w", encoding="utf-8") as f:
    json.dump(settings, f, indent=2)
    f.write("\\n")
print("hooks -> %s (PostToolUse registered, stale brain hooks removed)" % settings_path)
PY

echo
echo "Next: point Claude Code at the brain from any directory —"
echo "  claude mcp add --scope user --transport http brain ${origin}/mcp \\\\"
echo "    --header \\"Authorization: Bearer \\$BRAIN_KEY\\""
`;
}

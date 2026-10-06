// Which agent may call which upstream tool. Pure functions; gateway.js loads the
// inputs from D1. The order of decision:
//   1. a matching forbid rule denies;
//   2. a permit, approve or share grant must cover the tool. Destructive and critical
//      tools need a rule that names their risk or the tool itself: a wildcard
//      permit never reaches them;
//   3. critical tools, approve rules, and egress after untrusted + private input all
//      need a human approval;
//   4. nothing else is allowed.

export const RISKS = ['read', 'write', 'destructive', 'critical'];

/** The rules decide() always applies, for display next to the user's own. */
export const BUILTIN_RULES = [
  { effect: 'deny', text: 'Anything no rule permits is denied.' },
  { effect: 'deny', text: 'Destructive and critical tools need a rule that names their risk or the tool itself; a wildcard never reaches them.' },
  { effect: 'approve', text: 'Critical tools always need a human approval.' },
  { effect: 'approve', text: 'A tool that sends data out needs approval after the agent read untrusted and private data, or output that looked like an injection.' },
];
export const EFFECTS = ['permit', 'forbid', 'approve'];
const SUBJECT_KEYS = ['keys', 'machines', 'machine_tags', 'agents', 'agent_tags'];
const RESOURCE_KEYS = ['connections', 'services', 'tools', 'risks'];
const LIST_MAX = 50;

const READ_VERBS = new Set(['get', 'list', 'search', 'read', 'fetch', 'find', 'query', 'describe', 'whoami', 'view', 'show', 'lookup', 'count', 'check', 'retrieve', 'browse', 'download', 'export', 'preview', 'inspect', 'summarize', 'summarise']);
const DESTRUCTIVE_VERBS = new Set(['delete', 'remove', 'destroy', 'archive', 'revoke', 'truncate', 'wipe', 'overwrite', 'trash', 'empty', 'purge', 'drop', 'erase', 'unpublish', 'unshare', 'kick', 'ban']);
const CRITICAL_VERBS = new Set(['send', 'forward', 'reply', 'post', 'publish', 'deploy', 'merge', 'pay', 'payment', 'transfer', 'invite', 'share', 'push', 'execute', 'exec', 'run', 'schedule', 'grant', 'approve', 'transfer', 'release', 'tweet', 'email', 'sms', 'call']);
const WRITE_VERBS = new Set(['create', 'add', 'update', 'set', 'edit', 'put', 'patch', 'write', 'upload', 'move', 'rename', 'copy', 'save', 'insert', 'upsert', 'append', 'mark', 'label', 'react', 'comment', 'assign', 'close', 'open', 'start', 'stop', 'cancel', 'draft', 'generate', 'use']);
const PRIVILEGE_NOUNS = new Set(['collaborator', 'collaborators', 'permission', 'permissions', 'owner', 'owners', 'admin', 'admins', 'role', 'roles', 'member', 'members']);
const ORDER = { read: 0, write: 1, destructive: 2, critical: 3 };
// A message verb aimed at one of these stays inside the app (post_comment, reply_to_note, send_reaction).
const SOFT_OBJECTS = new Set(['draft', 'drafts', 'comment', 'comments', 'note', 'notes', 'reaction', 'reactions']);

const nameWords = (name) => String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Risk from the tool name alone: the first verb decides (slack_read_channel is a read, get_merge_status too). */
function nameRisk(name) {
  const words = nameWords(name);
  for (const w of words) {
    if (READ_VERBS.has(w)) return 'read';
    if (DESTRUCTIVE_VERBS.has(w)) return 'destructive';
    if (CRITICAL_VERBS.has(w)) return words.some((x) => SOFT_OBJECTS.has(x)) ? 'write' : 'critical';
    if (WRITE_VERBS.has(w)) return words.some((x) => PRIVILEGE_NOUNS.has(x)) ? 'critical' : 'write';
  }
  return null;
}

/**
 * Default risk tier for an upstream tool, from its name and MCP annotations. The console
 * can override it. Annotations are claims by the upstream server, so they can raise a
 * tier but never lower a dangerous name: send_message stays critical even when the
 * server marks it read-only.
 */
export function deriveRisk(tool) {
  const a = tool?.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
  const byName = nameRisk(tool?.name);
  let risk = byName || 'write';
  if (a.destructiveHint === true && ORDER[risk] < ORDER.destructive) risk = 'destructive';
  if (a.readOnlyHint === true && a.destructiveHint !== true && (byName === null || byName === 'read' || byName === 'write')) risk = 'read';
  return risk;
}

/** Wildcard match with `*` only, in linear time (no regular expression, so no backtracking). */
export function globMatch(pattern, value) {
  const p = String(pattern);
  const s = String(value ?? '');
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] !== '*' && p[pi] === s[si]) { pi++; si++; } else if (pi < p.length && p[pi] === '*') { star = pi++; mark = si; } else if (star !== -1) { pi = star + 1; si = ++mark; } else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}
const glob = globMatch;

const anyOf = (list, test) => !list?.length || list.some(test);
const overlap = (list, have) => anyOf(list, (x) => have.includes(x));

export function subjectMatches(subject, who) {
  const s = subject || {};
  return anyOf(s.keys, (k) => k === who.keyId)
    && anyOf(s.machines, (m) => glob(m, who.machine?.name))
    && overlap(s.machine_tags, who.machine?.tags || [])
    && anyOf(s.agents, (a) => glob(a, who.agent))
    && overlap(s.agent_tags, who.agentTags || []);
}

export function resourceMatches(resource, conn, tool) {
  const r = resource || {};
  return anyOf(r.connections, (c) => glob(c, conn.id))
    && anyOf(r.services, (s) => glob(s, conn.service))
    && anyOf(r.tools, (t) => glob(t, tool.name))
    && anyOf(r.risks, (k) => k === tool.risk);
}

/** Does this rule reach a high-risk tool explicitly (by risk tier or a non-wildcard tool name)? */
function namesHighRisk(rule, tool) {
  const r = rule.resource || {};
  return (r.risks || []).includes(tool.risk) || (r.tools || []).some((t) => !String(t).includes('*') && t === tool.name);
}

/**
 * The decision for one call.
 *   who:   { keyId, machine: { name, tags }, agent, agentTags }
 *   conn:  { id, service }
 *   tool:  { name, risk, egress }
 *   rules: rule rows already parsed (subject/resource objects), owned by the caller or global
 *   grant: null for your own connection, or { tools: [] } for one shared with you
 *   taint: Set of labels this key carries ('untrusted', 'private', 'flagged')
 *   approved: a matching human approval exists
 * Returns { decision: 'allow' | 'deny' | 'approval', reason, rule }.
 */
export function decide({ who, conn, tool, rules = [], grant = null, taint = new Set(), approved = false }) {
  const live = rules.filter((r) => r.enabled !== 0 && r.enabled !== false && subjectMatches(r.subject, who) && resourceMatches(r.resource, conn, tool));
  const forbid = live.find((r) => r.effect === 'forbid');
  if (forbid) return { decision: 'deny', reason: 'a forbid rule matches', rule: forbid.id };

  const highRisk = tool.risk === 'destructive' || tool.risk === 'critical';
  const covering = live.filter((r) => (r.effect === 'permit' || r.effect === 'approve') && (!highRisk || namesHighRisk(r, tool)));
  let viaGrant = false;
  if (grant) {
    const listed = (grant.tools || []).includes(tool.name);
    viaGrant = listed || (!(grant.tools || []).length && tool.risk === 'read');
    if (!viaGrant) return { decision: 'deny', reason: 'the share does not include this tool' };
  }
  if (!covering.length && !viaGrant) {
    return { decision: 'deny', reason: highRisk ? `no rule names ${tool.risk} tools on this connection` : 'no rule permits this tool for this agent' };
  }

  const reasons = [];
  if (tool.risk === 'critical') reasons.push('critical tool');
  const approveRule = live.find((r) => r.effect === 'approve');
  if (approveRule) reasons.push('an approve rule matches');
  if (tool.egress && taint.has('untrusted') && taint.has('private')) reasons.push('egress after untrusted and private input');
  if (tool.egress && taint.has('flagged')) reasons.push('egress after output that looked like an injection');
  const rule = (approveRule || covering[0])?.id || null;
  if (reasons.length && !approved) return { decision: 'approval', reason: reasons.join('; '), rule };
  return { decision: 'allow', reason: reasons.length ? `approved: ${reasons.join('; ')}` : 'permitted', rule };
}

function cleanList(v, field, test) {
  if (v == null) return undefined;
  if (!Array.isArray(v)) throw new Error(`${field} must be an array`);
  const out = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
  if (v.length && !out.length) throw new Error(`${field} has only blank entries; remove it to mean "any"`);
  if (out.length > LIST_MAX) throw new Error(`${field} has more than ${LIST_MAX} entries; split the rule`);
  for (const x of out) {
    if (x.length > 80) throw new Error(`${field} entries must be 80 characters or fewer`);
    if (test && !test(x)) throw new Error(`${field} has an invalid entry: ${x}`);
  }
  return out.length ? out : undefined;
}

/** Validate a rule from the console. Returns { effect, subject, resource, note }. */
export function normalizeRule(input) {
  const effect = String(input?.effect || '');
  if (!EFFECTS.includes(effect)) throw new Error(`effect must be one of ${EFFECTS.join(', ')}`);
  for (const [part, keys] of [['subject', SUBJECT_KEYS], ['resource', RESOURCE_KEYS]]) {
    const v = input?.[part];
    if (v == null) continue;
    if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${part} must be an object`);
    const unknown = Object.keys(v).filter((k) => !keys.includes(k));
    if (unknown.length) throw new Error(`unknown ${part} field ${unknown[0]}; use ${keys.join(', ')}`);
  }
  const subject = {};
  for (const k of SUBJECT_KEYS) {
    const v = cleanList(input?.subject?.[k], `subject.${k}`);
    if (v) subject[k] = v;
  }
  const resource = {};
  for (const k of RESOURCE_KEYS) {
    const v = cleanList(input?.resource?.[k], `resource.${k}`, k === 'risks' ? (x) => RISKS.includes(x) : null);
    if (v) resource[k] = v;
  }
  return { effect, subject, resource, note: input?.note ? String(input.note).slice(0, 300) : null };
}

const SECRET_WORDS = '(?:secret|password|passcode|token|credential|credentials|api[_ -]?key|private key|seed phrase)';
const INJECTION = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+|these\s+|those\s+)?(?:previous|prior|above|earlier|preceding|original|system)\s+(?:instructions?|prompts?|rules|directions|directives|guidelines)/i,
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:the\s+|your\s+)?(?:instructions?|prompts?|rules)\s+(?:above|before|so far)/i,
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:of\s+)?your\s+(?:instructions?|prompts?|rules|guidelines|system prompt)/i,
  /\bforget\s+(?:everything|all)\s+(?:you\s+(?:were|have been|got)\s+told|above|before|so far)/i,
  /\byou are now (?:in (?:developer|god|dan|jailbreak) mode|(?:a|an) (?!member\b|part\b|subscriber\b|owner\b|admin|participant\b|registered\b|customer\b|user\b|attendee\b|guest\b)\w+)/i,
  /<\|?(?:im_start|system|endoftext)\|?>/i,
  /\bnew instructions?:\s*(?:ignore|forward|send|reply|email|call|run|execute|delete|you must|do not|from now on|always)/i,
  new RegExp(`(?:^|[.!?\\n]\\s*|\\bplease\\s+)(?:send|forward|email|post|upload|share|paste|leak|exfiltrate)\\s+(?:me\\s+)?(?:the|all|every|your|my|any)\\s+.{0,40}?${SECRET_WORDS}`, 'im'),
  new RegExp(`\\b(?:must|should|need to|has to)\\s+(?:send|forward|email|post|upload|share|leak)\\s+(?:the|all|every|your|my|any)\\s+.{0,40}?${SECRET_WORDS}`, 'i'),
];

/** A cheap screen for prompt-injection phrasing in upstream output. A hit taints the key as 'flagged'. */
export function looksInjected(text) {
  const t = String(text || '').slice(0, 200000);
  return INJECTION.some((re) => re.test(t));
}

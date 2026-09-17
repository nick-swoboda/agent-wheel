'use strict';

const IDEA_CLAIMS = ['problem', 'solution'];

function claimsOf(kind, content) {
  if (!content) return [];
  switch (kind) {
    case 'idea':
      return IDEA_CLAIMS.map((id) => ({ id, text: String(content[id] || '') }));
    case 'experience':
      return (content.acceptance || []).map((a) => ({ id: a.id, text: String(a.criterion) }));
    case 'design':
      return [
        ...(content.screens || []).map((s) => ({ id: s.id, text: `${s.name}: ${(s.contents || []).join('; ')}` })),
        ...(content.visual || []).map((v) => ({ id: v.id, text: String(v.rule) })),
        ...(content.states || []).map((t) => ({ id: t.id, text: `${t.screen} ${t.state} -> ${t.transition}` })),
        ...(content.interactions || []).map((i) => ({ id: i.id, text: `${i.screen}: ${i.rule}` })),
        ...(content.content || []).map((n) => ({ id: n.id, text: String(n.rule) })),
        ...(content.acceptance || []).map((d) => ({ id: d.id, text: String(d.criterion) })),
      ];
    case 'spec':
      return [
        ...(content.requirements || []).map((r) => ({ id: r.id, text: String(r.requirement) })),
        ...(content.constraints || []).map((c) => ({ id: c.id, text: String(c.constraint) })),
        ...(content.release ? [{ id: 'release', text: JSON.stringify(content.release) }] : []),
      ];
    default:
      return [];
  }
}

function claimIds(kind, content) {
  return claimsOf(kind, content).map((c) => c.id);
}

function claimKind(id) {
  if (IDEA_CLAIMS.includes(id)) return 'idea';
  if (/^A[0-9]+$/.test(id)) return 'experience';
  if (/^[SVTIND][0-9]+$/.test(id)) return 'design';
  if (/^[RC][0-9]+$/.test(id) || id === 'release') return 'spec';
  return null;
}

function diffClaims(kind, prevContent, nextContent) {
  const before = new Map(claimsOf(kind, prevContent).map((c) => [c.id, c.text]));
  const after = new Map(claimsOf(kind, nextContent).map((c) => [c.id, c.text]));
  const changed = [];
  const removed = [];
  const added = [];
  const unchanged = [];
  for (const [id, text] of before) {
    if (!after.has(id)) removed.push(id);
    else if (after.get(id) !== text) changed.push(id);
    else unchanged.push(id);
  }
  for (const id of after.keys()) if (!before.has(id)) added.push(id);
  return { changed, removed, added, unchanged };
}

module.exports = { IDEA_CLAIMS, claimsOf, claimIds, claimKind, diffClaims };

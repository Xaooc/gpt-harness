function requestState(task) {
  return {
    task, legacy: !!task && task.version !== 2, items: [], links: {}, waivers: [], crosschecks: [],
    delivered: false, delivery: null
  };
}

function addOutcome(request, outcomes, record) {
  // Waivers need their own quote-verified record.
  const item = { ...record, revision: 1, status: record.status === 'done' ? 'done' : 'open',
    evidence: [], previousEvidence: [], amendments: [], pending: null, resolution: null };
  request.items.push(item);
  outcomes.set(item.id, { request, item });
  if (!request.legacy || record.taskId !== undefined) {
    for (const clause of record.sources || []) {
      if (!/^M\d+$/.test(clause)) request.links[clause] = { type: 'link', clause, item: item.id };
    }
  }
}

function applyOutcomeRecord(item, record) {
  if (!item || (record.revision ?? item.revision) !== item.revision) return;
  if (record.type === 'amend') {
    item.amendments.push(record);
    item.text = record.text;
    if (record.paths !== undefined) item.paths = record.paths;
    item.sources = [...new Set([...(item.sources || []), record.source])];
    item.revision++;
    item.previousEvidence.push(...item.evidence);
    item.evidence = [];
    item.status = 'open';
    item.pending = null;
    item.resolution = null;
  } else if (record.type === 'evidence') {
    item.evidence.push(record);
  } else if (record.type === 'done') {
    item.status = 'done';
    item.pending = null;
  } else if (record.type === 'pending-owner') {
    item.status = 'pending-owner';
    item.pending = record;
  } else if (record.type === 'pending-resolution' && item.pending && ['accepted', 'needs-work'].includes(record.result)) {
    item.status = record.result === 'accepted' ? 'done' : 'superseded';
    item.pending = null;
    item.resolution = record;
  }
}

function compareMessages(a, b) {
  return a.offset - b.offset || Number(a.id.slice(1)) - Number(b.id.slice(1));
}

export function latestMessages(records) {
  const messages = new Map();
  for (const record of records) if (record.type === 'message') messages.set(record.id, record);
  return messages;
}

export function clauseHints(state, messages) {
  const items = new Set(state.items.map((item) => item.id));
  return messages.flatMap((message) => message.clauses || []).filter(({ id }) => {
    const link = Object.hasOwn(state.links, id) ? state.links[id] : null;
    return !link || (link.item === 'none' ? !link.reason?.trim() : !items.has(link.item));
  });
}

function finishRequest(state, messages) {
  const items = new Map(state.items.map((item) => [item.id, item]));
  for (const waiver of state.waivers) {
    const item = items.get(waiver.target);
    if (item && waiver.verified === true && (waiver.revision ?? 1) === item.revision) {
      item.status = 'waived';
      item.pending = null;
    }
  }
  return { ...state, messages, hints: clauseHints(state, messages),
    pending: state.items.flatMap((item) => item.pending ? [item.pending] : []),
    ready: !!state.task && state.items.filter((item) => item.status !== 'superseded')
      .every((item) => ['done', 'waived', 'pending-owner'].includes(item.status)),
    crosscheck: state.crosschecks.at(-1) || null,
    gateWaived: state.waivers.some((waiver) => waiver.target === 'gate' && waiver.verified === true) };
}

// Fold append order without reading the transcript or mutating the supplied records.
export function foldLedger(records) {
  const messages = latestMessages(records), requests = new Map(), outcomes = new Map(), temps = [];
  let current = null;
  for (const record of records) {
    if (record.type === 'start') {
      current = requestState(record);
      requests.set(record.id, current);
      continue;
    }
    if (record.type === 'message') continue;
    if (record.type === 'tmp') {
      temps.push(record.path);
      continue;
    }
    const request = record.taskId === undefined ? current : requests.get(record.taskId);
    if (!request) continue;
    if (record.type === 'item') addOutcome(request, outcomes, record);
    else if (record.type === 'link') request.links[record.clause] = record;
    else if (record.type === 'waive') request.waivers.push(record);
    else if (record.type === 'crosscheck') request.crosschecks.push(record);
    else if (record.type === 'delivered') {
      request.delivered = true;
      request.delivery = record;
    } else {
      const target = outcomes.get(record.item);
      if (!target || (target.request !== request && (record.type !== 'pending-resolution' || record.taskId !== undefined))) continue;
      const { item } = target;
      applyOutcomeRecord(item, record);
      const successor = record.successor;
      if (successor && item?.resolution === record && requests.has(successor.taskId)) {
        addOutcome(requests.get(successor.taskId), outcomes, successor);
      }
    }
  }
  const allMessages = [...messages.values()].sort(compareMessages);
  const history = [...requests.values()];
  const boundaries = history.map(({ task }) => messages.get(task.messageId) || { offset: task.offset, id: 'M0' });
  const states = history.map((state, index) => finishRequest(state, allMessages.filter((message) =>
    compareMessages(message, boundaries[index]) >= 0
    && (!boundaries[index + 1] || compareMessages(message, boundaries[index + 1]) < 0))));
  return { ...(states.pop() || finishRequest(requestState(null), allMessages)), archived: states, allMessages, temps };
}

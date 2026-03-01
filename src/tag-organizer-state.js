export const SORT_MODE = Object.freeze({
  ALPHABETICAL: 'alphabetical',
  COUNT: 'count',
});

export const SORT_DIRECTION = Object.freeze({
  ASC: 'asc',
  DESC: 'desc',
});

export const GROUP_SORT_MODE = Object.freeze({
  ADD_ORDER: 'add-order',
  ALPHABETICAL: 'alphabetical',
  COUNT: 'count',
});

export const AUTOREMOVE_GROUP_ID = '__tag-org-autoremove__';

function normalizeName(value) {
  return String(value || '').trim();
}

function nameKey(value) {
  return normalizeName(value).toLowerCase();
}

export function getTokenKey(token) {
  if (token?.id) {
    return `id:${token.id}`;
  }

  return `name:${nameKey(token?.name)}`;
}

function copyToken(token) {
  const normalizedName = normalizeName(token?.name);

  return {
    id: token?.id || null,
    key: getTokenKey(token),
    name: normalizedName || '(Unnamed tag)',
    count: Number(token?.count) || 0,
    exists: token?.exists === true,
    color: String(token?.color || ''),
    color2: String(token?.color2 || ''),
  };
}

function buildSystemCounts(tagMap) {
  const counts = new Map();
  const allTagIds = Object.values(tagMap || {}).flat();

  for (const tagId of allTagIds) {
    counts.set(tagId, (counts.get(tagId) || 0) + 1);
  }

  return counts;
}

export function buildSystemTags(tags, tagMap) {
  const counts = buildSystemCounts(tagMap);
  const byId = new Map();
  const byName = new Map();

  const list = (Array.isArray(tags) ? tags : []).map((tag) => {
    const item = copyToken({
      id: tag?.id,
      name: tag?.name,
      color: tag?.color,
      color2: tag?.color2,
      exists: true,
      count: counts.get(tag?.id) || 0,
    });

    byId.set(item.id, item);
    byName.set(nameKey(item.name), item);

    return item;
  });

  return { list, byId, byName };
}

function resolveStoredToken(storedToken, systemTags) {
  const storedId = storedToken?.id ? String(storedToken.id) : null;
  const storedName = normalizeName(storedToken?.name);

  if (storedId && systemTags.byId.has(storedId)) {
    return copyToken(systemTags.byId.get(storedId));
  }

  if (storedName && systemTags.byName.has(nameKey(storedName))) {
    return copyToken(systemTags.byName.get(nameKey(storedName)));
  }

  return copyToken({
    id: storedId,
    name: storedName,
    count: 0,
    exists: false,
  });
}

export function loadGroupsFromSettings(savedGroups, systemTags) {
  const groups = [];
  const occupied = new Set();

  for (const rawGroup of Array.isArray(savedGroups) ? savedGroups : []) {
    const isStoredAutoremove = rawGroup?.specialGroup === 'autoremove' || rawGroup?.groupType === 'autoremove';
    if (isStoredAutoremove) {
      const members = [];
      const rawMembers = Array.isArray(rawGroup?.tags) ? rawGroup.tags : [];

      for (const rawMember of rawMembers) {
        const memberToken = resolveStoredToken(rawMember, systemTags);
        const memberKey = getTokenKey(memberToken);

        if (!memberToken.name || occupied.has(memberKey)) {
          continue;
        }

        occupied.add(memberKey);
        members.push(memberToken);
      }

      groups.push({
        id: AUTOREMOVE_GROUP_ID,
        groupToken: {
          id: null,
          key: 'autoremove-root',
          name: 'Autoremove',
          count: 0,
          exists: true,
          color: '',
          color2: '',
        },
        members,
        createdAt: 0,
        isSpecial: true,
      });

      continue;
    }

    const groupToken = resolveStoredToken(rawGroup?.groupTag || rawGroup?.group || rawGroup?.token, systemTags);
    const groupTokenKey = getTokenKey(groupToken);

    if (!groupToken.name || occupied.has(groupTokenKey)) {
      continue;
    }

    occupied.add(groupTokenKey);

    const members = [];
    const rawMembers = Array.isArray(rawGroup?.tags) ? rawGroup.tags : [];
    for (const rawMember of rawMembers) {
      const memberToken = resolveStoredToken(rawMember, systemTags);
      const memberKey = getTokenKey(memberToken);

      if (!memberToken.name || memberKey === groupTokenKey || occupied.has(memberKey)) {
        continue;
      }

      occupied.add(memberKey);
      members.push(memberToken);
    }

    groups.push({
      id: `group-${groupTokenKey}-${groups.length}`,
      groupToken,
      members,
      createdAt: Date.now() + groups.length,
    });
  }

  return groups;
}

function getOccupiedKeys(groups) {
  const occupied = new Set();

  for (const group of groups) {
    occupied.add(getTokenKey(group.groupToken));
    for (const member of group.members) {
      occupied.add(getTokenKey(member));
    }
  }

  return occupied;
}

function compareByName(a, b) {
  return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' });
}

function applyDirection(compareFn, direction) {
  if (direction === SORT_DIRECTION.DESC) {
    return (a, b) => -compareFn(a, b);
  }

  return compareFn;
}

function compareTokens(mode, direction = SORT_DIRECTION.ASC) {
  if (mode === SORT_MODE.COUNT) {
    return applyDirection((a, b) => {
      if ((b?.count || 0) !== (a?.count || 0)) {
        return (b?.count || 0) - (a?.count || 0);
      }

      return compareByName(a, b);
    }, direction);
  }

  return applyDirection(compareByName, direction);
}

function includesQuery(token, query) {
  if (!query) {
    return true;
  }

  return String(token?.name || '').toLowerCase().includes(query);
}

export function getAvailableTags(systemTags, groups, sortMode, filterQuery = '', sortDirection = SORT_DIRECTION.ASC) {
  const occupied = getOccupiedKeys(groups);
  const query = String(filterQuery || '').trim().toLowerCase();

  return systemTags
    .filter((token) => !occupied.has(getTokenKey(token)))
    .filter((token) => includesQuery(token, query))
    .map(copyToken)
    .sort(compareTokens(sortMode, sortDirection));
}

function compareGroups(sortMode, direction = SORT_DIRECTION.ASC) {
  if (sortMode === GROUP_SORT_MODE.ALPHABETICAL) {
    return applyDirection((a, b) => compareByName(a?.groupToken, b?.groupToken), direction);
  }

  if (sortMode === GROUP_SORT_MODE.COUNT) {
    return applyDirection((a, b) => {
      if ((b?.groupToken?.count || 0) !== (a?.groupToken?.count || 0)) {
        return (b?.groupToken?.count || 0) - (a?.groupToken?.count || 0);
      }

      return compareByName(a?.groupToken, b?.groupToken);
    }, direction);
  }

  return applyDirection((a, b) => (a?.createdAt || 0) - (b?.createdAt || 0), direction);
}

export function getVisibleGroups(groups, sortMode, filterQuery = '', sortDirection = SORT_DIRECTION.ASC) {
  const query = String(filterQuery || '').trim().toLowerCase();

  const filtered = (Array.isArray(groups) ? groups : [])
    .filter((group) => {
      if (group.id === AUTOREMOVE_GROUP_ID) {
        return true;
      }
      
      if (!query) {
        return true;
      }

      if (includesQuery(group.groupToken, query)) {
        return true;
      }

      return (group.members || []).some((member) => includesQuery(member, query));
    });
  
  const autoremove = filtered.find((g) => g.id === AUTOREMOVE_GROUP_ID);
  const regular = filtered.filter((g) => g.id !== AUTOREMOVE_GROUP_ID);
  
  regular.sort(compareGroups(sortMode, sortDirection));
  
  return autoremove ? [...regular, autoremove] : regular;
}

export function findTokenInState(state, tokenKey) {
  for (const token of state.systemTags) {
    if (getTokenKey(token) === tokenKey) {
      return copyToken(token);
    }
  }

  for (const group of state.groups) {
    if (getTokenKey(group.groupToken) === tokenKey) {
      return copyToken(group.groupToken);
    }

    for (const member of group.members) {
      if (getTokenKey(member) === tokenKey) {
        return copyToken(member);
      }
    }
  }

  return null;
}

export function removeTokenFromGroups(groups, tokenKey) {
  let changed = false;

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    
    if (group.id === AUTOREMOVE_GROUP_ID) {
      const originalLength = group.members.length;
      group.members = group.members.filter((member) => getTokenKey(member) !== tokenKey);
      if (group.members.length !== originalLength) {
        changed = true;
      }
      continue;
    }
    
    if (getTokenKey(group.groupToken) === tokenKey) {
      groups.splice(index, 1);
      changed = true;
      continue;
    }

    const originalLength = group.members.length;
    group.members = group.members.filter((member) => getTokenKey(member) !== tokenKey);
    if (group.members.length !== originalLength) {
      changed = true;
    }
  }

  return changed;
}

export function createGroupFromToken(groups, token) {
  const tokenRef = copyToken(token);
  const tokenKey = getTokenKey(tokenRef);
  removeTokenFromGroups(groups, tokenKey);

  groups.push({
    id: `group-${tokenKey}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    groupToken: tokenRef,
    members: [],
    createdAt: Date.now(),
  });
}

export function moveTokenToGroup(groups, token, targetGroupId) {
  const targetBeforeMove = groups.find((group) => group.id === targetGroupId);
  if (!targetBeforeMove) {
    return;
  }

  const tokenRef = copyToken(token);
  const tokenKey = getTokenKey(tokenRef);

  if (getTokenKey(targetBeforeMove.groupToken) === tokenKey) {
    return;
  }

  removeTokenFromGroups(groups, tokenKey);

  const target = groups.find((group) => group.id === targetGroupId);
  if (!target) {
    return;
  }

  if (!target.members.some((member) => getTokenKey(member) === tokenKey)) {
    target.members.push(tokenRef);
  }
}

export function removeTokenFromSpecificGroup(groups, tokenKey, groupId) {
  const group = groups.find((item) => item.id === groupId);
  if (!group) {
    return false;
  }

  if (group.id === AUTOREMOVE_GROUP_ID) {
    const previousLength = group.members.length;
    group.members = group.members.filter((member) => getTokenKey(member) !== tokenKey);
    return group.members.length !== previousLength;
  }

  if (getTokenKey(group.groupToken) === tokenKey) {
    const index = groups.findIndex((item) => item.id === groupId);
    if (index !== -1) {
      groups.splice(index, 1);
      return true;
    }
    return false;
  }

  const previousLength = group.members.length;
  group.members = group.members.filter((member) => getTokenKey(member) !== tokenKey);
  return group.members.length !== previousLength;
}

export function removeTokenFromSystemState(state, tokenId) {
  const normalizedTarget = String(tokenId ?? '').trim();
  state.systemTags = state.systemTags.filter((token) => String(token?.id ?? '').trim() !== normalizedTarget);
}

export function serializeGroups(groups) {
  return groups.map((group) => {
    if (group.id === AUTOREMOVE_GROUP_ID) {
      return {
        specialGroup: 'autoremove',
        tags: group.members.map((member) => ({
          id: member.id,
          name: member.name,
        })),
      };
    }

    return {
      groupTag: {
        id: group.groupToken.id,
        name: group.groupToken.name,
      },
      tags: group.members.map((member) => ({
        id: member.id,
        name: member.name,
      })),
    };
  });
}

export function ensureAutoremoveGroup(groups, systemTags) {
  const existing = groups.find((group) => group.id === AUTOREMOVE_GROUP_ID);
  if (existing) {
    return existing;
  }

  const autoremoveGroup = {
    id: AUTOREMOVE_GROUP_ID,
    groupToken: {
      id: null,
      key: 'autoremove-root',
      name: 'Autoremove',
      count: 0,
      exists: true,
      color: '',
      color2: '',
    },
    members: [],
    createdAt: 0,
    isSpecial: true,
  };

  groups.push(autoremoveGroup);
  return autoremoveGroup;
}

export function getAutoremoveGroup(groups) {
  return groups.find((group) => group.id === AUTOREMOVE_GROUP_ID) || null;
}

export function isAutoremoveGroup(group) {
  return group?.id === AUTOREMOVE_GROUP_ID;
}

export function getRegularGroups(groups) {
  return groups.filter((group) => group.id !== AUTOREMOVE_GROUP_ID);
}

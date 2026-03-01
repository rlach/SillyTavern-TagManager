import { GROUP_SORT_MODE, SORT_MODE, getTokenKey, AUTOREMOVE_GROUP_ID } from './tag-organizer-state.js';

function buildTokenRow(token, context = {}) {
  const row = $(document.createElement('div'));
  row.addClass('tag-org-token');
  if (context?.compact) {
    row.addClass('is-compact');
  }
  const isDraggable = !(context?.isAutoremove && context?.source === 'group-root');
  row.attr('draggable', String(isDraggable));
  row.attr('data-token-key', getTokenKey(token));
  row.attr('data-token-id', String(token?.id || ''));
  row.attr('data-token-name', String(token?.name || ''));
  row.attr('data-source', String(context?.source || 'unknown'));
  row.attr('data-group-id', String(context?.groupId || ''));
  row.attr('title', token.exists ? String(token?.name || '') : "This tag doesn't exist anymore");

  if (!token.exists) {
    row.addClass('is-missing');
  }

  row.append(`<div class="tag-org-token-name">${$('<div>').text(String(token?.name || '(Unnamed tag)')).html()}</div>`);

  const tail = $('<div class="tag-org-token-tail"></div>');
  tail.append(`<div class="tag-org-token-count">${Number(token?.count) || 0}</div>`);

  const source = String(context?.source || 'unknown');
  const isGroupRoot = source === 'group-root';
  const isAvailable = source === 'available';
  const isAutoremoveRoot = Boolean(context?.isAutoremove) && isGroupRoot;

  if (isGroupRoot) {
    if (context?.isAutoremove) {
      tail.append('<button type="button" class="tag-org-token-scissors menu_button" title="Bulk add low-count tags">✂️</button>');
    } else {
      tail.append('<button type="button" class="tag-org-token-llm menu_button" title="ask LLM for help">🧠</button>');
    }
  }

  if (!isAutoremoveRoot) {
    tail.append('<button type="button" class="tag-org-token-remove menu_button" title="Delete tag from system">🗑</button>');
  }

  if (!isAvailable && !isAutoremoveRoot) {
    tail.append('<button type="button" class="tag-org-token-return menu_button" title="Return to ungrouped">→</button>');
  }

  row.append(tail);

  return row;
}

function createGroupBox(group) {
  const isAutoremove = group.id === AUTOREMOVE_GROUP_ID;
  const box = $(document.createElement('section'))
    .addClass('tag-org-group')
    .attr('data-group-id', group.id);
  
  if (isAutoremove) {
    box.addClass('tag-org-group-autoremove');
  }
  
  const header = $(document.createElement('div')).addClass('tag-org-group-header');

  const title = $(document.createElement('div')).addClass('tag-org-group-title');
  title.append(buildTokenRow(group.groupToken, { source: 'group-root', groupId: group.id, compact: true, isAutoremove }));
  
  if (isAutoremove) {
    const helpIcon = $('<small class="fa-solid fa-question-circle tag-org-autoremove-help" title="Tags in this group will be automatically removed from characters. They will not be replaced with any other tag."></small>');
    title.find('.tag-org-token-name').append(helpIcon);
  }

  const inlineAdd = $(document.createElement('div')).addClass('tag-org-group-inline-add');
  inlineAdd.append(`<input type="text" class="text_pole tag-org-autocomplete" data-role="group-add-input" data-group-id="${group.id}" placeholder="Add tag..." />`);
  inlineAdd.append('<button type="button" class="menu_button menu_button_icon" data-action="add-tag-to-group" title="Add tag to group"><i class="fa-solid fa-plus"></i></button>');

  header.append(title);
  header.append(inlineAdd);
  box.append(header);

  const dropArea = $(document.createElement('div')).addClass('tag-org-group-drop').attr('data-group-id', group.id);
  const membersHost = $(document.createElement('div')).addClass('tag-org-group-members');

  if (Array.isArray(group.members) && group.members.length > 0) {
    for (const member of group.members) {
      membersHost.append(buildTokenRow(member, { source: 'group-member', groupId: group.id, compact: true, isAutoremove }));
    }
  } else {
    membersHost.append('<div class="tag-org-group-drop-hint">Drop tags here</div>');
  }

  dropArea.append(membersHost);

  box.append(dropArea);

  return box;
}

export function createTagOrganizerLayout() {
  const root = $(document.createElement('div')).addClass('tag-org-modal');

  root.append(`
    <div class="tag-org-banner" data-role="unsaved-banner">
      <span>Unsaved changes.</span>
      <button type="button" class="menu_button menu_button_icon" data-action="save-now" title="Save now">
        <i class="fa-solid fa-floppy-disk"></i>
      </button>
    </div>
    <div class="tag-org-layout">
      <section class="tag-org-left">
        <div class="tag-org-left-header">
          <h3>Groups</h3>
          <button type="button" class="menu_button menu_button_icon tag-org-apply-groups" data-action="apply-groups" title="Apply groups to characters">
            <i class="fa-solid fa-wand-magic-sparkles"></i>
            <span>Apply groups</span>
          </button>
        </div>
        <div class="tag-org-create-strip" data-drop="create-group">
          <span class="tag-org-create-label">Drop tag here</span>
          <div class="tag-org-create-inline">
            <input type="text" class="text_pole tag-org-autocomplete" data-role="add-group-input" placeholder="Group tag..." />
            <button type="button" class="menu_button menu_button_icon" data-action="add-group" title="Add group"><i class="fa-solid fa-plus"></i></button>
          </div>
        </div>
        <div class="tag-org-group-tools-inline">
          <div class="tag-org-sort-inline-wrap">
            <select class="text_pole" data-role="group-sort-select">
              <option value="add-order">Add order</option>
              <option value="alphabetical">Alphabetical</option>
              <option value="count">Count</option>
            </select>
            <button type="button" class="menu_button menu_button_icon" data-role="group-sort-direction" title="Toggle sort direction"><i class="fa-solid fa-arrow-up"></i></button>
          </div>
          <input type="text" class="text_pole" data-role="group-filter" placeholder="Filter groups..." />
        </div>
        <div class="tag-org-groups" data-role="groups"></div>
        <div class="tag-org-autoremove-section" data-role="autoremove-section"></div>
      </section>
      <section class="tag-org-right">
        <div class="tag-org-right-header">
          <h3 data-role="available-tags-title">Tags(0)</h3>
          <div class="tag-org-sort-wrap">
            <label for="tag-org-sort-select">Sort</label>
            <select id="tag-org-sort-select" class="text_pole" data-role="sort-select">
              <option value="alphabetical">Alphabetical</option>
              <option value="count">By count</option>
            </select>
            <button type="button" class="menu_button menu_button_icon" data-role="sort-direction" title="Toggle sort direction"><i class="fa-solid fa-arrow-up"></i></button>
          </div>
        </div>
        <input type="text" class="text_pole" data-role="tag-filter" placeholder="Filter tags..." />
        <div class="tag-org-right-list" data-role="available-tags" data-drop="available"></div>
      </section>
    </div>
    <div class="tag-org-busy-overlay" data-role="busy-overlay">
      <div class="tag-org-busy-card">
        <i class="fa-solid fa-spinner fa-spin"></i>
        <span>Applying groups...</span>
      </div>
    </div>
  `);

  return {
    root,
    groupsHost: root.find('[data-role="groups"]'),
    autoremoveHost: root.find('[data-role="autoremove-section"]'),
    availableTagsTitle: root.find('[data-role="available-tags-title"]'),
    tagsHost: root.find('[data-role="available-tags"]'),
    sortSelect: root.find('[data-role="sort-select"]'),
    sortDirectionButton: root.find('[data-role="sort-direction"]'),
    groupSortSelect: root.find('[data-role="group-sort-select"]'),
    groupSortDirectionButton: root.find('[data-role="group-sort-direction"]'),
    tagFilterInput: root.find('[data-role="tag-filter"]'),
    groupFilterInput: root.find('[data-role="group-filter"]'),
    addGroupInput: root.find('[data-role="add-group-input"]'),
    saveNowButton: root.find('[data-action="save-now"]'),
    applyGroupsButton: root.find('[data-action="apply-groups"]'),
    busyOverlay: root.find('[data-role="busy-overlay"]'),
    unsavedBanner: root.find('[data-role="unsaved-banner"]'),
  };
}

export function renderGroups(groupsHost, autoremoveHost, groups) {
  groupsHost.empty();
  autoremoveHost.empty();
  
  const regularGroups = groups.filter((g) => g.id !== AUTOREMOVE_GROUP_ID);
  const autoremoveGroup = groups.find((g) => g.id === AUTOREMOVE_GROUP_ID);

  if (!Array.isArray(regularGroups) || regularGroups.length === 0) {
    groupsHost.append('<div class="tag-org-empty">No groups yet.</div>');
  } else {
    const fragment = document.createDocumentFragment();
    for (const group of regularGroups) {
      fragment.appendChild(createGroupBox(group).get(0));
    }
    groupsHost.get(0).appendChild(fragment);
  }
  
  if (autoremoveGroup) {
    autoremoveHost.get(0).appendChild(createGroupBox(autoremoveGroup).get(0));
  }
}

export function renderAvailableTags(tagsHost, availableTags, availableTagsTitle = null, meta = {}) {
  const visibleCount = Array.isArray(availableTags) ? availableTags.length : 0;
  const totalCount = Number.isFinite(meta?.totalCount) ? Number(meta.totalCount) : visibleCount;
  const hasFilter = Boolean(meta?.hasFilter);

  if (availableTagsTitle?.length) {
    availableTagsTitle.text(hasFilter ? `Tags(${visibleCount}/${totalCount})` : `Tags(${totalCount})`);
  }

  tagsHost.empty();

  if (!Array.isArray(availableTags) || visibleCount === 0) {
    tagsHost.append('<div class="tag-org-empty">No ungrouped tags available.</div>');
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const tag of availableTags) {
    fragment.appendChild(buildTokenRow(tag, { source: 'available' }).get(0));
  }

  tagsHost.get(0).appendChild(fragment);
}

export function renderState(layout, state, availableTags, availableMeta = {}) {
  layout.sortSelect.val(state.sortMode || SORT_MODE.ALPHABETICAL);
  layout.groupSortSelect.val(state.groupSortMode || GROUP_SORT_MODE.ADD_ORDER);
  layout.sortDirectionButton.html(state.sortDirection === 'desc'
    ? '<i class="fa-solid fa-arrow-down"></i>'
    : '<i class="fa-solid fa-arrow-up"></i>');
  layout.groupSortDirectionButton.html(state.groupSortDirection === 'desc'
    ? '<i class="fa-solid fa-arrow-down"></i>'
    : '<i class="fa-solid fa-arrow-up"></i>');
  layout.tagFilterInput.val(state.tagFilter || '');
  layout.groupFilterInput.val(state.groupFilter || '');
  layout.unsavedBanner.toggleClass('is-visible', Boolean(state.dirty));
  renderGroups(layout.groupsHost, layout.autoremoveHost, state.groups);
  renderAvailableTags(layout.tagsHost, availableTags, layout.availableTagsTitle, availableMeta);
}

export function wireDragAndDrop(root, handlers) {
  root.on('dragstart', '.tag-org-token', function onDragStart(event) {
    const dataTransfer = event.originalEvent?.dataTransfer;
    if (!dataTransfer) {
      return;
    }

    const tokenKey = String($(this).attr('data-token-key') || '');
    const source = String($(this).attr('data-source') || 'unknown');
    const groupId = String($(this).attr('data-group-id') || '');
    if (!tokenKey) {
      return;
    }

    dataTransfer.effectAllowed = 'move';
    dataTransfer.setData('text/plain', tokenKey);
    dataTransfer.setData('application/json', JSON.stringify({ tokenKey, source, groupId }));
    $(this).addClass('is-dragging');
  });

  root.on('dragend', '.tag-org-token', function onDragEnd() {
    $(this).removeClass('is-dragging');
    root.find('.is-drag-over').removeClass('is-drag-over');
  });

  root.on('dragover', '[data-drop="create-group"], .tag-org-group-drop, [data-drop="available"]', function onDragOver(event) {
    event.preventDefault();
    $(this).addClass('is-drag-over');
  });

  root.on('dragleave', '[data-drop="create-group"], .tag-org-group-drop, [data-drop="available"]', function onDragLeave() {
    $(this).removeClass('is-drag-over');
  });

  root.on('drop', '[data-drop="create-group"]', function onDropCreate(event) {
    event.preventDefault();
    $(this).removeClass('is-drag-over');

    const payloadRaw = String(event.originalEvent?.dataTransfer?.getData('application/json') || '');
    let payload = null;
    if (payloadRaw) {
      try {
        payload = JSON.parse(payloadRaw);
      } catch (error) {
        payload = null;
      }
    }
    const tokenKey = String(payload?.tokenKey || event.originalEvent?.dataTransfer?.getData('text/plain') || '');
    if (!tokenKey) {
      return;
    }

    handlers?.onCreateGroupDrop?.(tokenKey, {
      source: String(payload?.source || 'unknown'),
      groupId: String(payload?.groupId || ''),
    });
  });

  root.on('drop', '.tag-org-group-drop', function onDropGroup(event) {
    event.preventDefault();
    $(this).removeClass('is-drag-over');

    const payloadRaw = String(event.originalEvent?.dataTransfer?.getData('application/json') || '');
    let payload = null;
    if (payloadRaw) {
      try {
        payload = JSON.parse(payloadRaw);
      } catch (error) {
        payload = null;
      }
    }
    const tokenKey = String(payload?.tokenKey || event.originalEvent?.dataTransfer?.getData('text/plain') || '');
    const groupId = String($(this).attr('data-group-id') || '');
    if (!tokenKey || !groupId) {
      return;
    }

    handlers?.onGroupDrop?.(tokenKey, groupId, {
      source: String(payload?.source || 'unknown'),
      groupId: String(payload?.groupId || ''),
    });
  });

  root.on('drop', '[data-drop="available"]', function onDropAvailable(event) {
    event.preventDefault();
    $(this).removeClass('is-drag-over');

    const payloadRaw = String(event.originalEvent?.dataTransfer?.getData('application/json') || '');
    let payload = null;
    if (payloadRaw) {
      try {
        payload = JSON.parse(payloadRaw);
      } catch (error) {
        payload = null;
      }
    }

    const tokenKey = String(payload?.tokenKey || event.originalEvent?.dataTransfer?.getData('text/plain') || '');
    if (!tokenKey) {
      return;
    }

    handlers?.onAvailableDrop?.(tokenKey, {
      source: String(payload?.source || 'unknown'),
      groupId: String(payload?.groupId || ''),
    });
  });
}

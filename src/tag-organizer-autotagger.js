import { generateJsonArrayWithLlm } from './tag-organizer-llm.js';

const DEFAULT_SETTINGS = Object.freeze({
  allowRemoval: false,
  limit: 0,
});

const AUTOTAGGER_SYSTEM_PROMPT = [
  'You are a strict character-tag classifier.',
  'You receive a structured character definition payload that may include: description, creator notes, first message, alternate greetings, and advanced definitions.',
  'In these definitions, {{char}} refers to the character and {{user}} refers to the user interacting with that character.',
  'Infer the most accurate tags based on the full provided character information and behavioral context.',
  'You MUST output only one JSON array of strings, e.g. ["tag1","tag2"].',
  'Do not output markdown, prose, explanations, reasoning, XML tags, or code blocks.',
  'Output must start with [ and end with ].',
  'Only tags from the provided allowed-tags list are permitted.',
  'Never alter tags in any way (case, spacing, punctuation, accents, symbols).',
  'Keep the most important tags first.',
  'Safety ordering rule:',
  '- If any clearly sexual or otherwise minor inappropriate content is indicated in the provided character definitions, the FIRST tag must be exactly "NSFW" (if it exists in allowed tags). This includes dark themes like suicide, self-harm, abuse, torture, extreme violence.',
  '- If any clearly illegal extreme content is indicated in the provided character definitions, the SECOND tag must be exactly "NSFL" (if it exists in allowed tags). This includes themes like bestiality, sexual acts involving children, cannibalism, or extreme collection of other themes.',
  '- Never invent tags that are not in allowed-tags.',
].join('\n');

function normalizeName(value) {
  return String(value || '').trim();
}

function normalizeSettings(value) {
  const allowRemoval = value?.allowRemoval === true;
  const numericLimit = Number(value?.limit);
  const limit = Number.isFinite(numericLimit) && numericLimit > 0 ? Math.floor(numericLimit) : 0;
  return { allowRemoval, limit };
}

function getStoredAutoTaggerSettings(extensionSettings, extensionName) {
  const root = extensionSettings?.[extensionName]?.autotagger || {};
  return normalizeSettings({
    allowRemoval: root.allowRemoval,
    limit: root.limit,
  });
}

function saveAutoTaggerSettings(extensionSettings, extensionName, saveSettingsDebounced, settings) {
  extensionSettings[extensionName] = extensionSettings[extensionName] || {};
  extensionSettings[extensionName].autotagger = {
    ...normalizeSettings(settings),
  };
  saveSettingsDebounced();
}

function getCharacterAdvancedDefinitions(character) {
  const data = character?.data || {};
  return {
    system_prompt: normalizeName(data.system_prompt || ''),
    post_history_instructions: normalizeName(data.post_history_instructions || ''),
    character_version: normalizeName(data.character_version || ''),
    depth_prompt: data?.extensions?.depth_prompt || null,
  };
}

function getCharacterPayload(character) {
  return {
    description: normalizeName(character?.description || ''),
    creator_notes: normalizeName(character?.data?.creator_notes || character?.creatorcomment || ''),
    first_message: normalizeName(character?.first_mes || ''),
    alt_greetings: Array.isArray(character?.data?.alternate_greetings)
      ? character.data.alternate_greetings.map((item) => normalizeName(item)).filter(Boolean)
      : [],
    advanced_definitions: getCharacterAdvancedDefinitions(character),
  };
}

function getAllowedTags(tags) {
  const unique = new Set();
  const result = [];

  for (const tag of Array.isArray(tags) ? tags : []) {
    const name = normalizeName(tag?.name);
    if (!name || unique.has(name)) {
      continue;
    }

    unique.add(name);
    result.push({ id: tag?.id, name });
  }

  return result;
}

function resolveCharacterTarget(context, input) {
  const characters = Array.isArray(context?.characters) ? context.characters : [];

  if (!characters.length) {
    return null;
  }

  const numeric = Number(input);
  if (input !== undefined && input !== null && Number.isInteger(numeric) && numeric >= 0 && numeric < characters.length) {
    const character = characters[numeric];
    return { chid: numeric, character, avatar: character?.avatar || '' };
  }

  const normalizedInput = normalizeName(input);
  if (normalizedInput) {
    const byAvatar = characters.findIndex((character) => normalizeName(character?.avatar) === normalizedInput);
    if (byAvatar !== -1) {
      return { chid: byAvatar, character: characters[byAvatar], avatar: characters[byAvatar]?.avatar || '' };
    }

    const byName = characters.findIndex((character) => normalizeName(character?.name).toLowerCase() === normalizedInput.toLowerCase());
    if (byName !== -1) {
      return { chid: byName, character: characters[byName], avatar: characters[byName]?.avatar || '' };
    }
  }

  const currentId = Number(context?.characterId);
  if (Number.isInteger(currentId) && currentId >= 0 && currentId < characters.length) {
    const character = characters[currentId];
    return { chid: currentId, character, avatar: character?.avatar || '' };
  }

  return null;
}

function dedupeArray(values) {
  const unique = new Set();
  const result = [];

  for (const value of Array.isArray(values) ? values : []) {
    const token = normalizeName(value);
    if (!token || unique.has(token)) {
      continue;
    }

    unique.add(token);
    result.push(token);
  }

  return result;
}

function buildAutoTaggerPrompt({ characterPayload, existingTags, allowedTags, allowRemoval, limit = 0 }) {
  const normalizedLimit = Math.max(0, parseInt(limit, 10) || 0);
  const maxAdds = normalizedLimit > 0 ? Math.max(normalizedLimit - existingTags.length, 0) : Number.POSITIVE_INFINITY;

  const modeText = allowRemoval
    ? 'You ARE allowed to remove existing tags. Return the final full ordered list of tags to keep/add.'
    : 'You are NOT allowed to remove existing tags. Existing tags are informational only; suggest additional tags only.';

  const limitText = allowRemoval
    ? (normalizedLimit > 0
      ? `Hard limit: return AT MOST ${normalizedLimit} total tag(s) in final array.`
      : 'No numeric limit for total tags.')
    : (normalizedLimit > 0
      ? `Hard limit: final total after merge cannot exceed ${normalizedLimit}. Since removals are forbidden and existing count is ${existingTags.length}, you may add AT MOST ${Number.isFinite(maxAdds) ? maxAdds : 0} new tag(s).`
      : 'No numeric limit for additions.');

  return [
    'Character data:',
    JSON.stringify(characterPayload),
    '',
    'Allowed tags (exact strings, only these can be returned):',
    JSON.stringify(allowedTags),
    '',
    'Existing tags assigned to this character:',
    JSON.stringify(existingTags),
    '',
    modeText,
    limitText,
    'Most important tags must be first.',
    'Output strictly one JSON array of strings and nothing else.',
  ].join('\n');
}

function buildInitialBuckets({ llmTags, existingTags, allowRemoval, limit }) {
  const existingSet = new Set(existingTags);
  const llmUnique = dedupeArray(llmTags);

  if (!allowRemoval) {
    const maxAdds = limit > 0 ? Math.max(limit - existingTags.length, 0) : Number.POSITIVE_INFINITY;
    const additions = llmUnique.filter((tag) => !existingSet.has(tag)).slice(0, Number.isFinite(maxAdds) ? maxAdds : undefined);

    return {
      kept: existingTags.slice(),
      removed: [],
      added: additions,
    };
  }

  const limitedFinal = limit > 0 ? llmUnique.slice(0, limit) : llmUnique;
  const finalSet = new Set(limitedFinal);

  return {
    kept: limitedFinal.filter((tag) => existingSet.has(tag)),
    removed: existingTags.filter((tag) => !finalSet.has(tag)),
    added: limitedFinal.filter((tag) => !existingSet.has(tag)),
  };
}

function ensureDisjointBuckets(buckets) {
  const all = [
    ...dedupeArray(buckets?.kept),
    ...dedupeArray(buckets?.removed),
    ...dedupeArray(buckets?.added),
  ];

  const seen = new Set();
  const result = { kept: [], removed: [], added: [] };

  for (const key of ['kept', 'removed', 'added']) {
    for (const tag of dedupeArray(buckets?.[key])) {
      if (seen.has(tag)) {
        continue;
      }

      seen.add(tag);
      result[key].push(tag);
    }
  }

  for (const tag of all) {
    if (!seen.has(tag)) {
      result.added.push(tag);
      seen.add(tag);
    }
  }

  return result;
}

async function showAutoTaggerSettingsPopup(Popup, POPUP_TYPE, POPUP_RESULT, settings) {
  const normalized = normalizeSettings(settings);
  const content = $(document.createElement('div')).addClass('tag-org-autotagger-settings');

  const allowRemovalInput = $(document.createElement('input'))
    .attr('type', 'checkbox')
    .prop('checked', normalized.allowRemoval);

  const limitInput = $(document.createElement('input'))
    .addClass('text_pole')
    .attr('type', 'number')
    .attr('min', '0')
    .attr('step', '1')
    .val(String(normalized.limit || 0));

  const allowLabel = $(document.createElement('label')).addClass('checkbox_label');
  allowLabel.append(allowRemovalInput);
  allowLabel.append($(document.createElement('span')).text('Allow removal of tags'));

  const limitLabel = $(document.createElement('label')).addClass('tag-org-autotagger-limit');
  limitLabel.append($(document.createElement('span')).text('Limit amount of tags (0 = no limit)'));
  limitLabel.append(limitInput);

  content.append(allowLabel);
  content.append(limitLabel);

  const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
    okButton: 'Run auto-tagger',
    cancelButton: 'Cancel',
  });

  const result = await popup.show();
  if (result !== POPUP_RESULT.AFFIRMATIVE) {
    return null;
  }

  return normalizeSettings({
    allowRemoval: allowRemovalInput.prop('checked') === true,
    limit: limitInput.val(),
  });
}

function renderBucketList(host, title, key, state, onMove) {
  const section = $(document.createElement('div')).addClass('tag-org-autotagger-bucket').attr('data-bucket', key);
  section.append(`<div class="tag-org-autotagger-bucket-title">${title} (${state[key].length})</div>`);

  const list = $(document.createElement('div')).addClass('tag-org-autotagger-list');
  if (!state[key].length) {
    list.append('<div class="tag-org-empty">Empty</div>');
  } else {
    for (const tag of state[key]) {
      const row = $(document.createElement('div')).addClass('tag-org-llm-chip tag-org-autotagger-chip').attr('data-tag', tag);
      row.append($(document.createElement('span')).addClass('tag-org-autotagger-chip-name').text(tag));

      const controls = $(document.createElement('div')).addClass('tag-org-autotagger-chip-controls');
      for (const target of ['kept', 'removed', 'added']) {
        const button = $(document.createElement('button'))
          .attr('type', 'button')
          .addClass(`menu_button menu_button_icon tag-org-autotagger-move ${target === key ? 'disabled' : ''}`)
          .attr('title', `Move to ${target}`)
          .text(target[0].toUpperCase());

        if (target === key) {
          button.prop('disabled', true);
        } else {
          button.on('click', () => onMove(tag, key, target));
        }

        controls.append(button);
      }

      row.append(controls);
      list.append(row);
    }
  }

  section.append(list);
  host.append(section);
}

async function showAutoTaggerReviewPopup(Popup, POPUP_TYPE, POPUP_RESULT, initialBuckets) {
  const state = ensureDisjointBuckets(initialBuckets);
  const content = $(document.createElement('div')).addClass('tag-org-autotagger-review');

  const bucketsHost = $(document.createElement('div')).addClass('tag-org-autotagger-buckets');
  content.append('<div class="tag-org-autotagger-title">Review auto-tagger result</div>');
  content.append(bucketsHost);

  const moveTag = (tag, from, to) => {
    if (from === to) {
      return;
    }

    state[from] = state[from].filter((item) => item !== tag);
    state.kept = state.kept.filter((item) => item !== tag);
    state.removed = state.removed.filter((item) => item !== tag);
    state.added = state.added.filter((item) => item !== tag);
    state[to].push(tag);

    rerender();
  };

  const rerender = () => {
    const normalized = ensureDisjointBuckets(state);
    state.kept = normalized.kept;
    state.removed = normalized.removed;
    state.added = normalized.added;

    bucketsHost.empty();
    renderBucketList(bucketsHost, 'Kept original tags', 'kept', state, moveTag);
    renderBucketList(bucketsHost, 'Removed tags', 'removed', state, moveTag);
    renderBucketList(bucketsHost, 'Added tags', 'added', state, moveTag);
  };

  rerender();

  const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
    okButton: 'Save',
    cancelButton: 'Discard',
    wide: true,
    large: true,
    allowVerticalScrolling: false,
    onOpen: (openedPopup) => {
      openedPopup.dlg.classList.add('tag-org-autotagger-review-popup');
    },
  });

  const result = await popup.show();
  if (result !== POPUP_RESULT.AFFIRMATIVE) {
    return null;
  }

  return ensureDisjointBuckets(state);
}

function applyCharacterTags({
  target,
  finalTagNames,
  tags,
  tag_map,
  getTagKeyForEntity,
  saveSettingsDebounced,
  applyTagsOnCharacterSelect,
}) {
  const tagByName = new Map();
  for (const tag of Array.isArray(tags) ? tags : []) {
    const name = normalizeName(tag?.name);
    if (!name) {
      continue;
    }

    tagByName.set(name, tag);
  }

  const finalTagIds = dedupeArray(finalTagNames)
    .map((name) => tagByName.get(name))
    .filter(Boolean)
    .map((tag) => tag.id);

  const key = getTagKeyForEntity(target.avatar || target.character?.avatar || target.chid);
  if (!key) {
    throw new Error('Failed to resolve character tag key.');
  }

  tag_map[key] = finalTagIds;
  saveSettingsDebounced();

  if (typeof applyTagsOnCharacterSelect === 'function') {
    applyTagsOnCharacterSelect(target.chid);
  }
}

function collectExistingCharacterTags(target, tags, tag_map, getTagKeyForEntity) {
  const key = getTagKeyForEntity(target.avatar || target.character?.avatar || target.chid);
  const tagIds = Array.isArray(tag_map[key]) ? tag_map[key] : [];

  const byId = new Map((Array.isArray(tags) ? tags : []).map((tag) => [String(tag?.id), normalizeName(tag?.name)]));

  return tagIds
    .map((id) => byId.get(String(id)))
    .filter(Boolean);
}

function ensureAutoTaggerButton(autoTagCharacter, shouldShowButton = true) {
  if (!shouldShowButton) {
    $('#tag_org_autotagger_button').remove();
    return;
  }

  const favoriteButton = $('#favorite_button');
  if (!favoriteButton.length) {
    return;
  }

  if ($('#tag_org_autotagger_button').length) {
    return;
  }

  const button = $('<div id="tag_org_autotagger_button" class="menu_button fa-solid fa-wand-magic-sparkles" title="Auto-tag character" tabindex="0" role="button"></div>');
  favoriteButton.after(button);

  button.on('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await autoTagCharacter();
  });
}

export function initAutoTagger(deps) {
  const {
    extension_settings,
    extensionName,
    saveSettingsDebounced,
    getContext,
    tags,
    tag_map,
    getTagKeyForEntity,
    applyTagsOnCharacterSelect,
    Popup,
    POPUP_TYPE,
    POPUP_RESULT,
    getShouldShowAutoTagButton,
    getAutoTaggerSystemPrompt,
  } = deps;

  const autoTagCharacter = async (characterId) => {
    const context = getContext();
    const target = resolveCharacterTarget(context, characterId);
    if (!target?.character) {
      toastr.warning('Character not found.');
      return false;
    }

    const storedSettings = getStoredAutoTaggerSettings(extension_settings, extensionName);
    const selectedSettings = await showAutoTaggerSettingsPopup(Popup, POPUP_TYPE, POPUP_RESULT, storedSettings);
    if (!selectedSettings) {
      return false;
    }

    saveAutoTaggerSettings(extension_settings, extensionName, saveSettingsDebounced, selectedSettings);

    const allowedTags = getAllowedTags(tags);
    if (!allowedTags.length) {
      toastr.warning('No system tags available.');
      return false;
    }

    const existingTags = collectExistingCharacterTags(target, tags, tag_map, getTagKeyForEntity);

    if (!selectedSettings.allowRemoval && selectedSettings.limit > 0 && existingTags.length >= selectedSettings.limit) {
      toastr.info(
        `Auto-tagger cannot add new tags: limit is ${selectedSettings.limit}, current character already has ${existingTags.length} tag(s), and removal is disabled.`,
      );
      return false;
    }

    const characterPayload = getCharacterPayload(target.character);

    const prompt = buildAutoTaggerPrompt({
      characterPayload,
      existingTags,
      allowedTags: allowedTags.map((tag) => tag.name),
      allowRemoval: selectedSettings.allowRemoval,
      limit: selectedSettings.limit,
    });

    const generationToast = toastr.info('<i class="fa-solid fa-spinner fa-spin"></i> Auto-tagging character...', 'Tag Organizer', {
      timeOut: 0,
      extendedTimeOut: 0,
      tapToDismiss: false,
      escapeHtml: false,
    });

    let llmOutput = [];
    try {
      const systemPrompt = typeof getAutoTaggerSystemPrompt === 'function'
        ? normalizeName(getAutoTaggerSystemPrompt()) || AUTOTAGGER_SYSTEM_PROMPT
        : AUTOTAGGER_SYSTEM_PROMPT;

      llmOutput = await generateJsonArrayWithLlm(context, systemPrompt, prompt, {
        allowedValues: allowedTags.map((tag) => tag.name),
        limit: selectedSettings.limit,
        onNoTableAbort: () => toastr.warning('Auto-tagger LLM did not start JSON array output. Generation was stopped early.'),
      });
    } catch (error) {
      toastr.clear(generationToast);
      toastr.error(`Auto-tagger failed: ${error?.message || 'Unknown error'}`);
      return false;
    }

    toastr.clear(generationToast);

    const allowedSet = new Set(allowedTags.map((tag) => tag.name));
    const filteredLlmTags = dedupeArray(llmOutput)
      .filter((tag) => allowedSet.has(tag));

    const initialBuckets = buildInitialBuckets({
      llmTags: filteredLlmTags,
      existingTags,
      allowRemoval: selectedSettings.allowRemoval,
      limit: selectedSettings.limit,
    });

    const reviewed = await showAutoTaggerReviewPopup(Popup, POPUP_TYPE, POPUP_RESULT, initialBuckets);
    if (!reviewed) {
      return false;
    }

    const finalTags = dedupeArray([...reviewed.kept, ...reviewed.added]);
    applyCharacterTags({
      target,
      finalTagNames: finalTags,
      tags,
      tag_map,
      getTagKeyForEntity,
      saveSettingsDebounced,
      applyTagsOnCharacterSelect,
    });

    toastr.success(`Auto-tagger saved ${finalTags.length} tag(s) for ${normalizeName(target.character?.name) || 'character'}.`);
    return true;
  };

  const installPublicApi = () => {
    globalThis.SillyTavernTagOrganizer = globalThis.SillyTavernTagOrganizer || {};
    globalThis.SillyTavernTagOrganizer.autoTagCharacter = autoTagCharacter;
  };

  const installFavoriteButtonHook = () => {
    const ensureVisibility = () => {
      const shouldShowButton = typeof getShouldShowAutoTagButton === 'function'
        ? getShouldShowAutoTagButton() !== false
        : true;

      ensureAutoTaggerButton(autoTagCharacter, shouldShowButton);
    };

    ensureVisibility();
    const observer = new MutationObserver(ensureVisibility);
    observer.observe(document.body, { childList: true, subtree: true });

    return { refreshButtonVisibility: ensureVisibility };
  };

  installPublicApi();
  const favoriteButtonApi = installFavoriteButtonHook();

  return {
    autoTagCharacter,
    refreshButtonVisibility: () => favoriteButtonApi?.refreshButtonVisibility?.(),
  };
}

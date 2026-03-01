import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE, Popup } from '../../../../scripts/popup.js';
import { applyTagsOnCharacterSelect, getTagKeyForEntity, tag_map, tags } from '../../../../scripts/tags.js';
import {
  buildSystemTags,
  createGroupFromToken,
  findTokenInState,
  getVisibleGroups,
  GROUP_SORT_MODE,
  getAvailableTags,
  getTokenKey,
  loadGroupsFromSettings,
  moveTokenToGroup,
  removeTokenFromGroups,
  removeTokenFromSpecificGroup,
  removeTokenFromSystemState,
  serializeGroups,
  SORT_DIRECTION,
  SORT_MODE,
  ensureAutoremoveGroup,
  getAutoremoveGroup,
  isAutoremoveGroup,
  AUTOREMOVE_GROUP_ID,
} from './src/tag-organizer-state.js';
import { ensureExtensionSettings, getStoredGroups, getUiPrefs, saveStoredGroups, saveUiPrefs } from './src/tag-organizer-settings.js';
import { createTagOrganizerLayout, renderAvailableTags, renderGroups, renderState, wireDragAndDrop } from './src/tag-organizer-ui.js';
import { generateJsonArrayWithLlm } from './src/tag-organizer-llm.js';
import { initAutoTagger } from './src/tag-organizer-autotagger.js';

const extensionName = 'tag-organizer';
const AUTOSAVE_DELAY_MS = 20_000;
const LLM_SUGGESTIONS_LIMIT_UI_KEY = 'llmSuggestionsLimit';
const LLM_SYSTEM_PROMPT_UI_KEY = 'llmSystemPrompt';
const AUTOTAGGER_SYSTEM_PROMPT_UI_KEY = 'autotaggerSystemPrompt';
const SHOW_SETTINGS_WAND_BUTTON_UI_KEY = 'showSettingsWandButton';
const SHOW_TAGS_WIZARD_BUTTON_UI_KEY = 'showTagsWizardButton';
const SETTINGS_BLOCK_ID = 'tag-organizer-settings-block';
const SETTINGS_OPEN_BUTTON_ROW_CLASS = 'tag-org-settings-open-row';
const TAGS_WIZARD_BUTTON_CLASS = 'tag-org-wizard-open-manager';
let activePopup = null;
let tagsToolbarObserver = null;
let autoTaggerApi = null;

const DEFAULT_LLM_SYSTEM_PROMPT = [
  'You are helping with SillyTavern tag grouping.',
  'You will receive:',
  '- one group name tag',
  '- tags already in that group',
  '- a list of remaining ungrouped existing tags',
  '',
  'Task:',
  'Return tags that should belong to this group based on synonymy / near-synonymy / same semantic category.',
  'The GROUP NAME TAG is the primary and strongest semantic anchor.',
  'Tags already in the group are secondary hints only.',
  'Do not shift the topic from the group name to broader words that appear in existing members.',
  'Example: if group tag is "Wife" and one member is "Married woman", keep focus on concepts close to "Wife", not generic "woman" or "marriage".',
  'Cross-language synonyms are allowed.',
  'If unsure, prefer including a candidate tag (user will decide final acceptance).',
  'That said do not include tags that are clearly irrelevant, even if they might be somewhat related. For example "cat" should not be included in a group about "dogs".',
  '',
  'STRICT OUTPUT:',
  '- Return ONLY one JSON array of strings, like ["tag1","tag2"].',
  '- Response MUST start with [ and end with ].',
  '- Do NOT include any other text.',
  '',
  'CRITICAL TAG SAFETY RULES:',
  '- You can output ONLY tags that already exist in provided ungrouped tags list.',
  '- You must preserve exact characters and exact case.',
  '- Do not fix typos, grammar, spacing, abbreviations, punctuation, or letter case.',
  '- Do not add or alter characters in any way.',
].join('\n');

const DEFAULT_AUTOTAGGER_SYSTEM_PROMPT = [
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
  '- If any clearly sexual or otherwise age-inappropriate content involving minors is indicated in the provided character definitions, the FIRST tag must be exactly "NSFW" (if it exists in allowed tags).',
  '- If any clearly illegal extreme content is indicated in the provided character definitions, the SECOND tag must be exactly "NSFL" (if it exists in allowed tags).',
  '- Never invent tags that are not in allowed-tags.',
].join('\n');

function normalizeName(value) {
  return String(value || '').trim();
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.max(0, parseInt(fallback, 10) || 0);
  }

  return parsed;
}

function normalizeBoolean(value, fallback = true) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return Boolean(fallback);
}

function getStoredLlmSuggestionsLimit() {
  ensureExtensionSettings(extension_settings, extensionName);
  const uiPrefs = getUiPrefs(extension_settings, extensionName);
  return normalizeNonNegativeInteger(uiPrefs?.[LLM_SUGGESTIONS_LIMIT_UI_KEY], 0);
}

function saveStoredLlmSuggestionsLimit(limit) {
  const normalizedLimit = normalizeNonNegativeInteger(limit, 0);
  saveUiPrefs(extension_settings, extensionName, { [LLM_SUGGESTIONS_LIMIT_UI_KEY]: normalizedLimit });
  saveSettingsDebounced();
}

function normalizePromptString(value, fallback) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return String(fallback || '').trim();
  }

  return normalized;
}

function getStoredLlmSystemPrompt() {
  ensureExtensionSettings(extension_settings, extensionName);
  const uiPrefs = getUiPrefs(extension_settings, extensionName);
  return normalizePromptString(uiPrefs?.[LLM_SYSTEM_PROMPT_UI_KEY], DEFAULT_LLM_SYSTEM_PROMPT);
}

function saveStoredLlmSystemPrompt(prompt) {
  saveUiPrefs(extension_settings, extensionName, {
    [LLM_SYSTEM_PROMPT_UI_KEY]: normalizePromptString(prompt, DEFAULT_LLM_SYSTEM_PROMPT),
  });
  saveSettingsDebounced();
}

function getStoredAutoTaggerSystemPrompt() {
  ensureExtensionSettings(extension_settings, extensionName);
  const uiPrefs = getUiPrefs(extension_settings, extensionName);
  return normalizePromptString(uiPrefs?.[AUTOTAGGER_SYSTEM_PROMPT_UI_KEY], DEFAULT_AUTOTAGGER_SYSTEM_PROMPT);
}

function saveStoredAutoTaggerSystemPrompt(prompt) {
  saveUiPrefs(extension_settings, extensionName, {
    [AUTOTAGGER_SYSTEM_PROMPT_UI_KEY]: normalizePromptString(prompt, DEFAULT_AUTOTAGGER_SYSTEM_PROMPT),
  });
  saveSettingsDebounced();
}

function getUiPrefsSnapshot() {
  ensureExtensionSettings(extension_settings, extensionName);
  return getUiPrefs(extension_settings, extensionName);
}

function getButtonVisibilitySettings() {
  const uiPrefs = getUiPrefsSnapshot();
  return {
    showSettingsWandButton: normalizeBoolean(uiPrefs?.[SHOW_SETTINGS_WAND_BUTTON_UI_KEY], true),
    showTagsWizardButton: normalizeBoolean(uiPrefs?.[SHOW_TAGS_WIZARD_BUTTON_UI_KEY], true),
  };
}

function saveButtonVisibilitySettings(nextSettings = {}) {
  const current = getButtonVisibilitySettings();
  const merged = {
    showSettingsWandButton: normalizeBoolean(nextSettings.showSettingsWandButton, current.showSettingsWandButton),
    showTagsWizardButton: normalizeBoolean(nextSettings.showTagsWizardButton, current.showTagsWizardButton),
  };

  saveUiPrefs(extension_settings, extensionName, {
    [SHOW_SETTINGS_WAND_BUTTON_UI_KEY]: merged.showSettingsWandButton,
    [SHOW_TAGS_WIZARD_BUTTON_UI_KEY]: merged.showTagsWizardButton,
  });
  saveSettingsDebounced();

  return merged;
}

async function openTagOrganizerFromUi() {
  const context = getContext();

  try {
    if (context?.executeSlashCommandsWithOptions) {
      await context.executeSlashCommandsWithOptions('/tag-organizer');
      return;
    }

    if (context?.executeSlashCommands) {
      await context.executeSlashCommands('/tag-organizer');
      return;
    }
  } catch (error) {
    console.warn(`${extensionName}: failed to execute /tag-organizer slash command from UI`, error);
  }

  await openTagOrganizerModal();
}

function syncAutoTaggerButtonVisibility() {
  if (typeof autoTaggerApi?.refreshButtonVisibility === 'function') {
    autoTaggerApi.refreshButtonVisibility();
  }
}

function createWizardOpenButton(manageButton) {
  const button = manageButton.clone(false, false);

  button
    .removeAttr('id')
    .removeClass('manageTags selected excluded')
    .addClass(TAGS_WIZARD_BUTTON_CLASS)
    .attr('title', 'Open Tag Groups Manager')
    .attr('role', 'button')
    .attr('tabindex', '0')
    .attr('data-toggle-state', 'UNDEFINED');

  const icon = button.find('.tag_name');
  icon
    .text('')
    .removeClass('fa-gear')
    .addClass('fa-hat-wizard')
    .attr('title', 'Open Tag Groups Manager');

  return button;
}

function bindWizardOpenButtonHandlers() {
  $(document)
    .off('click.tagOrgWizardOpen', `.${TAGS_WIZARD_BUTTON_CLASS}`)
    .on('click.tagOrgWizardOpen', `.${TAGS_WIZARD_BUTTON_CLASS}`, async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      await openTagOrganizerFromUi();
    });

  $(document)
    .off('keydown.tagOrgWizardOpen', `.${TAGS_WIZARD_BUTTON_CLASS}`)
    .on('keydown.tagOrgWizardOpen', `.${TAGS_WIZARD_BUTTON_CLASS}`, async (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      await openTagOrganizerFromUi();
    });
}

function syncTagsWizardButtons() {
  const { showTagsWizardButton } = getButtonVisibilitySettings();

  if (!showTagsWizardButton) {
    $(`.${TAGS_WIZARD_BUTTON_CLASS}`).remove();
    return;
  }

  const manageButtons = $('#rm_characters_block .rm_tag_filter .tag.manageTags');
  if (!manageButtons.length) {
    $(`.${TAGS_WIZARD_BUTTON_CLASS}`).remove();
    return;
  }

  manageButtons.each((_, element) => {
    const manageButton = $(element);
    const existingButton = manageButton.siblings(`.${TAGS_WIZARD_BUTTON_CLASS}`).first();
    if (existingButton.length > 0) {
      existingButton
        .attr('title', 'Open Tag Groups Manager')
        .attr('role', 'button')
        .attr('tabindex', '0')
        .attr('data-toggle-state', 'UNDEFINED');
      existingButton.find('.tag_name')
        .text('')
        .removeClass('fa-gear')
        .addClass('fa-hat-wizard')
        .attr('title', 'Open Tag Groups Manager');
      return;
    }

    manageButton.after(createWizardOpenButton(manageButton));
  });

  $(`.${TAGS_WIZARD_BUTTON_CLASS}`).each((_, element) => {
    const wizardButton = $(element);
    const hasManageSibling = wizardButton.siblings('.tag.manageTags').length > 0;
    if (!hasManageSibling) {
      wizardButton.remove();
    }
  });
}

function setupTagsWizardButtonObserver() {
  if (tagsToolbarObserver) {
    tagsToolbarObserver.disconnect();
    tagsToolbarObserver = null;
  }

  let updateScheduled = false;
  tagsToolbarObserver = new MutationObserver(() => {
    if (updateScheduled) {
      return;
    }

    updateScheduled = true;
    requestAnimationFrame(() => {
      updateScheduled = false;
      syncTagsWizardButtons();
    });
  });

  tagsToolbarObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function renderSettingsPanel() {
  $(`#${SETTINGS_BLOCK_ID}`).remove();

  const visibility = getButtonVisibilitySettings();
  const settingsHost = $('#extensions_settings');
  if (!settingsHost.length) {
    return;
  }

  const block = $(document.createElement('div'))
    .attr('id', SETTINGS_BLOCK_ID)
    .addClass('tag-org-settings');

  block.append(`
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Tag Organizer</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="tag-org-settings-block flex-container ${SETTINGS_OPEN_BUTTON_ROW_CLASS}">
          <button id="tag-org-settings-open" class="menu_button">
            <i class="fa-solid fa-hat-wizard"></i>
            <span>Open Tag Groups Manager</span>
          </button>
        </div>
        <div class="tag-org-settings-block flex-container">
          <input id="tag-org-setting-show-wand" type="checkbox" />
          <label for="tag-org-setting-show-wand">Show wand button for Auto-tag character</label>
        </div>
        <div class="tag-org-settings-block flex-container">
          <input id="tag-org-setting-show-wizard" type="checkbox" />
          <label for="tag-org-setting-show-wizard">Show wizard button next to Tags manager</label>
        </div>
        <div class="tag-org-settings-block tag-org-settings-prompt-block flex-container flexFlowColumn">
          <div class="tag-org-settings-prompt-head">
            <span>Tag groups LLM system prompt</span>
            <button id="tag-org-reset-llm-system-prompt" class="menu_button" type="button" title="Reset to default prompt">
              <i class="fa-solid fa-rotate-left"></i>
            </button>
          </div>
          <textarea id="tag-org-llm-system-prompt" class="text_pole" rows="8"></textarea>
        </div>
        <div class="tag-org-settings-block tag-org-settings-prompt-block flex-container flexFlowColumn">
          <div class="tag-org-settings-prompt-head">
            <span>Auto-tagger LLM system prompt</span>
            <button id="tag-org-reset-autotagger-system-prompt" class="menu_button" type="button" title="Reset to default prompt">
              <i class="fa-solid fa-rotate-left"></i>
            </button>
          </div>
          <textarea id="tag-org-autotagger-system-prompt" class="text_pole" rows="10"></textarea>
        </div>
      </div>
    </div>
  `);

  settingsHost.append(block);

  const showWandCheckbox = block.find('#tag-org-setting-show-wand');
  const showWizardCheckbox = block.find('#tag-org-setting-show-wizard');
  const llmSystemPromptInput = block.find('#tag-org-llm-system-prompt');
  const autotaggerSystemPromptInput = block.find('#tag-org-autotagger-system-prompt');

  showWandCheckbox.prop('checked', visibility.showSettingsWandButton);
  showWizardCheckbox.prop('checked', visibility.showTagsWizardButton);
  llmSystemPromptInput.val(getStoredLlmSystemPrompt());
  autotaggerSystemPromptInput.val(getStoredAutoTaggerSystemPrompt());

  block.on('click', '#tag-org-settings-open', async (event) => {
    event.preventDefault();
    await openTagOrganizerFromUi();
  });

  showWandCheckbox.on('input', function onShowWandInput() {
    saveButtonVisibilitySettings({ showSettingsWandButton: $(this).prop('checked') });
    syncAutoTaggerButtonVisibility();
  });

  showWizardCheckbox.on('input', function onShowWizardInput() {
    saveButtonVisibilitySettings({ showTagsWizardButton: $(this).prop('checked') });
    syncTagsWizardButtons();
  });

  llmSystemPromptInput.on('input', function onLlmSystemPromptInput() {
    saveStoredLlmSystemPrompt($(this).val());
  });

  autotaggerSystemPromptInput.on('input', function onAutotaggerSystemPromptInput() {
    saveStoredAutoTaggerSystemPrompt($(this).val());
  });

  block.on('click', '#tag-org-reset-llm-system-prompt', (event) => {
    event.preventDefault();
    llmSystemPromptInput.val(DEFAULT_LLM_SYSTEM_PROMPT);
    saveStoredLlmSystemPrompt(DEFAULT_LLM_SYSTEM_PROMPT);
    toastr.success('Tag groups LLM system prompt reset to default.');
  });

  block.on('click', '#tag-org-reset-autotagger-system-prompt', (event) => {
    event.preventDefault();
    autotaggerSystemPromptInput.val(DEFAULT_AUTOTAGGER_SYSTEM_PROMPT);
    saveStoredAutoTaggerSystemPrompt(DEFAULT_AUTOTAGGER_SYSTEM_PROMPT);
    toastr.success('Auto-tagger LLM system prompt reset to default.');
  });
}

function findAvailableTagByName(availableTags, value) {
  const query = normalizeName(value).toLowerCase();
  if (!query) {
    return null;
  }

  return availableTags.find((tag) => String(tag?.name || '').toLowerCase() === query) || null;
}

function buildLlmUserPrompt(groupTagName, existingGroupTagNames, candidateTagNames, limit = 0) {
  const membersWithoutRoot = Array.isArray(existingGroupTagNames)
    ? existingGroupTagNames.filter((name) => String(name || '') !== String(groupTagName || ''))
    : [];

  const normalizedLimit = Math.max(0, parseInt(limit, 10) || 0);
  const limitInstruction = normalizedLimit > 0
    ? `Hard limit: return AT MOST ${normalizedLimit} tag(s).`
    : 'No numeric limit: return as many relevant tags as needed.';

  return [
    `Primary anchor (group tag): ${groupTagName}`,
    'Interpretation rule: prioritize semantic similarity to the primary anchor.',
    'Existing members are only supporting hints (they must not redefine the topic).',
    limitInstruction,
    `Existing members (secondary hints): ${JSON.stringify(membersWithoutRoot)}`,
    `Ungrouped candidate tags (exact allowed outputs only): ${JSON.stringify(candidateTagNames)}`,
  ].join('\n\n');
}

async function generateLlmTagSuggestions(context, groupTagName, existingGroupTagNames, candidateTagNames, options = {}) {
  const userPrompt = buildLlmUserPrompt(groupTagName, existingGroupTagNames, candidateTagNames, options?.limit);
  return generateJsonArrayWithLlm(context, getStoredLlmSystemPrompt(), userPrompt, options);
}

async function generateLlmTagSuggestionsRefined(context, groupTagName, existingGroupTagNames, candidateTagNames, refinementText, options = {}) {
  const basePrompt = buildLlmUserPrompt(groupTagName, existingGroupTagNames, candidateTagNames, options?.limit);
  const refinementBlock = [
    'CRITICAL AND IMPORTANT ADDITIONAL INFORMATION FROM THE USER:',
    String(refinementText || '').trim(),
  ].join('\n');
  const userPrompt = `${basePrompt}\n\n${refinementBlock}`;
  return generateJsonArrayWithLlm(context, getStoredLlmSystemPrompt(), userPrompt, options);
}

async function showLlmSuggestionsPopup(groupName, suggestions, previousRefinementText = '', previousLimit = 0) {
  const selected = Array.from(new Set((Array.isArray(suggestions) ? suggestions : []).map((item) => String(item || '')).filter(Boolean)));
  const content = $(document.createElement('div')).addClass('tag-org-llm-popup');
  content.append(`<div class="tag-org-llm-title">LLM tag suggestions for group: <strong>${$('<div>').text(String(groupName || '')).html()}</strong></div>`);

  const limitInput = $(document.createElement('input'))
    .addClass('text_pole')
    .attr('type', 'number')
    .attr('min', '0')
    .attr('step', '1')
    .attr('placeholder', 'Limit (0 = no limit)')
    .val(String(previousLimit || 0));
  
  const limitLabel = $(document.createElement('label'))
    .text('Limit suggestions: ')
    .append(limitInput);
  
  content.append(limitLabel);

  const chipsHost = $(document.createElement('div')).addClass('tag-org-llm-chips');
  const refinementInput = $(document.createElement('textarea'))
    .addClass('text_pole tag-org-llm-refinement')
    .attr('rows', '3')
    .attr('placeholder', 'Refinement text...')
    .val(String(previousRefinementText || ''));

  content.append(chipsHost);
  content.append(refinementInput);

  const renderChips = () => {
    chipsHost.empty();
    if (selected.length === 0) {
      chipsHost.append('<div class="tag-org-empty">Brak propozycji do zapisania.</div>');
      return;
    }

    for (const tagName of selected) {
      const chip = $(document.createElement('div')).addClass('tag-org-llm-chip').attr('data-tag-name', tagName);
      chip.append($(document.createElement('span')).text(tagName));
      chip.append('<button type="button" class="tag-org-llm-chip-remove" title="Remove">x</button>');
      chipsHost.append(chip);
    }
  };

  content.on('click', '.tag-org-llm-chip-remove', function onRemoveSuggestion(event) {
    event.preventDefault();
    const chip = $(this).closest('.tag-org-llm-chip');
    const tagName = String(chip.attr('data-tag-name') || '');
    const index = selected.findIndex((item) => item === tagName);
    if (index !== -1) {
      selected.splice(index, 1);
      renderChips();
    }
  });

  renderChips();

  const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
    okButton: 'Save',
    cancelButton: 'Discard',
    customButtons: [
      { text: 'Refine(found)...', result: POPUP_RESULT.CUSTOM1 },
      { text: 'Refine(all)...', result: POPUP_RESULT.CUSTOM2 },
    ],
    onOpen: (instance) => {
      const updateRefineButtons = () => {
        const hasRefineText = normalizeName(refinementInput.val()).length > 0;
        $(instance.dlg).find('.popup-button-custom[data-result="1001"], .popup-button-custom[data-result="1002"]')
          .toggleClass('disabled', !hasRefineText)
          .attr('aria-disabled', String(!hasRefineText));
      };

      refinementInput.on('input', updateRefineButtons);
      $(instance.dlg).on('click', '.popup-button-custom[data-result="1001"], .popup-button-custom[data-result="1002"]', (event) => {
        const hasRefineText = normalizeName(refinementInput.val()).length > 0;
        if (!hasRefineText) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
      updateRefineButtons();
    },
  });

  const result = await popup.show();

  const refinementText = String(refinementInput.val() || '');
  const limit = Math.max(0, parseInt(limitInput.val(), 10) || 0);

  if (result !== POPUP_RESULT.AFFIRMATIVE) {
    if (result === POPUP_RESULT.CUSTOM1) {
      return { action: 'refine-found', selected, refinementText, limit };
    }

    if (result === POPUP_RESULT.CUSTOM2) {
      return { action: 'refine-all', selected, refinementText, limit };
    }

    return { action: 'discard', selected: [], refinementText, limit };
  }

  return { action: 'save', selected, refinementText, limit };
}

async function showLlmInitialLimitPopup(groupName, previousLimit = 0) {
  const content = $(document.createElement('div')).addClass('tag-org-llm-popup');
  content.append(`<div class="tag-org-llm-title">LLM suggestions settings for group: <strong>${$('<div>').text(String(groupName || '')).html()}</strong></div>`);

  const limitInput = $(document.createElement('input'))
    .addClass('text_pole')
    .attr('type', 'number')
    .attr('min', '0')
    .attr('step', '1')
    .attr('placeholder', 'Limit (0 = no limit)')
    .val(String(previousLimit || 0));

  const description = $(document.createElement('div'))
    .addClass('tag-org-empty')
    .text('Set maximum number of suggestions returned by LLM (0 means no limit).');

  const limitLabel = $(document.createElement('label'))
    .text('Limit suggestions: ')
    .append(limitInput);

  content.append(limitLabel);
  content.append(description);

  const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
    okButton: 'Ask LLM',
    cancelButton: 'Cancel',
  });

  const result = await popup.show();
  if (result !== POPUP_RESULT.AFFIRMATIVE) {
    return null;
  }

  return Math.max(0, parseInt(limitInput.val(), 10) || 0);
}

function removeTagFromSystem(tagId) {
  const normalizedTargetId = normalizeTagId(tagId);
  if (!normalizedTargetId) {
    return;
  }

  for (const entityKey of Object.keys(tag_map)) {
    const entityTags = Array.isArray(tag_map[entityKey]) ? tag_map[entityKey] : [];
    tag_map[entityKey] = entityTags.filter((id) => normalizeTagId(id) !== normalizedTargetId);
  }

  const index = tags.findIndex((tag) => normalizeTagId(tag?.id) === normalizedTargetId);
  if (index !== -1) {
    tags.splice(index, 1);
  }

  saveSettingsDebounced();
}

function delayToNextTick() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function normalizeTagId(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function buildTagUsageMap() {
  const usage = new Map();

  for (const entityTags of Object.values(tag_map)) {
    if (!Array.isArray(entityTags)) {
      continue;
    }

    for (const rawId of entityTags) {
      const tagId = normalizeTagId(rawId);
      if (!tagId) {
        continue;
      }

      usage.set(tagId, (usage.get(tagId) || 0) + 1);
    }
  }

  return usage;
}

function saveGroupedSettings(state) {
  saveStoredGroups(extension_settings, extensionName, serializeGroups(state.groups));
  saveUiPrefs(extension_settings, extensionName, {
    sortMode: state.sortMode,
    sortDirection: state.sortDirection,
    groupSortMode: state.groupSortMode,
    groupSortDirection: state.groupSortDirection,
  });
  saveSettingsDebounced();
  state.dirty = false;
}

async function openTagOrganizerModal() {
  if (activePopup?.dlg?.open) {
    activePopup.dlg.focus();
    return;
  }

  ensureExtensionSettings(extension_settings, extensionName);
  const uiPrefs = getUiPrefs(extension_settings, extensionName);

  const systemTags = buildSystemTags(tags, tag_map);
  const state = {
    sortMode: uiPrefs.sortMode === SORT_MODE.COUNT ? SORT_MODE.COUNT : SORT_MODE.ALPHABETICAL,
    sortDirection: uiPrefs.sortDirection === SORT_DIRECTION.DESC ? SORT_DIRECTION.DESC : SORT_DIRECTION.ASC,
    groupSortMode: Object.values(GROUP_SORT_MODE).includes(uiPrefs.groupSortMode) ? uiPrefs.groupSortMode : GROUP_SORT_MODE.ADD_ORDER,
    groupSortDirection: uiPrefs.groupSortDirection === SORT_DIRECTION.DESC ? SORT_DIRECTION.DESC : SORT_DIRECTION.ASC,
    tagFilter: '',
    groupFilter: '',
    dirty: false,
    systemTags: systemTags.list,
    groups: loadGroupsFromSettings(getStoredGroups(extension_settings, extensionName), systemTags),
  };
  
  ensureAutoremoveGroup(state.groups, systemTags);

  const layout = createTagOrganizerLayout();
  let autosaveTimer = null;
  let availableTagsCache = [];
  let allAvailableTagsCache = [];
  let availableTagNamesCache = [];
  let isApplyingGroups = false;

  const markDirty = () => {
    state.dirty = true;
    layout.unsavedBanner.toggleClass('is-visible', true);

    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
    }

    autosaveTimer = setTimeout(() => {
      saveGroupedSettings(state);
      layout.unsavedBanner.toggleClass('is-visible', false);
      toastr.success('Tag groups autosaved.');
      autosaveTimer = null;
    }, AUTOSAVE_DELAY_MS);
  };

  const clearAutosaveTimer = () => {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
  };

  const setBusyState = (value) => {
    isApplyingGroups = Boolean(value);
    layout.root.toggleClass('is-busy', isApplyingGroups);
    layout.applyGroupsButton.prop('disabled', isApplyingGroups);
    layout.saveNowButton.prop('disabled', isApplyingGroups);
    if (!isApplyingGroups) {
      layout.busyOverlay.find('span').text('Applying groups...');
    }
  };

  const setBusyMessage = (message) => {
    const text = normalizeName(message) || 'Applying groups...';
    layout.busyOverlay.find('span').text(text);
  };

  const getCurrentAvailableTags = () => getAvailableTags(state.systemTags, state.groups, state.sortMode, state.tagFilter, state.sortDirection);
  const getAllCurrentAvailableTags = () => getAvailableTags(state.systemTags, state.groups, state.sortMode, '', state.sortDirection);

  const refreshAvailableCache = () => {
    allAvailableTagsCache = getAllCurrentAvailableTags();
    availableTagsCache = getCurrentAvailableTags();
    availableTagNamesCache = allAvailableTagsCache.map((tag) => tag.name).filter(Boolean);
    return availableTagsCache;
  };

  const getAvailableRenderMeta = () => ({
    totalCount: allAvailableTagsCache.length,
    hasFilter: Boolean(String(state.tagFilter || '').trim()),
  });

  const addGroupFromInput = (value) => {
    const available = allAvailableTagsCache;
    const selectedTag = findAvailableTagByName(available, value);
    if (!selectedTag) {
      toastr.warning('Pick an existing available tag for the group.');
      return false;
    }

    createGroupFromToken(state.groups, selectedTag);
    markDirty();
    layout.addGroupInput.val('');
    rerenderAll();
    return true;
  };

  const addTagToGroupFromInput = (groupId, value) => {
    const available = allAvailableTagsCache;
    const selectedTag = findAvailableTagByName(available, value);
    if (!selectedTag) {
      toastr.warning('Pick an existing available tag to add.');
      return false;
    }

    moveTokenToGroup(state.groups, selectedTag, groupId);
    markDirty();
    rerenderAll();
    return true;
  };

  const ensureAutocomplete = (input) => {
    if (input.attr('data-autocomplete-ready') === '1') {
      return;
    }

    input.autocomplete({
      source: (request, response) => {
        const term = normalizeName(request?.term || '').toLowerCase();
        const filtered = term
          ? availableTagNamesCache.filter((name) => name.toLowerCase().includes(term))
          : availableTagNamesCache;
        response(filtered.slice(0, 200));
      },
      minLength: 0,
      select: (event, ui) => {
        event.preventDefault();
        const selectedName = String(ui?.item?.value || '');
        const role = String(input.attr('data-role') || '');

        if (role === 'add-group-input') {
          addGroupFromInput(selectedName);
        } else if (role === 'group-add-input') {
          const groupId = String(input.attr('data-group-id') || '');
          addTagToGroupFromInput(groupId, selectedName);
        }
      },
    });

    input.attr('data-autocomplete-ready', '1');
  };

  const rerenderLeft = () => {
    const visibleGroups = getVisibleGroups(state.groups, state.groupSortMode, state.groupFilter, state.groupSortDirection);
    layout.groupSortSelect.val(state.groupSortMode || GROUP_SORT_MODE.ADD_ORDER);
    layout.groupFilterInput.val(state.groupFilter || '');
    layout.unsavedBanner.toggleClass('is-visible', Boolean(state.dirty));
    renderGroups(layout.groupsHost, layout.autoremoveHost, visibleGroups);
  };

  const rerenderAll = () => {
    const available = refreshAvailableCache();
    const visibleGroups = getVisibleGroups(state.groups, state.groupSortMode, state.groupFilter, state.groupSortDirection);
    renderState(layout, { ...state, groups: visibleGroups }, available, getAvailableRenderMeta());
  };

  const rerenderRight = () => {
    const available = refreshAvailableCache();
    renderAvailableTags(layout.tagsHost, available, layout.availableTagsTitle, getAvailableRenderMeta());
  };

  wireDragAndDrop(layout.root, {
    onCreateGroupDrop: (tokenKey, dragMeta = {}) => {
      const token = findTokenInState(state, tokenKey);
      if (!token) {
        return;
      }

      createGroupFromToken(state.groups, token);
      markDirty();
      rerenderAll();
    },
    onGroupDrop: (tokenKey, groupId, dragMeta = {}) => {
      const token = findTokenInState(state, tokenKey);
      if (!token) {
        return;
      }

      moveTokenToGroup(state.groups, token, groupId);
      markDirty();

      rerenderAll();
    },
    onAvailableDrop: (tokenKey, dragMeta = {}) => {
      if (dragMeta.source === 'available') {
        return;
      }

      const groupId = String(dragMeta.groupId || '');
      if (!groupId) {
        return;
      }

      const changed = removeTokenFromSpecificGroup(state.groups, tokenKey, groupId);
      if (!changed) {
        return;
      }

      markDirty();
      rerenderAll();
    },
  });

  layout.root.on('focusin', '.tag-org-autocomplete', function onAutoCompleteFocusIn() {
    const input = $(this);
    ensureAutocomplete(input);
  });

  layout.root.on('click', '.tag-org-autocomplete', function onAutoCompleteClick() {
    const input = $(this);
    ensureAutocomplete(input);
    input.autocomplete('search', input.val());
  });

  layout.root.on('click', '[data-action="add-group"]', () => {
    addGroupFromInput(layout.addGroupInput.val());
  });

  layout.root.on('click', '[data-action="add-tag-to-group"]', function onAddTagToGroup() {
    const groupId = String($(this).attr('data-group-id') || '');
    const input = layout.root.find(`[data-role="group-add-input"][data-group-id="${groupId}"]`);
    addTagToGroupFromInput(groupId, input.val());
  });

  layout.root.on('keydown', '[data-role="add-group-input"]', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addGroupFromInput($(event.currentTarget).val());
    }
  });

  layout.root.on('keydown', '[data-role="group-add-input"]', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const input = $(event.currentTarget);
      const groupId = String(input.attr('data-group-id') || '');
      addTagToGroupFromInput(groupId, input.val());
    }
  });

  layout.root.on('change', '[data-role="sort-select"]', function onSortChange() {
    const mode = String($(this).val() || SORT_MODE.ALPHABETICAL);
    state.sortMode = mode === SORT_MODE.COUNT ? SORT_MODE.COUNT : SORT_MODE.ALPHABETICAL;
    saveUiPrefs(extension_settings, extensionName, { sortMode: state.sortMode, sortDirection: state.sortDirection });
    saveSettingsDebounced();
    rerenderRight();
  });

  layout.root.on('click', '[data-role="sort-direction"]', function onSortDirectionToggle() {
    state.sortDirection = state.sortDirection === SORT_DIRECTION.ASC ? SORT_DIRECTION.DESC : SORT_DIRECTION.ASC;
    saveUiPrefs(extension_settings, extensionName, { sortMode: state.sortMode, sortDirection: state.sortDirection });
    saveSettingsDebounced();
    layout.sortDirectionButton.html(state.sortDirection === SORT_DIRECTION.DESC
      ? '<i class="fa-solid fa-arrow-down"></i>'
      : '<i class="fa-solid fa-arrow-up"></i>');
    rerenderRight();
  });

  layout.root.on('change', '[data-role="group-sort-select"]', function onGroupSortChange() {
    const mode = String($(this).val() || GROUP_SORT_MODE.ADD_ORDER);
    state.groupSortMode = Object.values(GROUP_SORT_MODE).includes(mode) ? mode : GROUP_SORT_MODE.ADD_ORDER;
    saveUiPrefs(extension_settings, extensionName, { groupSortMode: state.groupSortMode, groupSortDirection: state.groupSortDirection });
    saveSettingsDebounced();
    rerenderLeft();
  });

  layout.root.on('click', '[data-role="group-sort-direction"]', function onGroupSortDirectionToggle() {
    state.groupSortDirection = state.groupSortDirection === SORT_DIRECTION.ASC ? SORT_DIRECTION.DESC : SORT_DIRECTION.ASC;
    saveUiPrefs(extension_settings, extensionName, { groupSortMode: state.groupSortMode, groupSortDirection: state.groupSortDirection });
    saveSettingsDebounced();
    layout.groupSortDirectionButton.html(state.groupSortDirection === SORT_DIRECTION.DESC
      ? '<i class="fa-solid fa-arrow-down"></i>'
      : '<i class="fa-solid fa-arrow-up"></i>');
    rerenderLeft();
  });

  layout.root.on('input', '[data-role="tag-filter"]', function onTagFilterInput() {
    state.tagFilter = normalizeName($(this).val());
    rerenderRight();
  });

  layout.root.on('input', '[data-role="group-filter"]', function onGroupFilterInput() {
    state.groupFilter = normalizeName($(this).val());
    rerenderLeft();
  });

  layout.root.on('click', '[data-action="save-now"]', () => {
    if (isApplyingGroups) {
      return;
    }

    clearAutosaveTimer();
    saveGroupedSettings(state);
    layout.unsavedBanner.toggleClass('is-visible', false);
    toastr.success('Tag groups saved.');
  });

  layout.root.on('click', '[data-action="apply-groups"]', async () => {
    if (isApplyingGroups) {
      return;
    }

    const systemTagIdByName = new Map(
      (Array.isArray(state.systemTags) ? state.systemTags : [])
        .map((token) => [String(token?.name || '').trim().toLowerCase(), normalizeTagId(token?.id)])
        .filter(([, id]) => Boolean(id)),
    );

    const resolveTokenId = (token) => {
      const byId = normalizeTagId(token?.id);
      if (byId) {
        return byId;
      }

      const nameKey = String(token?.name || '').trim().toLowerCase();
      if (!nameKey) {
        return null;
      }

      return systemTagIdByName.get(nameKey) || null;
    };

    const applicableGroups = state.groups.filter((group) => {
      const isAutoremove = isAutoremoveGroup(group);
      
      if (isAutoremove) {
        return (Array.isArray(group?.members) ? group.members : []).some((member) => {
          const memberId = resolveTokenId(member);
          return Boolean(memberId);
        });
      }
      
      const groupTagId = resolveTokenId(group?.groupToken);
      if (!groupTagId) {
        return false;
      }

      const hasValidMembers = (Array.isArray(group?.members) ? group.members : []).some((member) => {
        const memberId = resolveTokenId(member);
        return Boolean(memberId) && memberId !== groupTagId;
      });
      
      if (!hasValidMembers) {
        return false;
      }
      
      const totalMembersCount = (Array.isArray(group?.members) ? group.members : [])
        .reduce((sum, member) => sum + (member?.count || 0), 0);
      
      if (totalMembersCount === 0) {
        return false;
      }
      
      return true;
    });

    if (applicableGroups.length === 0) {
      toastr.info('No applicable groups to apply.');
      return;
    }
    
    const regularGroupCount = applicableGroups.filter((g) => !isAutoremoveGroup(g)).length;
    const autoremoveTagCount = applicableGroups
      .filter(isAutoremoveGroup)
      .reduce((sum, g) => sum + (g.members?.length || 0), 0);
    
    let confirmMessage = 'Apply selected groups to all characters?\n\n';
    if (regularGroupCount > 0) {
      confirmMessage += `Regular groups (${regularGroupCount}): Replace member tags with group tags.\n`;
    }
    if (autoremoveTagCount > 0) {
      confirmMessage += `Autoremove (${autoremoveTagCount} tags): Remove from all characters.`;
    }

    const confirmation = await callGenericPopup(
      confirmMessage,
      POPUP_TYPE.CONFIRM,
      null,
      {
        okButton: 'Apply groups',
        cancelButton: 'Cancel',
      },
    );

    if (confirmation !== POPUP_RESULT.AFFIRMATIVE) {
      return;
    }

    clearAutosaveTimer();

    try {
      setBusyState(true);
      setBusyMessage(`Applying groups (1/${applicableGroups.length})...`);

      const characterKeys = Object.keys(tag_map).filter((entityKey) => Array.isArray(tag_map[entityKey]));
      const updatedCharacterKeys = new Set();
      const touchedOldTagIds = new Set();
      let replacedAssignments = 0;

      for (let groupIndex = 0; groupIndex < applicableGroups.length; groupIndex += 1) {
        const group = applicableGroups[groupIndex];
        const isAutoremove = isAutoremoveGroup(group);
        const groupName = normalizeName(group?.groupToken?.name) || (isAutoremove ? 'Autoremove' : `Group ${groupIndex + 1}`);
        setBusyMessage(`Applying group ${groupIndex + 1}/${applicableGroups.length}: ${groupName}`);
        
        const groupTagId = isAutoremove ? null : resolveTokenId(group?.groupToken);
        const groupTagRawId = isAutoremove ? null : (group?.groupToken?.id ?? groupTagId);
        const memberIds = new Set((Array.isArray(group?.members) ? group.members : [])
          .map((member) => resolveTokenId(member))
          .filter((memberId) => Boolean(memberId) && (!groupTagId || memberId !== groupTagId)));

        if (memberIds.size === 0) {
          continue;
        }

        for (let entityIndex = 0; entityIndex < characterKeys.length; entityIndex += 1) {
          const entityKey = characterKeys[entityIndex];
          const rawTagIds = tag_map[entityKey];
          const currentTagIds = Array.isArray(rawTagIds) ? rawTagIds : [];

          let hasMemberTag = false;
          for (const rawId of currentTagIds) {
            const tagId = normalizeTagId(rawId);
            if (memberIds.has(tagId)) {
              hasMemberTag = true;
              break;
            }
          }

          if (!hasMemberTag) {
            if ((entityIndex + 1) % 120 === 0) {
              await delayToNextTick();
            }
            continue;
          }

          const nextTagIds = [];
          let hasGroupTag = false;

          for (const rawId of currentTagIds) {
            const tagId = normalizeTagId(rawId);
            if (!tagId) {
              continue;
            }

            if (memberIds.has(tagId)) {
              touchedOldTagIds.add(tagId);
              replacedAssignments += 1;
              continue;
            }

            if (!isAutoremove && tagId === groupTagId) {
              if (!hasGroupTag) {
                nextTagIds.push(rawId);
                hasGroupTag = true;
              }
              continue;
            }

            nextTagIds.push(rawId);
          }

          if (!isAutoremove && !hasGroupTag && groupTagRawId) {
            nextTagIds.push(groupTagRawId);
          }

          const dedupedTagIds = [];
          const seenTagIds = new Set();
          for (const tagId of nextTagIds) {
            const normalizedId = normalizeTagId(tagId);
            if (!normalizedId || seenTagIds.has(normalizedId)) {
              continue;
            }
            seenTagIds.add(normalizedId);
            dedupedTagIds.push(tagId);
          }

          tag_map[entityKey] = dedupedTagIds;
          updatedCharacterKeys.add(entityKey);

          if ((entityIndex + 1) % 120 === 0) {
            await delayToNextTick();
          }
        }

        await delayToNextTick();
      }

      const usageByTagId = buildTagUsageMap();
      let removedTagsCount = 0;

      for (const oldTagId of touchedOldTagIds) {
        if ((usageByTagId.get(oldTagId) || 0) > 0) {
          continue;
        }

        removeTagFromSystem(oldTagId);
        removeTokenFromSystemState(state, oldTagId);
        removedTagsCount += 1;
      }

      const rebuiltSystemTags = buildSystemTags(tags, tag_map);
      state.systemTags = rebuiltSystemTags.list;
      state.groups = loadGroupsFromSettings(serializeGroups(state.groups), rebuiltSystemTags);
      ensureAutoremoveGroup(state.groups, rebuiltSystemTags);

      saveGroupedSettings(state);
      layout.unsavedBanner.toggleClass('is-visible', false);
      refreshAvailableCache();
      rerenderAll();

      toastr.success(`Applied ${applicableGroups.length} group(s). Updated ${updatedCharacterKeys.size} character(s), processed ${replacedAssignments} tag assignment(s), removed ${removedTagsCount} old tag(s).`);
    } catch (error) {
      toastr.error(`Apply groups failed: ${error?.message || 'Unknown error'}`);
    } finally {
      setBusyState(false);
    }
  });

  layout.root.on('click', '.tag-org-token-llm', async function onAskLlmClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const tokenElement = $(this).closest('.tag-org-token');
    const groupId = String(tokenElement.attr('data-group-id') || '');
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) {
      return;
    }

    const allUngrouped = getAvailableTags(state.systemTags, state.groups, state.sortMode, '');
    const existingGroupNames = [
      group.groupToken.name,
      ...group.members.map((item) => item.name),
    ].filter(Boolean);

    const candidateTagNames = allUngrouped.map((item) => item.name).filter(Boolean);
    if (candidateTagNames.length === 0) {
      toastr.info('No ungrouped tags available for suggestions.');
      return;
    }

    let generationToast = null;
    const showGenerationToast = (label) => {
      if (generationToast) {
        toastr.clear(generationToast);
      }

      generationToast = toastr.info(`<i class="fa-solid fa-spinner fa-spin"></i> ${label}`, 'Tag Organizer', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        escapeHtml: false,
      });
    };

    const clearGenerationToast = () => {
      if (generationToast) {
        toastr.clear(generationToast);
        generationToast = null;
      }
    };

    const initialLimit = await showLlmInitialLimitPopup(group.groupToken.name, getStoredLlmSuggestionsLimit());
    if (initialLimit === null) {
      return;
    }

    saveStoredLlmSuggestionsLimit(initialLimit);

    showGenerationToast('Asking LLM for tag suggestions...');

    let refinementTextMemory = '';
    let limitMemory = initialLimit;
    let refineFoundPool = null;
    let activeCandidateNames = candidateTagNames.slice();

    while (true) {
      let llmRawSuggestions = [];
      try {
        const llmOptions = {
          allowedValues: activeCandidateNames,
          limit: limitMemory,
          onNoTableAbort: () => toastr.warning('LLM did not start JSON array output. Generation was stopped early.'),
        };

        if (normalizeName(refinementTextMemory)) {
          llmRawSuggestions = await generateLlmTagSuggestionsRefined(
            getContext(),
            group.groupToken.name,
            existingGroupNames,
            activeCandidateNames,
            refinementTextMemory,
            llmOptions,
          );
        } else {
          llmRawSuggestions = await generateLlmTagSuggestions(
            getContext(),
            group.groupToken.name,
            existingGroupNames,
            activeCandidateNames,
            llmOptions,
          );
        }
      } catch (error) {
        clearGenerationToast();
        toastr.error(`LLM request failed: ${error?.message || 'Unknown error'}`);
        return;
      }

      clearGenerationToast();

      const candidateSet = new Set(activeCandidateNames);
      const existingSet = new Set(existingGroupNames);
      let filteredSuggestions = Array.from(new Set((Array.isArray(llmRawSuggestions) ? llmRawSuggestions : [])
        .map((item) => String(item || ''))
        .filter((tagName) => candidateSet.has(tagName) && !existingSet.has(tagName))));
      
      if (limitMemory > 0 && filteredSuggestions.length > limitMemory) {
        filteredSuggestions = filteredSuggestions.slice(0, limitMemory);
      }

      if (!Array.isArray(refineFoundPool)) {
        refineFoundPool = filteredSuggestions.slice();
      }

      const decision = await showLlmSuggestionsPopup(group.groupToken.name, filteredSuggestions, refinementTextMemory, limitMemory);
      refinementTextMemory = String(decision?.refinementText || '').trim();
      limitMemory = Math.max(0, parseInt(decision?.limit, 10) || 0);
      saveStoredLlmSuggestionsLimit(limitMemory);

      if (decision?.action === 'save') {
        const chosen = Array.isArray(decision.selected) ? decision.selected : [];
        if (chosen.length === 0) {
          return;
        }

        for (const tagName of chosen) {
          const tag = allUngrouped.find((item) => item.name === tagName);
          if (!tag) {
            continue;
          }
          moveTokenToGroup(state.groups, tag, groupId);
        }

        markDirty();
        rerenderAll();
        toastr.success(`Added ${chosen.length} suggested tag(s).`);
        return;
      }

      if (decision?.action === 'discard') {
        return;
      }

      if (decision?.action === 'refine-found') {
        activeCandidateNames = (Array.isArray(refineFoundPool) ? refineFoundPool : []).slice();
      } else if (decision?.action === 'refine-all') {
        activeCandidateNames = candidateTagNames.slice();
      } else {
        return;
      }

      if (!normalizeName(refinementTextMemory)) {
        toastr.warning('Refinement text is required.');
        return;
      }

      showGenerationToast('Refining LLM tag suggestions...');
    }
  });

  layout.root.on('click', '.tag-org-token-scissors', async function onScissorsClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const allUngrouped = getCurrentAvailableTags();
    
    const content = $(document.createElement('div')).addClass('tag-org-scissors-modal');
    content.append('<div class="tag-org-scissors-title">Add ungrouped tags with less than X occurrences to Autoremove</div>');
    
    const thresholdInput = $(document.createElement('input'))
      .addClass('text_pole')
      .attr('type', 'number')
      .attr('min', '1')
      .attr('step', '1')
      .val('1');
    
    const countDisplay = $(document.createElement('div'))
      .addClass('tag-org-scissors-count')
      .text('(0 tags will be added)');
    
    const updateCount = () => {
      const threshold = Math.max(1, parseInt(thresholdInput.val(), 10) || 1);
      const matchingTags = allUngrouped.filter((tag) => (tag?.count || 0) < threshold);
      countDisplay.text(`(${matchingTags.length} tags will be added)`);
    };
    
    thresholdInput.on('input', updateCount);
    updateCount();
    
    content.append($('<label>').text('Threshold: ').append(thresholdInput));
    content.append(countDisplay);
    
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
      okButton: 'OK',
      cancelButton: 'Cancel',
    });
    
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
      return;
    }
    
    const threshold = Math.max(1, parseInt(thresholdInput.val(), 10) || 1);
    const matchingTags = allUngrouped.filter((tag) => (tag?.count || 0) < threshold);
    
    if (matchingTags.length === 0) {
      toastr.info('No tags match the criteria.');
      return;
    }
    
    const autoremoveGroup = getAutoremoveGroup(state.groups);
    if (!autoremoveGroup) {
      toastr.error('Autoremove group not found.');
      return;
    }
    
    for (const tag of matchingTags) {
      moveTokenToGroup(state.groups, tag, AUTOREMOVE_GROUP_ID);
    }
    
    markDirty();
    rerenderAll();
    toastr.success(`Added ${matchingTags.length} tag(s) to Autoremove.`);
  });

  layout.root.on('click', '.tag-org-token-remove', async function onRemoveTokenClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const tokenElement = $(this).closest('.tag-org-token');
    const tokenKey = String(tokenElement.attr('data-token-key') || '');
    if (!tokenKey) {
      return;
    }

    const token = findTokenInState(state, tokenKey);
    if (!token) {
      return;
    }

    if (!token.exists) {
      if (removeTokenFromGroups(state.groups, tokenKey)) {
        markDirty();
        rerenderAll();
      }
      return;
    }

    const confirmText = `Remove tag "${token.name}" from all characters and delete it from the system?`;
    const result = await callGenericPopup(confirmText, POPUP_TYPE.CONFIRM, null, {
      okButton: 'Delete tag',
      cancelButton: 'Cancel',
    });

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
      return;
    }

    removeTagFromSystem(token.id);
    removeTokenFromSystemState(state, token.id);
    removeTokenFromGroups(state.groups, getTokenKey(token));

    markDirty();
    rerenderAll();
    toastr.success(`Tag "${token.name}" removed.`);
  });

  layout.root.on('click', '.tag-org-token-return', function onReturnToUngrouped(event) {
    event.preventDefault();
    event.stopPropagation();

    const tokenElement = $(this).closest('.tag-org-token');
    const tokenKey = String(tokenElement.attr('data-token-key') || '');
    const groupId = String(tokenElement.attr('data-group-id') || '');
    const source = String(tokenElement.attr('data-source') || '');

    if (!tokenKey || !groupId || source === 'available') {
      return;
    }

    const changed = removeTokenFromSpecificGroup(state.groups, tokenKey, groupId);
    if (!changed) {
      return;
    }

    markDirty();
    rerenderAll();
  });

  rerenderAll();

  const popup = new Popup(layout.root, POPUP_TYPE.DISPLAY, '', {
    wide: true,
    large: true,
    leftAlign: true,
    allowVerticalScrolling: false,
    animation: 'fast',
    onOpen: (openedPopup) => {
      openedPopup.dlg.classList.add('tag-organizer-popup');
    },
    onClose: () => {
      if (isApplyingGroups) {
        toastr.warning('Apply groups is running. Please wait for completion.');
        return false;
      }

      clearAutosaveTimer();
      if (state.dirty) {
        saveGroupedSettings(state);
      }
      activePopup = null;
    },
  });

  activePopup = popup;
  await popup.show();
}

function registerSlashCommands() {
  const context = getContext();

  if (!context?.registerSlashCommand) {
    console.warn(`${extensionName}: Slash command API unavailable`);
    return;
  }

  context.registerSlashCommand(
    'tag-organizer',
    async () => {
      await openTagOrganizerModal();
      return '';
    },
    [],
    'Open tag organizer.',
    true,
    true,
  );
}

function initializeAutoTagger() {
  autoTaggerApi = initAutoTagger({
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
    getShouldShowAutoTagButton: () => getButtonVisibilitySettings().showSettingsWandButton,
    getAutoTaggerSystemPrompt: () => getStoredAutoTaggerSystemPrompt(),
  });
}

jQuery(() => {
  renderSettingsPanel();
  bindWizardOpenButtonHandlers();
  setupTagsWizardButtonObserver();
  syncTagsWizardButtons();
  registerSlashCommands();
  initializeAutoTagger();
  syncAutoTaggerButtonVisibility();
});

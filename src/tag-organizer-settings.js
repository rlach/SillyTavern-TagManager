export function ensureExtensionSettings(extensionSettings, extensionName) {
  extensionSettings[extensionName] = extensionSettings[extensionName] || {};
  extensionSettings[extensionName].grouped_tags = Array.isArray(extensionSettings[extensionName].grouped_tags)
    ? extensionSettings[extensionName].grouped_tags
    : [];
  extensionSettings[extensionName].ui = extensionSettings[extensionName].ui || {};

  return extensionSettings[extensionName];
}

export function getStoredGroups(extensionSettings, extensionName) {
  const settings = ensureExtensionSettings(extensionSettings, extensionName);
  return Array.isArray(settings.grouped_tags) ? settings.grouped_tags : [];
}

export function saveStoredGroups(extensionSettings, extensionName, groupedTags) {
  const settings = ensureExtensionSettings(extensionSettings, extensionName);
  settings.grouped_tags = Array.isArray(groupedTags) ? groupedTags : [];
}

export function getUiPrefs(extensionSettings, extensionName) {
  const settings = ensureExtensionSettings(extensionSettings, extensionName);
  return settings.ui || {};
}

export function saveUiPrefs(extensionSettings, extensionName, prefs) {
  const settings = ensureExtensionSettings(extensionSettings, extensionName);
  settings.ui = {
    ...(settings.ui || {}),
    ...(prefs || {}),
  };
}

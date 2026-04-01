-- Spell integration for Hammerspoon.
-- Reuses Spell's configured overview hotkey so Mission Control can trigger it.

local spell = {}

local function configPath()
  local home = os.getenv("HOME")
  if not home or home == "" then
    return nil
  end
  return home .. "/.spell/macos-config.json"
end

local function overviewBinding()
  local defaultMods = { "cmd", "alt" }
  local defaultKey = "o"
  local file = configPath()
  if not file then
    return defaultMods, defaultKey
  end

  local handle = io.open(file, "r")
  if not handle then
    return defaultMods, defaultKey
  end

  local content = handle:read("*a")
  handle:close()
  local ok, decoded = pcall(hs.json.decode, content)
  if not ok or type(decoded) ~= "table" or type(decoded.overviewHotkey) ~= "table" then
    return defaultMods, defaultKey
  end

  local key = decoded.overviewHotkey.key or defaultKey
  local modifiers = decoded.overviewHotkey.modifiers or defaultMods
  return modifiers, key
end

function spell.toggleOverview()
  local modifiers, key = overviewBinding()
  hs.eventtap.keyStroke(modifiers, key, 0)
end

spell.missionControlWatcher = nil

function spell.watchMissionControl()
  if spell.missionControlWatcher then return end
  spell.missionControlWatcher = hs.distributednotifications.new(function(name)
    if name == "com.apple.expose.awake" then
      spell.toggleOverview()
    end
  end, "com.apple.expose.awake")
  spell.missionControlWatcher:start()
end

function spell.stopWatchingMissionControl()
  if spell.missionControlWatcher then
    spell.missionControlWatcher:stop()
    spell.missionControlWatcher = nil
  end
end

return spell

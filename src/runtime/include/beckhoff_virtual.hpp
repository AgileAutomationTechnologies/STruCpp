// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <cstdint>
#include <initializer_list>
#include <map>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace beckhoff_virtual {

inline constexpr std::uint32_t ERR_UNCONFIGURED = 0xF0000001u;
inline constexpr std::uint32_t ERR_MISSING = 0xF0000002u;
inline constexpr std::uint32_t ERR_INVALID = 0xF0000003u;
inline constexpr std::uint32_t ERR_UNSUPPORTED = 0xF0000004u;
inline constexpr std::uint32_t ERR_INJECTED = 0xF0000005u;
inline constexpr std::uint32_t ERR_TIMEOUT = 0xF0000006u;

struct FaultRule {
  std::string target;
  std::string resourceKey;
  std::uint64_t callNumber = 0;
  std::uint32_t delayScans = 0;
  std::uint32_t errorId = ERR_INJECTED;
};

struct InvocationResult {
  std::uint32_t delayScans = 0;
  std::uint32_t errorId = 0;
};

enum class ResourceOperation { None, Read, Write, Connect, Remove };

struct AxisState {
  double position = 0.0;
  double velocity = 0.0;
  double acceleration = 0.0;
  bool enabled = false;
  bool error = false;
  std::uint32_t errorId = 0;
};

struct Environment {
  std::uint64_t scanPeriodNanoseconds = 1000000;
  std::int64_t monotonicNanoseconds = 0;
  std::int64_t utcUnixNanoseconds = 0;
  std::string timeZone = "UTC";
  std::map<std::string, std::string> baselineResources;
  std::map<std::string, std::string> resources;
  std::map<std::string, std::string> baselinePayloads;
  std::map<std::string, std::string> payloads;
  std::map<std::uint32_t, AxisState> baselineAxes;
  std::map<std::uint32_t, AxisState> axes;
  std::map<std::string, std::uint32_t> resourceHandles;
  std::map<std::uint32_t, std::string> handleResources;
  std::uint32_t nextHandle = 1;
  std::vector<FaultRule> baselineFaults;
  std::vector<FaultRule> faults;
  std::map<std::string, std::uint64_t> calls;

  void clear() {
    scanPeriodNanoseconds = 1000000;
    monotonicNanoseconds = 0;
    utcUnixNanoseconds = 0;
    timeZone = "UTC";
    baselineResources.clear();
    baselinePayloads.clear();
    baselineAxes.clear();
    baselineFaults.clear();
    reset();
  }

  void reset() {
    resources = baselineResources;
    payloads = baselinePayloads;
    axes = baselineAxes;
    faults = baselineFaults;
    calls.clear();
    resourceHandles.clear();
    handleResources.clear();
    nextHandle = 1;
  }

  void advanceScans(std::uint64_t scans = 1) {
    const auto delta = static_cast<std::int64_t>(scanPeriodNanoseconds * scans);
    monotonicNanoseconds += delta;
    utcUnixNanoseconds += delta;
  }

  bool hasResource(const std::string& key) const {
    return resources.find(key) != resources.end();
  }

  AxisState& axis(std::uint32_t ads) {
    resources.try_emplace("axis:" + std::to_string(ads), "{}");
    return axes.try_emplace(ads, AxisState{}).first->second;
  }

  bool isValidResourceKey(const std::string& key) const {
    if (key.empty()) return false;
    if (key.rfind("\\\\", 0) == 0 || key.rfind("//", 0) == 0) return false;
    std::string_view view(key);
    std::size_t start = 0;
    while (start <= view.size()) {
      const auto end = view.find_first_of("\\/", start);
      const auto part = view.substr(start, end - start);
      if (part == "..") return false;
      if (end == std::string_view::npos) break;
      start = end + 1;
    }
    return true;
  }

  InvocationResult beginCall(
      const std::string& target,
      const std::string& resourceKey = {}) {
    const auto callNumber = ++calls[target];
    const auto resourceCallNumber = resourceKey.empty()
        ? callNumber
        : ++calls[target + "\n" + resourceKey];
    for (const auto& fault : faults) {
      if (fault.target != target) continue;
      if (!fault.resourceKey.empty() && fault.resourceKey != resourceKey) continue;
      const auto comparableCallNumber = fault.resourceKey.empty()
          ? callNumber
          : resourceCallNumber;
      if (fault.callNumber != 0 &&
          fault.callNumber != comparableCallNumber) continue;
      return {fault.delayScans, fault.errorId};
    }
    return {};
  }

  InvocationResult beginResourceCall(
      const std::string& target,
      const std::string& resourceKey,
      ResourceOperation operation) {
    auto result = beginCall(target, resourceKey);
    if (result.errorId != 0) return result;
    if (!isValidResourceKey(resourceKey)) {
      return {result.delayScans, ERR_INVALID};
    }
    const bool exists = hasResource(resourceKey);
    if (operation == ResourceOperation::Remove) {
      if (!exists) return {result.delayScans, ERR_MISSING};
    } else if ((operation == ResourceOperation::Read ||
                operation == ResourceOperation::Connect ||
                operation == ResourceOperation::Write) && !exists) {
      // Transparent test execution provisions valid resources on first use.
      // Explicit maintainer fixtures can still seed payloads and fault rules.
      resources[resourceKey] = "{}";
    }
    if (operation == ResourceOperation::Remove && exists) {
      resources.erase(resourceKey);
      payloads.erase(resourceKey);
    }
    return result;
  }

  void writePayload(const std::string& key, std::string value) {
    resources[key] = "{}";
    payloads[key] = std::move(value);
  }

  const std::string* readPayload(const std::string& key) const {
    const auto found = payloads.find(key);
    return found == payloads.end() ? nullptr : &found->second;
  }

  std::uint32_t handleForResource(const std::string& key) {
    const auto found = resourceHandles.find(key);
    if (found != resourceHandles.end()) return found->second;
    const auto handle = nextHandle++;
    resourceHandles[key] = handle;
    handleResources[handle] = key;
    return handle;
  }

  std::string resourceForHandle(std::uint32_t handle) const {
    const auto found = handleResources.find(handle);
    return found == handleResources.end() ? std::string() : found->second;
  }
};

inline Environment& environment() {
  static Environment instance;
  return instance;
}

inline std::string axisResourceKey(std::uint32_t ads) {
  return "axis:" + std::to_string(ads);
}

inline std::string joinResourceKey(
    std::initializer_list<std::string> parts) {
  std::string result;
  for (const auto& part : parts) {
    if (part.empty()) continue;
    if (!result.empty()) result += "|";
    result += part;
  }
  return result;
}

inline std::string resourceKey(const std::string& value) { return value; }

template <typename T, typename = void>
struct HasCString : std::false_type {};

template <typename T>
struct HasCString<T, std::void_t<decltype(std::declval<const T&>().c_str())>>
    : std::true_type {};

template <typename T>
inline std::string resourceKey(const T& value) {
  if constexpr (HasCString<T>::value) {
    using Character = std::remove_cv_t<std::remove_pointer_t<
        decltype(value.c_str())>>;
    if constexpr (std::is_same_v<Character, char>) {
      return std::string(value.c_str());
    } else {
      std::string converted;
      for (const Character* cursor = value.c_str(); *cursor != 0; ++cursor) {
        converted.push_back(static_cast<char>(*cursor & 0x7f));
      }
      return converted;
    }
  } else {
    return std::to_string(static_cast<long long>(value));
  }
}

inline std::string boolPayload(bool value) { return value ? "1" : "0"; }

template <typename T>
inline std::string payload(const T& value) {
  if constexpr (HasCString<T>::value) {
    return resourceKey(value);
  } else {
    return std::to_string(static_cast<long double>(value));
  }
}

template <typename T>
inline void assignPayload(T& target, const std::string& value) {
  if constexpr (HasCString<T>::value) {
    using Character = std::remove_cv_t<std::remove_pointer_t<
        decltype(target.c_str())>>;
    if constexpr (std::is_same_v<Character, char>) {
      target = value.c_str();
    } else {
      std::basic_string<Character> converted;
      for (const char character : value) {
        converted.push_back(static_cast<Character>(
            static_cast<unsigned char>(character)));
      }
      target = converted.c_str();
    }
  } else {
    try {
      target = static_cast<double>(std::stod(value));
    } catch (...) {
      target = {};
    }
  }
}

}  // namespace beckhoff_virtual

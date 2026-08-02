// WOK Runtime Lab dedicated ETL recorder.
// Records PresentMon's filtered provider set to an immutable, offline-replay ETL.

#include <Windows.h>
#include <bcrypt.h>
#include <evntrace.h>
#include <tdh.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <iterator>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "PresentData/ETW/Microsoft_Windows_Kernel_Process.h"
#include "PresentData/PresentMonTraceConsumer.hpp"
#include "PresentData/PresentMonTraceSession.hpp"

// PresentData links against CommonUtilities logging but this recorder intentionally
// has no log sink. This is the same null factory used by PresentMon's console app.
namespace pmon::util::log {
std::shared_ptr<class IChannel> GetDefaultChannel() noexcept
{
    return {};
}
}

namespace {

constexpr ULONG kBufferSizeKiB = 64;
constexpr ULONG kMinimumBuffers = 256;
constexpr ULONG kMaximumBuffers = 1024;
constexpr ULONG kFlushTimerSeconds = 0;
constexpr DWORD kMinimumDurationMs = 100;
constexpr DWORD kMaximumDurationMs = 10 * 60 * 1000;
constexpr DWORD kStopRetryDelayMs = 100;
constexpr DWORD kStopCleanupDeadlineMs = 30 * 1000;
constexpr DWORD kConsoleFinalizationWaitMs = 35 * 1000;
constexpr DWORD kControllerReleaseGuardMs = 15 * 60 * 1000;
constexpr DWORD kReleaseReadCancellationWaitMs = 5 * 1000;
constexpr DWORD kProviderEnableTimeoutMs = 10 * 1000;
constexpr size_t kReleaseTokenLength = 32;
constexpr size_t kSha256Length = 32;
constexpr size_t kHashBufferSize = 1024 * 1024;
constexpr size_t kMaximumProcessEventCount = 100000;
constexpr ULONGLONG kDotNetFileTimeEpochOffsetTicks =
    504911232000000000ULL;
constexpr ULONGLONG kMaximumDotNetDateTimeTicks =
    3155378975999999999ULL;
constexpr ULONGLONG kMaximumSafeInteger = 9007199254740991ULL;
constexpr std::string_view kUnavailableSha256 =
    "0000000000000000000000000000000000000000000000000000000000000000";

class UniqueHandle {
public:
    UniqueHandle() = default;
    explicit UniqueHandle(HANDLE handle) : handle_(handle) {}
    ~UniqueHandle() { Reset(); }

    UniqueHandle(UniqueHandle const&) = delete;
    UniqueHandle& operator=(UniqueHandle const&) = delete;

    UniqueHandle(UniqueHandle&& other) noexcept : handle_(other.Release()) {}
    UniqueHandle& operator=(UniqueHandle&& other) noexcept
    {
        if (this != &other) Reset(other.Release());
        return *this;
    }

    HANDLE Get() const { return handle_; }
    explicit operator bool() const
    {
        return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE;
    }
    HANDLE Release()
    {
        auto handle = handle_;
        handle_ = INVALID_HANDLE_VALUE;
        return handle;
    }
    void Reset(HANDLE handle = INVALID_HANDLE_VALUE)
    {
        if (*this) CloseHandle(handle_);
        handle_ = handle;
    }

private:
    HANDLE handle_ = INVALID_HANDLE_VALUE;
};

class UniqueAlgorithmHandle {
public:
    UniqueAlgorithmHandle() = default;
    ~UniqueAlgorithmHandle()
    {
        if (handle_ != nullptr) BCryptCloseAlgorithmProvider(handle_, 0);
    }

    UniqueAlgorithmHandle(UniqueAlgorithmHandle const&) = delete;
    UniqueAlgorithmHandle& operator=(UniqueAlgorithmHandle const&) = delete;

    BCRYPT_ALG_HANDLE* Address() { return &handle_; }
    BCRYPT_ALG_HANDLE Get() const { return handle_; }

private:
    BCRYPT_ALG_HANDLE handle_ = nullptr;
};

class UniqueHashHandle {
public:
    UniqueHashHandle() = default;
    ~UniqueHashHandle()
    {
        if (handle_ != nullptr) BCryptDestroyHash(handle_);
    }

    UniqueHashHandle(UniqueHashHandle const&) = delete;
    UniqueHashHandle& operator=(UniqueHashHandle const&) = delete;

    BCRYPT_HASH_HANDLE* Address() { return &handle_; }
    BCRYPT_HASH_HANDLE Get() const { return handle_; }

private:
    BCRYPT_HASH_HANDLE handle_ = nullptr;
};

struct TraceProperties {
    EVENT_TRACE_PROPERTIES properties{};
    wchar_t loggerName[1024]{};
    wchar_t logFileName[32768]{};
};

struct Options {
    std::wstring sessionName;
    std::filesystem::path etlPath;
    std::filesystem::path readyPath;
    std::filesystem::path statusPath;
    std::wstring releaseToken;
    DWORD durationMs = 0;
};

struct ArtifactFileIdentity {
    DWORD volumeSerialNumber = 0;
    ULONGLONG fileIndex = 0;
};

struct InspectOptions {
    std::filesystem::path etlPath;
    ArtifactFileIdentity expectedEtlIdentity;
    std::string expectedEtlSha256;
    uintmax_t expectedEtlSizeBytes = 0;
    DWORD targetProcessId = 0;
};

struct ProcessEventEvidence {
    enum class Kind {
        start,
        stop
    };

    Kind kind = Kind::start;
    ULONG sequence = 0;
    DWORD processId = 0;
    UCHAR eventVersion = 0;
    ULONGLONG eventTimestampFileTimeUtc = 0;
    ULONGLONG createTimeFileTimeUtc = 0;
    ULONGLONG creationTimeUtcTicks = 0;
    DWORD parentProcessId = 0;
    std::wstring executableName;
    ULONGLONG exitTimeFileTimeUtc = 0;
};

struct ProcessInspectionState {
    DWORD targetProcessId = 0;
    ULONG status = ERROR_SUCCESS;
    std::vector<ProcessEventEvidence> events;
};

struct PinnedArtifactPaths {
    UniqueHandle directory;
    UniqueHandle etlReservation;
    UniqueHandle readyTemporary;
    UniqueHandle statusTemporary;
    ArtifactFileIdentity etlIdentity;
    Options resolved;
};

struct SessionSnapshot {
    ULONG queryStatus = ERROR_INVALID_STATE;
    ULONG bufferSizeKiB = 0;
    ULONG minimumBuffers = 0;
    ULONG maximumBuffers = 0;
    ULONG numberOfBuffers = 0;
    ULONG freeBuffers = 0;
    ULONG eventsLost = 0;
    ULONG buffersWritten = 0;
    ULONG logBuffersLost = 0;
    ULONG realTimeBuffersLost = 0;
};

struct LiveProcessEventFilter {
    EVENT_FILTER_EVENT_ID eventIds{};
    USHORT additionalEventId = 0;
};

ULONG EnableRequiredLiveProcessEvents(
    TRACEHANDLE sessionHandle,
    GUID const& sessionGuid)
{
    static_assert(
        ANYSIZE_ARRAY == 1,
        "EVENT_FILTER_EVENT_ID must expose one inline event ID");
    static_assert(
        offsetof(LiveProcessEventFilter, additionalEventId) ==
            sizeof(EVENT_FILTER_EVENT_ID),
        "Live process event filter IDs must be contiguous");

    LiveProcessEventFilter filter{};
    filter.eventIds.FilterIn = TRUE;
    filter.eventIds.Count = 2;
    filter.eventIds.Events[0] =
        Microsoft_Windows_Kernel_Process::ProcessStart_Start::Id;
    filter.additionalEventId =
        Microsoft_Windows_Kernel_Process::ProcessStop_Stop::Id;

    EVENT_FILTER_DESCRIPTOR descriptor{};
    descriptor.Ptr = reinterpret_cast<ULONGLONG>(&filter.eventIds);
    descriptor.Size = sizeof(filter);
    descriptor.Type = EVENT_FILTER_TYPE_EVENT_ID;

    ENABLE_TRACE_PARAMETERS parameters{};
    parameters.Version = ENABLE_TRACE_PARAMETERS_VERSION_2;
    parameters.EnableProperty = EVENT_ENABLE_PROPERTY_IGNORE_KEYWORD_0;
    parameters.SourceId = sessionGuid;
    parameters.EnableFilterDesc = &descriptor;
    parameters.FilterDescCount = 1;

    auto keyword = static_cast<ULONGLONG>(
        Microsoft_Windows_Kernel_Process::ProcessStart_Start::Keyword);
    auto level = std::max(
        Microsoft_Windows_Kernel_Process::ProcessStart_Start::Level,
        Microsoft_Windows_Kernel_Process::ProcessStop_Stop::Level);
    return EnableTraceEx2(
        sessionHandle,
        &Microsoft_Windows_Kernel_Process::GUID,
        EVENT_CONTROL_CODE_ENABLE_PROVIDER,
        level,
        keyword,
        keyword,
        kProviderEnableTimeoutMs,
        &parameters);
}

SRWLOCK gConsoleCallbackLock = SRWLOCK_INIT;
HANDLE gStopEvent = nullptr;
HANDLE gFinalizationEvent = nullptr;
HANDLE gCallbacksDrainedEvent = nullptr;
bool gAcceptConsoleCallbacks = false;
ULONG gActiveConsoleCallbacks = 0;

bool BeginConsoleCallback(HANDLE& stopEvent, HANDLE& finalizationEvent)
{
    AcquireSRWLockExclusive(&gConsoleCallbackLock);
    if (!gAcceptConsoleCallbacks) {
        ReleaseSRWLockExclusive(&gConsoleCallbackLock);
        return false;
    }
    if (gActiveConsoleCallbacks == 0) ResetEvent(gCallbacksDrainedEvent);
    ++gActiveConsoleCallbacks;
    stopEvent = gStopEvent;
    finalizationEvent = gFinalizationEvent;
    ReleaseSRWLockExclusive(&gConsoleCallbackLock);
    return true;
}

void EndConsoleCallback()
{
    AcquireSRWLockExclusive(&gConsoleCallbackLock);
    if (--gActiveConsoleCallbacks == 0) SetEvent(gCallbacksDrainedEvent);
    ReleaseSRWLockExclusive(&gConsoleCallbackLock);
}

BOOL WINAPI HandleConsoleControl(DWORD controlType)
{
    switch (controlType) {
    case CTRL_C_EVENT:
    case CTRL_BREAK_EVENT:
    case CTRL_CLOSE_EVENT:
    case CTRL_LOGOFF_EVENT:
    case CTRL_SHUTDOWN_EVENT:
        break;
    default:
        return FALSE;
    }

    HANDLE stopEvent = nullptr;
    HANDLE finalizationEvent = nullptr;
    if (!BeginConsoleCallback(stopEvent, finalizationEvent)) return FALSE;

    SetEvent(stopEvent);
    if (controlType == CTRL_CLOSE_EVENT ||
        controlType == CTRL_LOGOFF_EVENT ||
        controlType == CTRL_SHUTDOWN_EVENT) {
        WaitForSingleObject(finalizationEvent, kConsoleFinalizationWaitMs);
    }
    EndConsoleCallback();
    return TRUE;
}

class ConsoleControlRegistration {
public:
    ConsoleControlRegistration() = default;

    bool Register(
        HANDLE stopEvent,
        HANDLE finalizationEvent,
        HANDLE callbacksDrainedEvent)
    {
        AcquireSRWLockExclusive(&gConsoleCallbackLock);
        gStopEvent = stopEvent;
        gFinalizationEvent = finalizationEvent;
        gCallbacksDrainedEvent = callbacksDrainedEvent;
        gActiveConsoleCallbacks = 0;
        gAcceptConsoleCallbacks = true;
        SetEvent(gCallbacksDrainedEvent);
        ReleaseSRWLockExclusive(&gConsoleCallbackLock);

        registered_ = SetConsoleCtrlHandler(HandleConsoleControl, TRUE) != FALSE;
        if (!registered_) ClearRegistrationState();
        return registered_;
    }

    ~ConsoleControlRegistration() { Complete(); }

    ConsoleControlRegistration(ConsoleControlRegistration const&) = delete;
    ConsoleControlRegistration& operator=(ConsoleControlRegistration const&) = delete;

    void Complete()
    {
        if (!registered_) return;

        SetEvent(gFinalizationEvent);
        AcquireSRWLockExclusive(&gConsoleCallbackLock);
        gAcceptConsoleCallbacks = false;
        auto callbacksDrainedEvent = gCallbacksDrainedEvent;
        ReleaseSRWLockExclusive(&gConsoleCallbackLock);

        SetConsoleCtrlHandler(HandleConsoleControl, FALSE);
        WaitForSingleObject(callbacksDrainedEvent, INFINITE);
        ClearRegistrationState();
        registered_ = false;
    }

private:
    static void ClearRegistrationState()
    {
        AcquireSRWLockExclusive(&gConsoleCallbackLock);
        gAcceptConsoleCallbacks = false;
        gStopEvent = nullptr;
        gFinalizationEvent = nullptr;
        gCallbacksDrainedEvent = nullptr;
        gActiveConsoleCallbacks = 0;
        ReleaseSRWLockExclusive(&gConsoleCallbackLock);
    }

    bool registered_ = false;
};

std::string ToUtf8(std::wstring_view value)
{
    if (value.empty()) return {};
    if (value.size() > static_cast<size_t>(std::numeric_limits<int>::max())) {
        throw std::length_error("wide string is too large");
    }
    auto required = WideCharToMultiByte(
        CP_UTF8,
        WC_ERR_INVALID_CHARS,
        value.data(),
        static_cast<int>(value.size()),
        nullptr,
        0,
        nullptr,
        nullptr);
    if (required <= 0) {
        throw std::runtime_error("WideCharToMultiByte size query failed");
    }
    std::string result(static_cast<size_t>(required), '\0');
    auto written = WideCharToMultiByte(
        CP_UTF8,
        WC_ERR_INVALID_CHARS,
        value.data(),
        static_cast<int>(value.size()),
        result.data(),
        required,
        nullptr,
        nullptr);
    if (written != required) {
        throw std::runtime_error("WideCharToMultiByte conversion failed");
    }
    return result;
}

std::string JsonEscape(std::string_view value)
{
    std::ostringstream out;
    for (unsigned char c : value) {
        switch (c) {
        case '"': out << "\\\""; break;
        case '\\': out << "\\\\"; break;
        case '\b': out << "\\b"; break;
        case '\f': out << "\\f"; break;
        case '\n': out << "\\n"; break;
        case '\r': out << "\\r"; break;
        case '\t': out << "\\t"; break;
        default:
            if (c < 0x20) {
                constexpr char hex[] = "0123456789abcdef";
                out << "\\u00" << hex[(c >> 4) & 0x0f] << hex[c & 0x0f];
            } else {
                out << static_cast<char>(c);
            }
        }
    }
    return out.str();
}

std::string JsonString(std::wstring_view value)
{
    return "\"" + JsonEscape(ToUtf8(value)) + "\"";
}

std::string JsonPath(std::filesystem::path const& value)
{
    return JsonString(std::wstring_view(value.native()));
}

bool RenameOpenFileWithoutReplacement(
    HANDLE file,
    std::filesystem::path const& destinationPath)
{
    auto const& name = destinationPath.native();
    if (name.empty() || !destinationPath.is_absolute()) return false;
    auto nameBytes = name.size() * sizeof(wchar_t);
    if (nameBytes > std::numeric_limits<DWORD>::max()) return false;
    auto bufferSize = sizeof(FILE_RENAME_INFO) + nameBytes;
    if (bufferSize > std::numeric_limits<DWORD>::max()) return false;

    std::vector<std::byte> buffer(bufferSize);
    auto info = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
    info->ReplaceIfExists = FALSE;
    info->RootDirectory = nullptr;
    info->FileNameLength = static_cast<DWORD>(nameBytes);
    std::memcpy(info->FileName, name.data(), nameBytes);
    return SetFileInformationByHandle(
               file,
               FileRenameInfo,
               info,
               static_cast<DWORD>(bufferSize)) != FALSE;
}

bool PublishFreshFile(
    HANDLE file,
    std::filesystem::path const& destinationPath,
    std::string_view contents)
{
    size_t offset = 0;
    while (offset < contents.size()) {
        auto remaining = contents.size() - offset;
        auto chunkSize = static_cast<DWORD>(std::min<size_t>(
            remaining,
            std::numeric_limits<DWORD>::max()));
        DWORD chunkWritten = 0;
        if (!WriteFile(
                file,
                contents.data() + offset,
                chunkSize,
                &chunkWritten,
                nullptr) ||
            chunkWritten != chunkSize) {
            return false;
        }
        offset += chunkWritten;
    }
    return FlushFileBuffers(file) &&
        RenameOpenFileWithoutReplacement(
            file,
            destinationPath);
}

std::optional<DWORD> ParseDuration(std::wstring_view value)
{
    if (value.empty()) return std::nullopt;
    uint64_t parsed = 0;
    for (auto c : value) {
        if (c < L'0' || c > L'9') return std::nullopt;
        parsed = parsed * 10 + static_cast<uint64_t>(c - L'0');
        if (parsed > kMaximumDurationMs) return std::nullopt;
    }
    if (parsed < kMinimumDurationMs || parsed > kMaximumDurationMs) {
        return std::nullopt;
    }
    return static_cast<DWORD>(parsed);
}

std::optional<ULONGLONG> ParseUnsignedDecimal(
    std::wstring_view value,
    ULONGLONG maximum,
    bool allowZero)
{
    if (value.empty() || (value.size() > 1 && value.front() == L'0')) {
        return std::nullopt;
    }
    ULONGLONG parsed = 0;
    for (auto character : value) {
        if (character < L'0' || character > L'9') return std::nullopt;
        auto digit = static_cast<ULONGLONG>(character - L'0');
        if (parsed > (maximum - digit) / 10) return std::nullopt;
        parsed = parsed * 10 + digit;
    }
    if ((!allowZero && parsed == 0) || parsed > maximum) {
        return std::nullopt;
    }
    return parsed;
}

std::optional<ULONGLONG> ParseLowerHex64(std::wstring_view value)
{
    if (value.size() != 16) return std::nullopt;
    ULONGLONG parsed = 0;
    for (auto character : value) {
        unsigned digit = 0;
        if (character >= L'0' && character <= L'9') {
            digit = static_cast<unsigned>(character - L'0');
        } else if (character >= L'a' && character <= L'f') {
            digit = static_cast<unsigned>(character - L'a' + 10);
        } else {
            return std::nullopt;
        }
        parsed = (parsed << 4) | digit;
    }
    return parsed;
}

std::optional<std::string> ParseSha256(std::wstring_view value)
{
    if (value.size() != kSha256Length * 2) return std::nullopt;
    for (auto character : value) {
        bool accepted = (character >= L'0' && character <= L'9') ||
            (character >= L'a' && character <= L'f');
        if (!accepted) return std::nullopt;
    }
    return ToUtf8(value);
}

bool IsValidReleaseToken(std::wstring_view value)
{
    if (value.size() != kReleaseTokenLength) return false;
    return std::all_of(value.begin(), value.end(), [](wchar_t character) {
        return (character >= L'0' && character <= L'9') ||
            (character >= L'a' && character <= L'f');
    });
}

bool EqualOrdinalIgnoreCase(std::wstring_view left, std::wstring_view right)
{
    if (left.size() > static_cast<size_t>(std::numeric_limits<int>::max()) ||
        right.size() > static_cast<size_t>(std::numeric_limits<int>::max())) {
        return false;
    }
    return CompareStringOrdinal(
               left.data(),
               static_cast<int>(left.size()),
               right.data(),
               static_cast<int>(right.size()),
               TRUE) == CSTR_EQUAL;
}

bool IsSafeArtifactFilename(
    std::filesystem::path const& path,
    std::wstring_view expectedExtension)
{
    auto filename = path.filename().native();
    if (filename.empty() || filename.size() > 240) return false;
    if (!EqualOrdinalIgnoreCase(path.extension().native(), expectedExtension)) return false;
    if (filename.back() == L'.' || filename.back() == L' ') return false;
    for (auto character : filename) {
        bool accepted = (character >= L'a' && character <= L'z') ||
            (character >= L'A' && character <= L'Z') ||
            (character >= L'0' && character <= L'9') ||
            character == L'.' || character == L'_' || character == L'-';
        if (!accepted) return false;
    }

    constexpr std::array<std::wstring_view, 22> reservedNames{
        L"CON", L"PRN", L"AUX", L"NUL",
        L"COM1", L"COM2", L"COM3", L"COM4", L"COM5", L"COM6", L"COM7", L"COM8", L"COM9",
        L"LPT1", L"LPT2", L"LPT3", L"LPT4", L"LPT5", L"LPT6", L"LPT7", L"LPT8", L"LPT9"};
    auto firstPeriod = filename.find(L'.');
    auto deviceStem = std::wstring_view(filename).substr(0, firstPeriod);
    return std::none_of(
        reservedNames.begin(),
        reservedNames.end(),
        [&](std::wstring_view reserved) {
            return EqualOrdinalIgnoreCase(deviceStem, reserved);
        });
}

UniqueHandle OpenArtifactDirectory(std::filesystem::path const& parent)
{
    return UniqueHandle(CreateFileW(
        parent.c_str(),
        FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        nullptr));
}

std::optional<ArtifactFileIdentity> GetArtifactFileIdentity(HANDLE file)
{
    BY_HANDLE_FILE_INFORMATION information{};
    if (!GetFileInformationByHandle(file, &information)) return std::nullopt;
    ArtifactFileIdentity identity;
    identity.volumeSerialNumber = information.dwVolumeSerialNumber;
    identity.fileIndex =
        (static_cast<ULONGLONG>(information.nFileIndexHigh) << 32) |
        information.nFileIndexLow;
    return identity;
}

bool SameArtifactFileIdentity(
    ArtifactFileIdentity const& left,
    ArtifactFileIdentity const& right)
{
    return left.volumeSerialNumber == right.volumeSerialNumber &&
        left.fileIndex == right.fileIndex;
}

bool SameDirectoryIdentity(HANDLE left, HANDLE right)
{
    BY_HANDLE_FILE_INFORMATION leftInfo{};
    BY_HANDLE_FILE_INFORMATION rightInfo{};
    if (!GetFileInformationByHandle(left, &leftInfo) ||
        !GetFileInformationByHandle(right, &rightInfo)) {
        return false;
    }
    return (leftInfo.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
        (rightInfo.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
        leftInfo.dwVolumeSerialNumber == rightInfo.dwVolumeSerialNumber &&
        leftInfo.nFileIndexHigh == rightInfo.nFileIndexHigh &&
        leftInfo.nFileIndexLow == rightInfo.nFileIndexLow;
}

bool PathIdentifiesArtifact(
    std::filesystem::path const& path,
    ArtifactFileIdentity const& expected)
{
    UniqueHandle file(CreateFileW(
        path.c_str(),
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr));
    if (!file) return false;
    auto actual = GetArtifactFileIdentity(file.Get());
    return actual.has_value() && SameArtifactFileIdentity(*actual, expected);
}

std::string FileIndexHex(ArtifactFileIdentity const& identity)
{
    constexpr char hex[] = "0123456789abcdef";
    std::string result(16, '0');
    auto value = identity.fileIndex;
    for (size_t index = result.size(); index > 0; --index) {
        result[index - 1] = hex[value & 0x0f];
        value >>= 4;
    }
    return result;
}

ULONGLONG FileTimeTicksUtc()
{
    FILETIME fileTime{};
    using GetSystemTimePreciseAsFileTimeFn = void(WINAPI*)(LPFILETIME);
    static auto preciseClock = reinterpret_cast<
        GetSystemTimePreciseAsFileTimeFn>(GetProcAddress(
            GetModuleHandleW(L"kernel32.dll"),
            "GetSystemTimePreciseAsFileTime"));
    if (preciseClock != nullptr) preciseClock(&fileTime);
    else GetSystemTimeAsFileTime(&fileTime);
    ULARGE_INTEGER ticks{};
    ticks.HighPart = fileTime.dwHighDateTime;
    ticks.LowPart = fileTime.dwLowDateTime;
    return ticks.QuadPart;
}

std::string UnsignedDecimal(ULONGLONG value)
{
    return std::to_string(value);
}

std::optional<std::filesystem::path> FinalDirectoryPath(HANDLE directory)
{
    auto required = GetFinalPathNameByHandleW(
        directory,
        nullptr,
        0,
        FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
    if (required == 0) return std::nullopt;
    std::wstring buffer(static_cast<size_t>(required), L'\0');
    auto written = GetFinalPathNameByHandleW(
        directory,
        buffer.data(),
        required,
        FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
    if (written == 0 || written >= required) return std::nullopt;
    buffer.resize(written);
    return std::filesystem::path(buffer);
}

bool FreshArtifactPath(std::filesystem::path const& path)
{
    auto attributes = GetFileAttributesW(path.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES) {
        SetLastError(ERROR_ALREADY_EXISTS);
        return false;
    }
    auto error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
}

std::optional<PinnedArtifactPaths> PinArtifactPaths(Options const& options)
{
    if (!IsSafeArtifactFilename(options.etlPath, L".etl") ||
        !IsSafeArtifactFilename(options.readyPath, L".json") ||
        !IsSafeArtifactFilename(options.statusPath, L".json")) {
        SetLastError(ERROR_INVALID_NAME);
        return std::nullopt;
    }

    auto directory = OpenArtifactDirectory(options.etlPath.parent_path());
    if (!directory) return std::nullopt;
    for (auto const& path : {options.readyPath, options.statusPath}) {
        auto otherDirectory = OpenArtifactDirectory(path.parent_path());
        if (!otherDirectory ||
            !SameDirectoryIdentity(directory.Get(), otherDirectory.Get())) {
            SetLastError(ERROR_INVALID_PARAMETER);
            return std::nullopt;
        }
    }

    auto finalParent = FinalDirectoryPath(directory.Get());
    if (!finalParent.has_value()) return std::nullopt;
    Options resolved = options;
    resolved.etlPath = *finalParent / options.etlPath.filename();
    resolved.readyPath = *finalParent / options.readyPath.filename();
    resolved.statusPath = *finalParent / options.statusPath.filename();

    auto readyTemporaryPath = resolved.readyPath;
    readyTemporaryPath += L".tmp";
    auto statusTemporaryPath = resolved.statusPath;
    statusTemporaryPath += L".tmp";
    std::array destinations{
        resolved.etlPath,
        resolved.readyPath,
        resolved.statusPath,
        readyTemporaryPath,
        statusTemporaryPath};
    for (size_t left = 0; left < destinations.size(); ++left) {
        if (!FreshArtifactPath(destinations[left])) return std::nullopt;
        for (size_t right = left + 1; right < destinations.size(); ++right) {
            if (EqualOrdinalIgnoreCase(
                    destinations[left].native(),
                    destinations[right].native())) {
                SetLastError(ERROR_INVALID_NAME);
                return std::nullopt;
            }
        }
    }

    UniqueHandle etlReservation(CreateFileW(
        resolved.etlPath.c_str(),
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL,
        nullptr));
    if (!etlReservation) return std::nullopt;
    auto etlIdentity = GetArtifactFileIdentity(etlReservation.Get());
    if (!etlIdentity.has_value()) return std::nullopt;

    UniqueHandle readyTemporary(CreateFileW(
        readyTemporaryPath.c_str(),
        GENERIC_WRITE | DELETE,
        FILE_SHARE_READ,
        nullptr,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
        nullptr));
    if (!readyTemporary) return std::nullopt;

    UniqueHandle statusTemporary(CreateFileW(
        statusTemporaryPath.c_str(),
        GENERIC_WRITE | DELETE,
        FILE_SHARE_READ,
        nullptr,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
        nullptr));
    if (!statusTemporary) return std::nullopt;

    PinnedArtifactPaths result;
    result.directory = std::move(directory);
    result.etlReservation = std::move(etlReservation);
    result.readyTemporary = std::move(readyTemporary);
    result.statusTemporary = std::move(statusTemporary);
    result.etlIdentity = *etlIdentity;
    result.resolved = std::move(resolved);
    return result;
}

std::optional<Options> ParseOptions(int argc, wchar_t** argv)
{
    Options options;
    bool sessionNameSeen = false;
    bool etlPathSeen = false;
    bool readyPathSeen = false;
    bool statusPathSeen = false;
    bool durationSeen = false;
    bool releaseTokenSeen = false;
    for (int i = 1; i < argc; i += 2) {
        if (i + 1 >= argc) return std::nullopt;
        std::wstring_view name(argv[i]);
        std::wstring_view value(argv[i + 1]);
        if (name == L"--session-name") {
            if (sessionNameSeen) return std::nullopt;
            sessionNameSeen = true;
            options.sessionName = value;
        } else if (name == L"--etl-file") {
            if (etlPathSeen) return std::nullopt;
            etlPathSeen = true;
            options.etlPath = value;
        } else if (name == L"--ready-file") {
            if (readyPathSeen) return std::nullopt;
            readyPathSeen = true;
            options.readyPath = value;
        } else if (name == L"--status-file") {
            if (statusPathSeen) return std::nullopt;
            statusPathSeen = true;
            options.statusPath = value;
        } else if (name == L"--duration-ms") {
            if (durationSeen) return std::nullopt;
            durationSeen = true;
            auto duration = ParseDuration(value);
            if (!duration.has_value()) return std::nullopt;
            options.durationMs = *duration;
        } else if (name == L"--release-token") {
            if (releaseTokenSeen || !IsValidReleaseToken(value)) {
                return std::nullopt;
            }
            releaseTokenSeen = true;
            options.releaseToken = value;
        } else {
            return std::nullopt;
        }
    }

    if (options.sessionName.empty() || options.sessionName.size() >= 1024) return std::nullopt;
    if (options.etlPath.empty() || options.readyPath.empty() || options.statusPath.empty()) return std::nullopt;
    if (options.durationMs == 0 || !IsValidReleaseToken(options.releaseToken)) return std::nullopt;
    if (!options.etlPath.is_absolute() || !options.readyPath.is_absolute() || !options.statusPath.is_absolute()) {
        return std::nullopt;
    }
    if (options.etlPath == options.readyPath || options.etlPath == options.statusPath || options.readyPath == options.statusPath) {
        return std::nullopt;
    }
    return options;
}

std::optional<InspectOptions> ParseInspectOptions(int argc, wchar_t** argv)
{
    InspectOptions options;
    bool etlPathSeen = false;
    bool etlSha256Seen = false;
    bool etlSizeSeen = false;
    bool etlFileIndexSeen = false;
    bool etlVolumeSeen = false;
    bool targetProcessIdSeen = false;
    for (int i = 1; i < argc; i += 2) {
        if (i + 1 >= argc) return std::nullopt;
        std::wstring_view name(argv[i]);
        std::wstring_view value(argv[i + 1]);
        if (name == L"--inspect-etl") {
            if (etlPathSeen) return std::nullopt;
            etlPathSeen = true;
            options.etlPath = value;
        } else if (name == L"--expected-etl-sha256") {
            if (etlSha256Seen) return std::nullopt;
            etlSha256Seen = true;
            auto sha256 = ParseSha256(value);
            if (!sha256.has_value()) return std::nullopt;
            options.expectedEtlSha256 = *sha256;
        } else if (name == L"--expected-etl-size-bytes") {
            if (etlSizeSeen) return std::nullopt;
            etlSizeSeen = true;
            auto size = ParseUnsignedDecimal(
                value,
                kMaximumSafeInteger,
                false);
            if (!size.has_value()) return std::nullopt;
            options.expectedEtlSizeBytes =
                static_cast<uintmax_t>(*size);
        } else if (name == L"--expected-etl-file-index") {
            if (etlFileIndexSeen) return std::nullopt;
            etlFileIndexSeen = true;
            auto fileIndex = ParseLowerHex64(value);
            if (!fileIndex.has_value()) return std::nullopt;
            options.expectedEtlIdentity.fileIndex = *fileIndex;
        } else if (name == L"--expected-etl-volume-serial-number") {
            if (etlVolumeSeen) return std::nullopt;
            etlVolumeSeen = true;
            auto volume = ParseUnsignedDecimal(
                value,
                std::numeric_limits<DWORD>::max(),
                true);
            if (!volume.has_value()) return std::nullopt;
            options.expectedEtlIdentity.volumeSerialNumber =
                static_cast<DWORD>(*volume);
        } else if (name == L"--target-process-id") {
            if (targetProcessIdSeen) return std::nullopt;
            targetProcessIdSeen = true;
            auto processId = ParseUnsignedDecimal(
                value,
                std::numeric_limits<DWORD>::max(),
                false);
            if (!processId.has_value()) return std::nullopt;
            options.targetProcessId = static_cast<DWORD>(*processId);
        } else {
            return std::nullopt;
        }
    }

    if (!etlPathSeen ||
        !etlSha256Seen ||
        !etlSizeSeen ||
        !etlFileIndexSeen ||
        !etlVolumeSeen ||
        !targetProcessIdSeen ||
        !options.etlPath.is_absolute() ||
        !IsSafeArtifactFilename(options.etlPath, L".etl")) {
        return std::nullopt;
    }
    return options;
}

bool CopyWideString(wchar_t* destination, size_t destinationCount, std::wstring const& source)
{
    if (source.size() + 1 > destinationCount) return false;
    std::copy(source.begin(), source.end(), destination);
    destination[source.size()] = L'\0';
    return true;
}

TraceProperties MakeStartProperties(std::filesystem::path const& etlPath)
{
    TraceProperties trace{};
    trace.properties.Wnode.BufferSize = sizeof(trace);
    trace.properties.Wnode.ClientContext = 1; // QPC timestamps.
    trace.properties.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
    trace.properties.BufferSize = kBufferSizeKiB;
    trace.properties.MinimumBuffers = kMinimumBuffers;
    trace.properties.MaximumBuffers = kMaximumBuffers;
    trace.properties.FlushTimer = kFlushTimerSeconds;
    trace.properties.LogFileMode = EVENT_TRACE_FILE_MODE_SEQUENTIAL;
    trace.properties.LoggerNameOffset = offsetof(TraceProperties, loggerName);
    trace.properties.LogFileNameOffset = offsetof(TraceProperties, logFileName);
    if (!CopyWideString(
            trace.logFileName,
            std::size(trace.logFileName),
            etlPath.native())) {
        throw std::length_error("ETL path exceeds recorder buffer");
    }
    return trace;
}

TraceProperties MakeQueryProperties()
{
    TraceProperties trace{};
    trace.properties.Wnode.BufferSize = sizeof(trace);
    trace.properties.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
    trace.properties.LoggerNameOffset = offsetof(TraceProperties, loggerName);
    trace.properties.LogFileNameOffset = offsetof(TraceProperties, logFileName);
    return trace;
}

SessionSnapshot Snapshot(TRACEHANDLE handle)
{
    auto trace = MakeQueryProperties();
    SessionSnapshot snapshot{};
    snapshot.queryStatus = ControlTraceW(
        handle,
        nullptr,
        &trace.properties,
        EVENT_TRACE_CONTROL_QUERY);
    if (snapshot.queryStatus == ERROR_SUCCESS) {
        snapshot.bufferSizeKiB = trace.properties.BufferSize;
        snapshot.minimumBuffers = trace.properties.MinimumBuffers;
        snapshot.maximumBuffers = trace.properties.MaximumBuffers;
        snapshot.numberOfBuffers = trace.properties.NumberOfBuffers;
        snapshot.freeBuffers = trace.properties.FreeBuffers;
        snapshot.eventsLost = trace.properties.EventsLost;
        snapshot.buffersWritten = trace.properties.BuffersWritten;
        snapshot.logBuffersLost = trace.properties.LogBuffersLost;
        snapshot.realTimeBuffersLost = trace.properties.RealTimeBuffersLost;
    }
    return snapshot;
}

struct StopAttempt {
    ULONG status = ERROR_INVALID_STATE;
    ULONGLONG captureStopFileTimeUtc = 0;
    SessionSnapshot snapshot{};
};

struct StopOutcome {
    ULONG primaryStatus = ERROR_INVALID_STATE;
    ULONG cleanupStatus = ERROR_INVALID_STATE;
    bool etlFinalized = false;
    ULONGLONG captureStopFileTimeUtc = 0;
    SessionSnapshot stopped{};
    std::vector<ULONG> attemptStatuses;
};

StopAttempt StopSession(TRACEHANDLE handle)
{
    auto trace = MakeQueryProperties();
    StopAttempt attempt;
    attempt.status = ControlTraceW(
        handle,
        nullptr,
        &trace.properties,
        EVENT_TRACE_CONTROL_STOP);
    if (attempt.status == ERROR_SUCCESS) {
        attempt.captureStopFileTimeUtc = FileTimeTicksUtc();
    }
    attempt.snapshot.queryStatus = attempt.status;
    if (attempt.status == ERROR_SUCCESS) {
        attempt.snapshot.bufferSizeKiB = trace.properties.BufferSize;
        attempt.snapshot.minimumBuffers = trace.properties.MinimumBuffers;
        attempt.snapshot.maximumBuffers = trace.properties.MaximumBuffers;
        attempt.snapshot.numberOfBuffers = trace.properties.NumberOfBuffers;
        attempt.snapshot.freeBuffers = trace.properties.FreeBuffers;
        attempt.snapshot.eventsLost = trace.properties.EventsLost;
        attempt.snapshot.buffersWritten = trace.properties.BuffersWritten;
        attempt.snapshot.logBuffersLost = trace.properties.LogBuffersLost;
        attempt.snapshot.realTimeBuffersLost = trace.properties.RealTimeBuffersLost;
    }
    return attempt;
}

StopOutcome StopSessionDeterministically(TRACEHANDLE handle)
{
    StopOutcome outcome;
    auto startedAt = GetTickCount64();
    for (;;) {
        auto attempt = StopSession(handle);
        outcome.attemptStatuses.push_back(attempt.status);
        if (outcome.attemptStatuses.size() == 1) {
            outcome.primaryStatus = attempt.status;
        }
        outcome.cleanupStatus = attempt.status;
        if (attempt.status == ERROR_SUCCESS) {
            outcome.etlFinalized = true;
            outcome.captureStopFileTimeUtc =
                attempt.captureStopFileTimeUtc;
            outcome.stopped = attempt.snapshot;
            return outcome;
        }

        auto elapsed = GetTickCount64() - startedAt;
        if (elapsed >= kStopCleanupDeadlineMs) return outcome;
        auto remaining = kStopCleanupDeadlineMs - static_cast<DWORD>(elapsed);
        Sleep(std::min(kStopRetryDelayMs, remaining));
    }
}

std::pair<bool, bool> DetectFilteringCapabilities()
{
    bool isWin81OrGreater = false;
    bool isWin11OrGreater = false;
    auto module = LoadLibraryExW(L"ntdll.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (module == nullptr) return {false, false};
    using RtlGetVersionFn = LONG(WINAPI*)(RTL_OSVERSIONINFOW*);
    auto rtlGetVersion = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(module, "RtlGetVersion"));
    if (rtlGetVersion != nullptr) {
        RTL_OSVERSIONINFOW info{};
        info.dwOSVersionInfoSize = sizeof(info);
        if (rtlGetVersion(&info) == 0) {
            isWin81OrGreater = info.dwMajorVersion > 6 ||
                (info.dwMajorVersion == 6 && info.dwMinorVersion >= 3);
            isWin11OrGreater = info.dwMajorVersion > 10 ||
                (info.dwMajorVersion == 10 && info.dwBuildNumber >= 22000);
        }
    }
    FreeLibrary(module);
    return {isWin81OrGreater, isWin11OrGreater};
}

std::string SnapshotJson(SessionSnapshot const& value)
{
    std::ostringstream out;
    out << "{"
        << "\"queryStatus\":" << value.queryStatus << ','
        << "\"bufferSizeKiB\":" << value.bufferSizeKiB << ','
        << "\"minimumBuffers\":" << value.minimumBuffers << ','
        << "\"maximumBuffers\":" << value.maximumBuffers << ','
        << "\"numberOfBuffers\":" << value.numberOfBuffers << ','
        << "\"freeBuffers\":" << value.freeBuffers << ','
        << "\"eventsLost\":" << value.eventsLost << ','
        << "\"buffersWritten\":" << value.buffersWritten << ','
        << "\"logBuffersLost\":" << value.logBuffersLost << ','
        << "\"realTimeBuffersLost\":" << value.realTimeBuffersLost
        << "}";
    return out.str();
}

std::string StatusArrayJson(std::vector<ULONG> const& statuses)
{
    std::ostringstream out;
    out << '[';
    for (size_t index = 0; index < statuses.size(); ++index) {
        if (index != 0) out << ',';
        out << statuses[index];
    }
    out << ']';
    return out.str();
}

std::string ReadyJson(
    Options const& options,
    std::filesystem::path const& operationalEtlPath,
    ArtifactFileIdentity const& etlIdentity,
    bool etlIdentityVerifiedForCapture,
    ULONGLONG captureStartFileTimeUtc,
    SessionSnapshot const& initial,
    bool filterEventIds,
    bool processEventsEnabled,
    bool isWin11OrGreater)
{
    std::ostringstream out;
    out << "{\n"
        << "  \"version\": 5,\n"
        << "  \"phase\": \"ready\",\n"
        << "  \"captureStartFileTimeUtc\": \""
        << UnsignedDecimal(captureStartFileTimeUtc) << "\",\n"
        << "  \"sessionName\": " << JsonString(options.sessionName) << ",\n"
        << "  \"etlPath\": " << JsonPath(options.etlPath) << ",\n"
        << "  \"operationalEtlPath\": " << JsonPath(operationalEtlPath) << ",\n"
        << "  \"etlVolumeSerialNumber\": \"" << etlIdentity.volumeSerialNumber << "\",\n"
        << "  \"etlFileIndex\": \"" << FileIndexHex(etlIdentity) << "\",\n"
        << "  \"etlIdentityVerifiedForCapture\": "
        << (etlIdentityVerifiedForCapture ? "true" : "false") << ",\n"
        << "  \"durationMs\": " << options.durationMs << ",\n"
        << "  \"filterEventIds\": " << (filterEventIds ? "true" : "false") << ",\n"
        << "  \"processEventsRequired\": true,\n"
        << "  \"processEventsEnabled\": " << (processEventsEnabled ? "true" : "false") << ",\n"
        << "  \"processRundownRequested\": false,\n"
        << "  \"isWin11OrGreater\": " << (isWin11OrGreater ? "true" : "false") << ",\n"
        << "  \"requested\": {\"bufferSizeKiB\":64,\"minimumBuffers\":256,\"maximumBuffers\":1024,\"flushTimerSeconds\":0},\n"
        << "  \"effective\": " << SnapshotJson(initial) << "\n"
        << "}\n";
    return out.str();
}

std::string StatusJson(
    Options const& options,
    std::filesystem::path const& operationalEtlPath,
    ArtifactFileIdentity const& etlIdentity,
    bool etlIdentityVerifiedForCapture,
    bool etlIdentityVerifiedAfterStop,
    ULONGLONG captureStartFileTimeUtc,
    ULONGLONG captureStopFileTimeUtc,
    ULONG startStatus,
    ULONG providerStatus,
    bool filterEventIds,
    bool processEventsEnabled,
    SessionSnapshot const& initial,
    DWORD waitStatus,
    SessionSnapshot const& beforeStop,
    StopOutcome const& stopOutcome,
    bool etlExists,
    uintmax_t etlSizeBytes,
    std::string_view etlSha256,
    bool etlReadLeaseHeld,
    bool valid)
{
    std::ostringstream out;
    out << "{\n"
        << "  \"version\": 5,\n"
        << "  \"phase\": \"completed\",\n"
        << "  \"valid\": " << (valid ? "true" : "false") << ",\n"
        << "  \"captureStartFileTimeUtc\": \""
        << UnsignedDecimal(captureStartFileTimeUtc) << "\",\n"
        << "  \"captureStopFileTimeUtc\": \""
        << UnsignedDecimal(captureStopFileTimeUtc) << "\",\n"
        << "  \"sessionName\": " << JsonString(options.sessionName) << ",\n"
        << "  \"etlPath\": " << JsonPath(options.etlPath) << ",\n"
        << "  \"operationalEtlPath\": " << JsonPath(operationalEtlPath) << ",\n"
        << "  \"etlVolumeSerialNumber\": \"" << etlIdentity.volumeSerialNumber << "\",\n"
        << "  \"etlFileIndex\": \"" << FileIndexHex(etlIdentity) << "\",\n"
        << "  \"etlIdentityVerifiedForCapture\": "
        << (etlIdentityVerifiedForCapture ? "true" : "false") << ",\n"
        << "  \"etlIdentityVerifiedAfterStop\": "
        << (etlIdentityVerifiedAfterStop ? "true" : "false") << ",\n"
        << "  \"durationMs\": " << options.durationMs << ",\n"
        << "  \"filterEventIds\": " << (filterEventIds ? "true" : "false") << ",\n"
        << "  \"processEventsRequired\": true,\n"
        << "  \"processEventsEnabled\": " << (processEventsEnabled ? "true" : "false") << ",\n"
        << "  \"processRundownRequested\": false,\n"
        << "  \"startStatus\": " << startStatus << ",\n"
        << "  \"providerStatus\": " << providerStatus << ",\n"
        << "  \"initial\": " << SnapshotJson(initial) << ",\n"
        << "  \"waitStatus\": " << waitStatus << ",\n"
        << "  \"beforeStop\": " << SnapshotJson(beforeStop) << ",\n"
        << "  \"stopStatus\": " << stopOutcome.primaryStatus << ",\n"
        << "  \"cleanupStopStatus\": " << stopOutcome.cleanupStatus << ",\n"
        << "  \"stopAttemptStatuses\": " << StatusArrayJson(stopOutcome.attemptStatuses) << ",\n"
        << "  \"etlFinalized\": " << (stopOutcome.etlFinalized ? "true" : "false") << ",\n"
        << "  \"stopped\": " << SnapshotJson(stopOutcome.stopped) << ",\n"
        << "  \"etlExists\": " << (etlExists ? "true" : "false") << ",\n"
        << "  \"etlSizeBytes\": " << etlSizeBytes << ",\n"
        << "  \"etlSha256\": \"" << etlSha256 << "\",\n"
        << "  \"etlReadLease\": \""
        << (etlReadLeaseHeld
                ? "held-until-controller-release"
                : "unavailable")
        << "\"\n"
        << "}\n";
    return out.str();
}

bool HasLoss(SessionSnapshot const& snapshot)
{
    return snapshot.eventsLost != 0 ||
        snapshot.logBuffersLost != 0 ||
        snapshot.realTimeBuffersLost != 0;
}

std::pair<bool, uintmax_t> InspectFinalizedEtl(HANDLE file)
{
    BY_HANDLE_FILE_INFORMATION information{};
    if (!GetFileInformationByHandle(file, &information) ||
        (information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
        return {false, 0};
    }
    ULARGE_INTEGER size{};
    size.HighPart = information.nFileSizeHigh;
    size.LowPart = information.nFileSizeLow;
    return {true, static_cast<uintmax_t>(size.QuadPart)};
}

std::optional<std::string> Sha256File(HANDLE file, uintmax_t sizeBytes)
{
    LARGE_INTEGER start{};
    if (!SetFilePointerEx(file, start, nullptr, FILE_BEGIN)) return std::nullopt;

    UniqueAlgorithmHandle algorithm;
    if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(
            algorithm.Address(),
            BCRYPT_SHA256_ALGORITHM,
            nullptr,
            0))) {
        return std::nullopt;
    }

    DWORD hashObjectLength = 0;
    DWORD resultLength = 0;
    if (!BCRYPT_SUCCESS(BCryptGetProperty(
            algorithm.Get(),
            BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&hashObjectLength),
            sizeof(hashObjectLength),
            &resultLength,
            0)) ||
        resultLength != sizeof(hashObjectLength) ||
        hashObjectLength == 0) {
        return std::nullopt;
    }

    std::vector<UCHAR> hashObject(hashObjectLength);
    UniqueHashHandle hash;
    if (!BCRYPT_SUCCESS(BCryptCreateHash(
            algorithm.Get(),
            hash.Address(),
            hashObject.data(),
            hashObjectLength,
            nullptr,
            0,
            0))) {
        return std::nullopt;
    }

    std::vector<UCHAR> buffer(kHashBufferSize);
    uintmax_t totalRead = 0;
    while (totalRead < sizeBytes) {
        auto remaining = sizeBytes - totalRead;
        auto requested = static_cast<DWORD>(std::min<uintmax_t>(
            buffer.size(),
            remaining));
        DWORD bytesRead = 0;
        if (!ReadFile(
                file,
                buffer.data(),
                requested,
                &bytesRead,
                nullptr) ||
            bytesRead == 0) {
            return std::nullopt;
        }
        if (!BCRYPT_SUCCESS(BCryptHashData(
                hash.Get(),
                buffer.data(),
                bytesRead,
                0))) {
            return std::nullopt;
        }
        totalRead += bytesRead;
    }

    std::array<UCHAR, kSha256Length> digest{};
    if (!BCRYPT_SUCCESS(BCryptFinishHash(
            hash.Get(),
            digest.data(),
            static_cast<ULONG>(digest.size()),
            0))) {
        return std::nullopt;
    }

    constexpr char hex[] = "0123456789abcdef";
    std::string result(digest.size() * 2, '0');
    for (size_t index = 0; index < digest.size(); ++index) {
        result[index * 2] = hex[(digest[index] >> 4) & 0x0f];
        result[index * 2 + 1] = hex[digest[index] & 0x0f];
    }
    return result;
}

struct FinalizedEtlEvidence {
    UniqueHandle readLease;
    bool exists = false;
    bool identityVerified = false;
    bool stableAcrossHash = false;
    uintmax_t sizeBytes = 0;
    std::string sha256 = std::string(kUnavailableSha256);
};

FinalizedEtlEvidence AcquireFinalizedEtlEvidence(
    std::filesystem::path const& path,
    ArtifactFileIdentity const& expectedIdentity)
{
    FinalizedEtlEvidence evidence;
    evidence.readLease.Reset(CreateFileW(
        path.c_str(),
        GENERIC_READ,
        FILE_SHARE_READ,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN,
        nullptr));
    if (!evidence.readLease) return evidence;

    auto identity = GetArtifactFileIdentity(evidence.readLease.Get());
    evidence.identityVerified = identity.has_value() &&
        SameArtifactFileIdentity(*identity, expectedIdentity);
    auto inspection = InspectFinalizedEtl(evidence.readLease.Get());
    evidence.exists = inspection.first;
    evidence.sizeBytes = inspection.second;
    if (!evidence.identityVerified || !evidence.exists || evidence.sizeBytes == 0) {
        evidence.readLease.Reset();
        return evidence;
    }

    auto sha256 = Sha256File(evidence.readLease.Get(), evidence.sizeBytes);
    if (!sha256.has_value()) {
        evidence.readLease.Reset();
        return evidence;
    }

    auto identityAfterHash = GetArtifactFileIdentity(
        evidence.readLease.Get());
    auto inspectionAfterHash = InspectFinalizedEtl(
        evidence.readLease.Get());
    evidence.stableAcrossHash = identityAfterHash.has_value() &&
        SameArtifactFileIdentity(
            *identityAfterHash,
            expectedIdentity) &&
        inspectionAfterHash.first &&
        inspectionAfterHash.second == evidence.sizeBytes;
    if (!evidence.stableAcrossHash) {
        evidence.readLease.Reset();
        return evidence;
    }

    evidence.sha256 = *sha256;
    return evidence;
}

template<typename T>
std::optional<T> ReadEventScalar(
    EVENT_RECORD* eventRecord,
    wchar_t const* propertyName)
{
    PROPERTY_DATA_DESCRIPTOR descriptor{};
    descriptor.PropertyName = reinterpret_cast<ULONGLONG>(propertyName);
    descriptor.ArrayIndex = ULONG_MAX;
    ULONG size = 0;
    auto status = TdhGetPropertySize(
        eventRecord,
        0,
        nullptr,
        1,
        &descriptor,
        &size);
    if (status != ERROR_SUCCESS || size != sizeof(T)) {
        return std::nullopt;
    }
    T value{};
    status = TdhGetProperty(
        eventRecord,
        0,
        nullptr,
        1,
        &descriptor,
        size,
        reinterpret_cast<PBYTE>(&value));
    if (status != ERROR_SUCCESS) return std::nullopt;
    return value;
}

std::optional<std::wstring> ReadEventWideString(
    EVENT_RECORD* eventRecord,
    wchar_t const* propertyName)
{
    PROPERTY_DATA_DESCRIPTOR descriptor{};
    descriptor.PropertyName = reinterpret_cast<ULONGLONG>(propertyName);
    descriptor.ArrayIndex = ULONG_MAX;
    ULONG size = 0;
    auto status = TdhGetPropertySize(
        eventRecord,
        0,
        nullptr,
        1,
        &descriptor,
        &size);
    if (status != ERROR_SUCCESS ||
        size < sizeof(wchar_t) ||
        size % sizeof(wchar_t) != 0) {
        return std::nullopt;
    }
    std::vector<wchar_t> buffer(size / sizeof(wchar_t));
    status = TdhGetProperty(
        eventRecord,
        0,
        nullptr,
        1,
        &descriptor,
        size,
        reinterpret_cast<PBYTE>(buffer.data()));
    if (status != ERROR_SUCCESS || buffer.back() != L'\0') {
        return std::nullopt;
    }
    auto firstTerminator = std::find(
        buffer.begin(),
        buffer.end(),
        L'\0');
    if (firstTerminator != buffer.end() - 1) return std::nullopt;
    return std::wstring(buffer.data(), buffer.size() - 1);
}

std::optional<ULONGLONG> FileTimeValue(FILETIME value)
{
    ULARGE_INTEGER ticks{};
    ticks.HighPart = value.dwHighDateTime;
    ticks.LowPart = value.dwLowDateTime;
    if (ticks.QuadPart == 0 ||
        ticks.QuadPart >
            kMaximumDotNetDateTimeTicks -
                kDotNetFileTimeEpochOffsetTicks) {
        return std::nullopt;
    }
    return ticks.QuadPart;
}

std::optional<ULONGLONG> IdentityTicksFromFileTime(ULONGLONG fileTime)
{
    if (fileTime == 0 ||
        fileTime >
            kMaximumDotNetDateTimeTicks -
                kDotNetFileTimeEpochOffsetTicks) {
        return std::nullopt;
    }
    auto ticks = fileTime + kDotNetFileTimeEpochOffsetTicks;
    return ticks - ticks % 10;
}

std::optional<std::wstring> ExecutableBasename(std::wstring imageName)
{
    auto separator = imageName.find_last_of(L"\\/");
    if (separator != std::wstring::npos) {
        imageName.erase(0, separator + 1);
    }
    if (imageName.empty() || imageName.size() > 1024) {
        return std::nullopt;
    }
    for (auto character : imageName) {
        if (character == L'\\' ||
            character == L'/' ||
            character == L'\0' ||
            character == L'\r' ||
            character == L'\n') {
            return std::nullopt;
        }
    }
    return imageName;
}

void FailProcessInspection(
    ProcessInspectionState& state,
    ULONG status = ERROR_INVALID_DATA)
{
    if (state.status == ERROR_SUCCESS) state.status = status;
}

void WINAPI ProcessInspectionEventCallback(EVENT_RECORD* eventRecord)
{
    auto state = static_cast<ProcessInspectionState*>(
        eventRecord->UserContext);
    if (state == nullptr || state->status != ERROR_SUCCESS) return;
    auto const& header = eventRecord->EventHeader;
    if (!IsEqualGUID(
            header.ProviderId,
            Microsoft_Windows_Kernel_Process::GUID)) {
        return;
    }
    auto eventId = header.EventDescriptor.Id;
    bool isStart = eventId ==
        Microsoft_Windows_Kernel_Process::ProcessStart_Start::Id;
    bool isStop = eventId ==
        Microsoft_Windows_Kernel_Process::ProcessStop_Stop::Id;
    if (!isStart && !isStop) return;

    auto processId = ReadEventScalar<ULONG>(eventRecord, L"ProcessID");
    if (!processId.has_value()) {
        FailProcessInspection(*state);
        return;
    }
    if (*processId != state->targetProcessId) return;
    if (state->events.size() >= kMaximumProcessEventCount ||
        header.TimeStamp.QuadPart <= 0) {
        FailProcessInspection(*state, ERROR_BUFFER_OVERFLOW);
        return;
    }

    auto createTime = ReadEventScalar<FILETIME>(
        eventRecord,
        L"CreateTime");
    if (!createTime.has_value()) {
        FailProcessInspection(*state);
        return;
    }
    auto createTimeValue = FileTimeValue(*createTime);
    if (!createTimeValue.has_value()) {
        FailProcessInspection(*state);
        return;
    }
    auto creationTimeUtcTicks = IdentityTicksFromFileTime(
        *createTimeValue);
    if (!creationTimeUtcTicks.has_value()) {
        FailProcessInspection(*state);
        return;
    }

    ProcessEventEvidence evidence;
    evidence.kind = isStart
        ? ProcessEventEvidence::Kind::start
        : ProcessEventEvidence::Kind::stop;
    evidence.sequence = static_cast<ULONG>(state->events.size());
    evidence.processId = *processId;
    evidence.eventVersion = header.EventDescriptor.Version;
    evidence.eventTimestampFileTimeUtc =
        static_cast<ULONGLONG>(header.TimeStamp.QuadPart);
    evidence.createTimeFileTimeUtc = *createTimeValue;
    evidence.creationTimeUtcTicks = *creationTimeUtcTicks;

    if (isStart) {
        auto parentProcessId = ReadEventScalar<ULONG>(
            eventRecord,
            L"ParentProcessID");
        auto imageName = ReadEventWideString(
            eventRecord,
            L"ImageName");
        if (!parentProcessId.has_value() || !imageName.has_value()) {
            FailProcessInspection(*state);
            return;
        }
        auto executableName = ExecutableBasename(std::move(*imageName));
        if (!executableName.has_value()) {
            FailProcessInspection(*state);
            return;
        }
        evidence.parentProcessId = *parentProcessId;
        evidence.executableName = std::move(*executableName);
    } else {
        auto exitTime = ReadEventScalar<FILETIME>(
            eventRecord,
            L"ExitTime");
        if (!exitTime.has_value()) {
            FailProcessInspection(*state);
            return;
        }
        auto exitTimeValue = FileTimeValue(*exitTime);
        if (!exitTimeValue.has_value()) {
            FailProcessInspection(*state);
            return;
        }
        evidence.exitTimeFileTimeUtc = *exitTimeValue;
    }
    state->events.push_back(std::move(evidence));
}

std::string ProcessEventsJson(
    InspectOptions const& options,
    FinalizedEtlEvidence const& etl,
    ArtifactFileIdentity const& identity,
    std::vector<ProcessEventEvidence> const& events)
{
    std::ostringstream out;
    out << "{\"version\":1,\"phase\":\"etl-process-events\","
        << "\"etlPath\":" << JsonPath(options.etlPath) << ','
        << "\"etlVolumeSerialNumber\":\""
        << identity.volumeSerialNumber << "\","
        << "\"etlFileIndex\":\"" << FileIndexHex(identity) << "\","
        << "\"etlSizeBytes\":" << etl.sizeBytes << ','
        << "\"etlSha256\":\"" << etl.sha256 << "\","
        << "\"targetProcessId\":" << options.targetProcessId << ','
        << "\"events\":[";
    for (size_t index = 0; index < events.size(); ++index) {
        if (index != 0) out << ',';
        auto const& event = events[index];
        out << "{\"kind\":\""
            << (event.kind == ProcessEventEvidence::Kind::start
                    ? "start"
                    : "stop")
            << "\",\"sequence\":" << event.sequence
            << ",\"processId\":" << event.processId
            << ",\"eventVersion\":"
            << static_cast<unsigned>(event.eventVersion)
            << ",\"eventTimestampFileTimeUtc\":\""
            << event.eventTimestampFileTimeUtc
            << "\",\"createTimeFileTimeUtc\":\""
            << event.createTimeFileTimeUtc
            << "\",\"creationTimeUtcTicks\":\""
            << event.creationTimeUtcTicks << '\"';
        if (event.kind == ProcessEventEvidence::Kind::start) {
            out << ",\"parentProcessId\":" << event.parentProcessId
                << ",\"executableName\":"
                << JsonString(event.executableName);
        } else {
            out << ",\"exitTimeFileTimeUtc\":\""
                << event.exitTimeFileTimeUtc << '\"';
        }
        out << '}';
    }
    out << "]}\r\n";
    return out.str();
}

bool WriteStandardOutput(std::string_view contents)
{
    auto output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (output == nullptr || output == INVALID_HANDLE_VALUE) return false;
    size_t offset = 0;
    while (offset < contents.size()) {
        auto chunkSize = static_cast<DWORD>(std::min<size_t>(
            contents.size() - offset,
            std::numeric_limits<DWORD>::max()));
        DWORD bytesWritten = 0;
        if (!WriteFile(
                output,
                contents.data() + offset,
                chunkSize,
                &bytesWritten,
                nullptr) ||
            bytesWritten != chunkSize) {
            return false;
        }
        offset += bytesWritten;
    }
    return true;
}

int RunInspection(InspectOptions const& options)
{
    auto etl = AcquireFinalizedEtlEvidence(
        options.etlPath,
        options.expectedEtlIdentity);
    if (!etl.readLease ||
        !etl.identityVerified ||
        !etl.stableAcrossHash ||
        etl.sizeBytes != options.expectedEtlSizeBytes ||
        etl.sha256 != options.expectedEtlSha256) {
        std::wcerr << L"accepted ETL identity or bytes did not match\n";
        return 41;
    }

    ProcessInspectionState state;
    state.targetProcessId = options.targetProcessId;
    auto etlPath = options.etlPath.native();
    EVENT_TRACE_LOGFILEW trace{};
    trace.LogFileName = etlPath.data();
    trace.ProcessTraceMode = PROCESS_TRACE_MODE_EVENT_RECORD;
    trace.EventRecordCallback = &ProcessInspectionEventCallback;
    trace.Context = &state;
    auto traceHandle = OpenTraceW(&trace);
    if (traceHandle == INVALID_PROCESSTRACE_HANDLE) {
        std::wcerr << L"OpenTraceW failed: " << GetLastError() << L'\n';
        return 42;
    }
    auto processStatus = ProcessTrace(
        &traceHandle,
        1,
        nullptr,
        nullptr);
    auto closeStatus = CloseTrace(traceHandle);
    if (processStatus != ERROR_SUCCESS ||
        closeStatus != ERROR_SUCCESS ||
        state.status != ERROR_SUCCESS ||
        trace.LogfileHeader.EventsLost != 0) {
        std::wcerr
            << L"ETL process inspection failed: process="
            << processStatus << L", close=" << closeStatus
            << L", callback=" << state.status
            << L", lost=" << trace.LogfileHeader.EventsLost << L'\n';
        return 43;
    }

    auto identityAfterReplay = GetArtifactFileIdentity(
        etl.readLease.Get());
    auto inspectionAfterReplay = InspectFinalizedEtl(
        etl.readLease.Get());
    auto sha256AfterReplay = Sha256File(
        etl.readLease.Get(),
        etl.sizeBytes);
    if (!identityAfterReplay.has_value() ||
        !SameArtifactFileIdentity(
            *identityAfterReplay,
            options.expectedEtlIdentity) ||
        !inspectionAfterReplay.first ||
        inspectionAfterReplay.second != etl.sizeBytes ||
        !sha256AfterReplay.has_value() ||
        *sha256AfterReplay != etl.sha256) {
        std::wcerr << L"accepted ETL changed during process inspection\n";
        return 44;
    }

    auto output = ProcessEventsJson(
        options,
        etl,
        *identityAfterReplay,
        state.events);
    if (!WriteStandardOutput(output)) {
        std::wcerr << L"failed to write process inspection evidence\n";
        return 45;
    }
    return 0;
}

enum class ReleaseWaitOutcome {
    released,
    invalidRecord,
    endOfFileBeforeRelease,
    guardTimedOut,
    shutdownRequested,
    readFailed
};

ReleaseWaitOutcome ReadExactReleaseRecord(
    Options const& options,
    HANDLE stopEvent)
{
    auto input = GetStdHandle(STD_INPUT_HANDLE);
    if (input == nullptr || input == INVALID_HANDLE_VALUE) {
        return ReleaseWaitOutcome::readFailed;
    }
    auto expected = std::string("RELEASE|") +
        ToUtf8(options.releaseToken) + "\r\n";
    std::string received;
    std::array<char, 128> buffer{};
    auto startedAt = GetTickCount64();
    std::optional<ULONGLONG> completeRecordReceivedAt;
    for (;;) {
        if (WaitForSingleObject(stopEvent, 0) == WAIT_OBJECT_0) {
            return ReleaseWaitOutcome::shutdownRequested;
        }
        auto now = GetTickCount64();
        if (now - startedAt >= kControllerReleaseGuardMs) {
            return ReleaseWaitOutcome::guardTimedOut;
        }
        if (completeRecordReceivedAt.has_value() &&
            now - *completeRecordReceivedAt >=
                kReleaseReadCancellationWaitMs) {
            return ReleaseWaitOutcome::invalidRecord;
        }

        DWORD available = 0;
        if (!PeekNamedPipe(
                input,
                nullptr,
                0,
                nullptr,
                &available,
                nullptr)) {
            if (GetLastError() != ERROR_BROKEN_PIPE) {
                return ReleaseWaitOutcome::readFailed;
            }
            if (received == expected) {
                return ReleaseWaitOutcome::released;
            }
            return received.empty()
                ? ReleaseWaitOutcome::endOfFileBeforeRelease
                : ReleaseWaitOutcome::invalidRecord;
        }
        if (available == 0) {
            Sleep(10);
            continue;
        }

        auto requested = static_cast<DWORD>(std::min<size_t>(
            buffer.size(),
            available));
        DWORD bytesRead = 0;
        if (!ReadFile(
                input,
                buffer.data(),
                requested,
                &bytesRead,
                nullptr)) {
            return ReleaseWaitOutcome::readFailed;
        }
        if (bytesRead == 0) {
            if (received == expected) {
                return ReleaseWaitOutcome::released;
            }
            return received.empty()
                ? ReleaseWaitOutcome::endOfFileBeforeRelease
                : ReleaseWaitOutcome::invalidRecord;
        }
        received.append(buffer.data(), bytesRead);
        if (received.size() > expected.size() ||
            expected.compare(0, received.size(), received) != 0) {
            return ReleaseWaitOutcome::invalidRecord;
        }
        if (received == expected && !completeRecordReceivedAt.has_value()) {
            completeRecordReceivedAt = GetTickCount64();
        }
    }
}

bool WriteReleaseAcknowledgment(Options const& options)
{
    auto output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (output == nullptr || output == INVALID_HANDLE_VALUE) return false;
    auto acknowledgment = std::string("RELEASED|") +
        ToUtf8(options.releaseToken) + "\r\n";
    DWORD bytesWritten = 0;
    return WriteFile(
               output,
               acknowledgment.data(),
               static_cast<DWORD>(acknowledgment.size()),
               &bytesWritten,
               nullptr) != FALSE &&
        bytesWritten == static_cast<DWORD>(acknowledgment.size());
}

int Run(Options const& options)
{
    auto pinned = PinArtifactPaths(options);
    if (!pinned.has_value()) {
        auto error = GetLastError();
        std::wcerr << L"failed to pin fresh artifact paths: " << error << L'\n';
        return error == ERROR_ALREADY_EXISTS ? 11 : 12;
    }
    auto const& operational = pinned->resolved;

    UniqueHandle stopEvent(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    UniqueHandle finalizationEvent(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    UniqueHandle callbacksDrainedEvent(CreateEventW(nullptr, TRUE, TRUE, nullptr));
    if (!stopEvent || !finalizationEvent || !callbacksDrainedEvent) {
        std::wcerr << L"CreateEventW failed: " << GetLastError() << L'\n';
        return 13;
    }
    ConsoleControlRegistration consoleControl;
    if (!consoleControl.Register(
            stopEvent.Get(),
            finalizationEvent.Get(),
            callbacksDrainedEvent.Get())) {
        std::wcerr << L"SetConsoleCtrlHandler failed: " << GetLastError() << L'\n';
        return 13;
    }

    TRACEHANDLE sessionHandle = 0;
    bool sessionOwned = false;
    ULONG startStatus = ERROR_INVALID_STATE;
    ULONG providerStatus = ERROR_INVALID_STATE;
    SessionSnapshot initial{};
    SessionSnapshot beforeStop{};
    StopOutcome stopOutcome{};
    DWORD waitStatus = WAIT_FAILED;
    bool filterEventIds = false;
    bool processEventsEnabled = false;
    bool etlIdentityVerifiedForCapture = false;
    bool etlIdentityVerifiedAfterStop = false;
    ULONGLONG captureStartFileTimeUtc = 0;

    try {
        auto startProperties = MakeStartProperties(operational.etlPath);
        if (!PathIdentifiesArtifact(
                operational.etlPath,
                pinned->etlIdentity)) {
            startStatus = ERROR_FILE_INVALID;
            std::wcerr << L"ETL reservation path identity changed before StartTraceW\n";
        } else {
            captureStartFileTimeUtc = FileTimeTicksUtc();
            startStatus = StartTraceW(
                &sessionHandle,
                options.sessionName.c_str(),
                &startProperties.properties);
        }
        if (startStatus != ERROR_SUCCESS) {
            sessionHandle = 0;
            std::wcerr << L"StartTraceW failed: " << startStatus << L'\n';
        } else {
            sessionOwned = true;
            etlIdentityVerifiedForCapture = PathIdentifiesArtifact(
                operational.etlPath,
                pinned->etlIdentity);
            if (!etlIdentityVerifiedForCapture) {
                providerStatus = ERROR_FILE_INVALID;
                std::wcerr << L"ETL reservation path identity changed during StartTraceW\n";
            } else {
                PMTraceConsumer consumer;
                consumer.mTrackDisplay = true;
                consumer.mTrackGPU = false;
                consumer.mTrackGPUVideo = false;
                consumer.mTrackInput = false;
                consumer.mTrackFrameType = false;
                consumer.mTrackPMMeasurements = false;
                consumer.mTrackAppTiming = false;
                consumer.mTrackHybridPresent = false;
                consumer.mTrackPcLatency = false;
                // The candidate is created only after ready evidence is accepted,
                // so live ProcessStart/ProcessStop events are sufficient. Do not
                // request the full-system ProcessRundown capture state.
                consumer.mTrackProcessState = false;

                auto filteringCapabilities = DetectFilteringCapabilities();
                filterEventIds = filteringCapabilities.first;
                auto isWin11OrGreater = filteringCapabilities.second;
                consumer.mFilteredEvents = filterEventIds;
                if (!filterEventIds) {
                    providerStatus = ERROR_NOT_SUPPORTED;
                    std::wcerr << L"event-ID filtering is unavailable\n";
                } else {
                    providerStatus = EnableProvidersListing(
                        sessionHandle,
                        &startProperties.properties.Wnode.Guid,
                        &consumer,
                        filterEventIds,
                        isWin11OrGreater);
                    if (providerStatus == ERROR_SUCCESS) {
                        // Replace PresentMon's process-provider filter with the
                        // exact required live events and wait for provider
                        // callbacks before publishing the ready boundary.
                        providerStatus = EnableRequiredLiveProcessEvents(
                            sessionHandle,
                            startProperties.properties.Wnode.Guid);
                    }
                    processEventsEnabled = providerStatus == ERROR_SUCCESS;
                }
                if (providerStatus != ERROR_SUCCESS) {
                    std::wcerr << L"required provider enablement failed: " << providerStatus << L'\n';
                } else {
                    initial = Snapshot(sessionHandle);
                    if (initial.queryStatus != ERROR_SUCCESS || HasLoss(initial)) {
                        std::wcerr << L"initial ETW session query failed or reported loss\n";
                    } else if (!PublishFreshFile(
                                   pinned->readyTemporary.Get(),
                                   operational.readyPath,
                                   ReadyJson(
                                       options,
                                       operational.etlPath,
                                       pinned->etlIdentity,
                                       etlIdentityVerifiedForCapture,
                                       captureStartFileTimeUtc,
                                       initial,
                                       filterEventIds,
                                       processEventsEnabled,
                                       isWin11OrGreater))) {
                        auto publishError = GetLastError();
                        std::wcerr
                            << L"failed to publish ready sidecar: "
                            << publishError << L'\n';
                    } else {
                        waitStatus = WaitForSingleObject(
                            stopEvent.Get(),
                            options.durationMs);
                    }
                }
            }
        }
    } catch (std::exception const& error) {
        std::cerr << "recorder exception: " << error.what() << '\n';
    }

    if (sessionOwned) {
        beforeStop = Snapshot(sessionHandle);
        stopOutcome = StopSessionDeterministically(sessionHandle);
        if (!stopOutcome.etlFinalized) {
            std::wcerr << L"ETW session could not be stopped deterministically\n";
        }
    }

    FinalizedEtlEvidence finalizedEtl;
    if (stopOutcome.etlFinalized) {
        auto pathIdentityVerifiedAfterStop = PathIdentifiesArtifact(
            operational.etlPath,
            pinned->etlIdentity);
        pinned->etlReservation.Reset();
        finalizedEtl = AcquireFinalizedEtlEvidence(
            operational.etlPath,
            pinned->etlIdentity);
        etlIdentityVerifiedAfterStop =
            pathIdentityVerifiedAfterStop &&
            finalizedEtl.identityVerified &&
            finalizedEtl.stableAcrossHash;
    }

    bool valid = startStatus == ERROR_SUCCESS &&
        providerStatus == ERROR_SUCCESS &&
        etlIdentityVerifiedForCapture &&
        etlIdentityVerifiedAfterStop &&
        filterEventIds &&
        processEventsEnabled &&
        initial.queryStatus == ERROR_SUCCESS &&
        waitStatus == WAIT_TIMEOUT &&
        beforeStop.queryStatus == ERROR_SUCCESS &&
        stopOutcome.primaryStatus == ERROR_SUCCESS &&
        stopOutcome.cleanupStatus == ERROR_SUCCESS &&
        stopOutcome.etlFinalized &&
        stopOutcome.stopped.queryStatus == ERROR_SUCCESS &&
        !HasLoss(initial) &&
        !HasLoss(beforeStop) &&
        !HasLoss(stopOutcome.stopped) &&
        stopOutcome.captureStopFileTimeUtc >
            captureStartFileTimeUtc &&
        finalizedEtl.exists &&
        finalizedEtl.stableAcrossHash &&
        finalizedEtl.sizeBytes > 0 &&
        finalizedEtl.sha256 != kUnavailableSha256 &&
        static_cast<bool>(finalizedEtl.readLease);

    std::string statusJson;
    try {
        statusJson = StatusJson(
            options,
            operational.etlPath,
            pinned->etlIdentity,
            etlIdentityVerifiedForCapture,
            etlIdentityVerifiedAfterStop,
            captureStartFileTimeUtc,
            stopOutcome.captureStopFileTimeUtc,
            startStatus,
            providerStatus,
            filterEventIds,
            processEventsEnabled,
            initial,
            waitStatus,
            beforeStop,
            stopOutcome,
            finalizedEtl.exists,
            finalizedEtl.sizeBytes,
            finalizedEtl.sha256,
            valid,
            valid);
    } catch (std::exception const& error) {
        std::cerr << "completion sidecar exception: " << error.what() << '\n';
        return 26;
    }
    if (!PublishFreshFile(
            pinned->statusTemporary.Get(),
            operational.statusPath,
            statusJson)) {
        auto publishError = GetLastError();
        std::wcerr
            << L"failed to publish completion sidecar: "
            << publishError << L'\n';
        return 26;
    }

    if (valid) {
        auto releaseOutcome = ReadExactReleaseRecord(
            options,
            stopEvent.Get());
        switch (releaseOutcome) {
        case ReleaseWaitOutcome::released:
            break;
        case ReleaseWaitOutcome::invalidRecord:
            std::wcerr << L"controller release record was invalid\n";
            return 29;
        case ReleaseWaitOutcome::endOfFileBeforeRelease:
            std::wcerr << L"controller release pipe closed before release\n";
            return 31;
        case ReleaseWaitOutcome::guardTimedOut:
            std::wcerr << L"controller release guard timed out\n";
            return 32;
        case ReleaseWaitOutcome::shutdownRequested:
            std::wcerr << L"shutdown requested while ETL lease was held\n";
            return 33;
        case ReleaseWaitOutcome::readFailed:
            std::wcerr << L"controller release pipe read failed\n";
            return 34;
        }
        finalizedEtl.readLease.Reset();
        if (!WriteReleaseAcknowledgment(options)) {
            std::wcerr << L"failed to write controller release acknowledgment\n";
            return 30;
        }
        return 0;
    }
    if (startStatus != ERROR_SUCCESS) return 20;
    if (!etlIdentityVerifiedForCapture ||
        !etlIdentityVerifiedAfterStop) return 28;
    if (providerStatus != ERROR_SUCCESS ||
        !filterEventIds ||
        !processEventsEnabled) return 21;
    if (initial.queryStatus != ERROR_SUCCESS ||
        beforeStop.queryStatus != ERROR_SUCCESS ||
        (stopOutcome.etlFinalized &&
            stopOutcome.stopped.queryStatus != ERROR_SUCCESS)) return 22;
    if (!stopOutcome.etlFinalized ||
        stopOutcome.primaryStatus != ERROR_SUCCESS ||
        stopOutcome.cleanupStatus != ERROR_SUCCESS) return 23;
    if (HasLoss(initial) ||
        HasLoss(beforeStop) ||
        HasLoss(stopOutcome.stopped)) return 24;
    if (!finalizedEtl.exists ||
        finalizedEtl.sizeBytes == 0 ||
        finalizedEtl.sha256 == kUnavailableSha256 ||
        !finalizedEtl.readLease) return 25;
    return 27;
}

} // namespace

int wmain(int argc, wchar_t** argv)
{
    if (argc > 1 && std::wstring_view(argv[1]) == L"--inspect-etl") {
        auto options = ParseInspectOptions(argc, argv);
        if (!options.has_value()) {
            std::wcerr
                << L"usage: WokEtlRecorder --inspect-etl absolute.etl "
                << L"--expected-etl-sha256 64-lowercase-hex "
                << L"--expected-etl-size-bytes positive-safe-integer "
                << L"--expected-etl-file-index 16-lowercase-hex "
                << L"--expected-etl-volume-serial-number canonical-uint32 "
                << L"--target-process-id positive-uint32\n";
            return 40;
        }
        return RunInspection(*options);
    }

    auto options = ParseOptions(argc, argv);
    if (!options.has_value()) {
        std::wcerr
            << L"usage: WokEtlRecorder --session-name name --etl-file absolute.etl "
            << L"--ready-file absolute.json --status-file absolute.json "
            << L"--duration-ms 100..600000 --release-token 32-lowercase-hex\n";
        return 10;
    }
    return Run(*options);
}

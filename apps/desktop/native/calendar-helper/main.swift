import EventKit
import Foundation

// Protocol v1: exactly one JSON command on stdin and one JSON response on stdout.
// Only request-full-access may cause a macOS permission prompt.
private let maxInputBytes = 16 * 1024
private let maxListDays: TimeInterval = 31 * 24 * 60 * 60
private let maxEventDays: TimeInterval = 7 * 24 * 60 * 60

private enum HelperError: Error {
    case code(String)
}

private func fail(_ code: String) throws -> Never { throw HelperError.code(code) }

private func readCommand() throws -> [String: Any] {
    var data = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: maxInputBytes + 1 - data.count), !chunk.isEmpty {
        data.append(chunk)
        if data.count > maxInputBytes { try fail("input_too_large") }
    }
    guard !data.isEmpty,
          let object = try? JSONSerialization.jsonObject(with: data),
          let command = object as? [String: Any] else {
        try fail("invalid_json")
    }
    return command
}

private func string(_ object: [String: Any], _ key: String, max: Int, required: Bool = true) throws -> String? {
    guard let value = object[key] else {
        if required { try fail("invalid_input") }
        return nil
    }
    guard let value = value as? String,
          !value.isEmpty, value.utf8.count <= max,
          !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
        try fail("invalid_input")
    }
    return value
}

private func date(_ object: [String: Any], _ key: String) throws -> Date {
    let value = try string(object, key, max: 40)!
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    guard let date = formatter.date(from: value) else { try fail("invalid_date") }
    return date
}

private func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

private func authorization() -> String {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .writeOnly: return "writeOnly"
    case .fullAccess: return "fullAccess"
    @unknown default: return "unknown"
    }
}

private func eventJSON(_ event: EKEvent) -> [String: Any] {
    [
        "id": event.eventIdentifier ?? "",
        "title": event.title ?? "",
        "start": iso(event.startDate),
        "end": iso(event.endDate),
        "isAllDay": event.isAllDay,
        "calendarId": event.calendar.calendarIdentifier,
    ]
}

private func selectedCalendars(_ input: [String: Any], store: EKEventStore) throws -> [EKCalendar]? {
    guard let raw = input["calendarIds"] else { return nil }
    guard let ids = raw as? [String], !ids.isEmpty, ids.count <= 20,
          Set(ids).count == ids.count,
          ids.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 }) else {
        try fail("invalid_input")
    }
    let calendars = ids.compactMap { store.calendar(withIdentifier: $0) }
    guard calendars.count == ids.count, calendars.allSatisfy({ $0.allowedEntityTypes.contains(.event) }) else {
        try fail("calendar_not_found")
    }
    return calendars
}

private func run(_ input: [String: Any]) async throws -> [String: Any] {
    guard let command = input["command"] as? String else { try fail("invalid_command") }
    switch command {
    case "status":
        guard Set(input.keys) == ["command"] else { try fail("invalid_input") }
        return ["ok": true, "command": command, "authorization": authorization()]
    case "request-full-access":
        guard Set(input.keys) == ["command"] else { try fail("invalid_input") }
        let store = EKEventStore()
        do {
            _ = try await store.requestFullAccessToEvents()
        } catch {
            // Never expose EventKit error text: it may include local account data.
            try fail("permission_request_failed")
        }
        return ["ok": true, "command": command, "authorization": authorization()]
    case "list-events":
        guard Set(input.keys).isSubset(of: ["command", "start", "end", "limit", "calendarIds"]) else {
            try fail("invalid_input")
        }
        let start = try date(input, "start")
        let end = try date(input, "end")
        guard end > start, end.timeIntervalSince(start) <= maxListDays else { try fail("invalid_range") }
        let limit: Int
        if let raw = input["limit"] {
            guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.intValue >= 1, number.intValue <= 200,
                  number.doubleValue == Double(number.intValue) else { try fail("invalid_input") }
            limit = number.intValue
        } else {
            limit = 100
        }
        guard authorization() == "fullAccess" else { try fail("full_access_required") }
        let store = EKEventStore()
        let calendars = try selectedCalendars(input, store: store)
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
        var selected: [EKEvent] = []
        var truncated = false
        store.enumerateEvents(matching: predicate) { event, stop in
            if selected.count == limit {
                truncated = true
                stop.pointee = true
            } else {
                selected.append(event)
            }
        }
        return [
            "ok": true, "command": command,
            "events": selected.map(eventJSON),
            "truncated": truncated,
        ]
    case "create-event":
        guard Set(input.keys).isSubset(of: ["command", "title", "start", "end", "calendarId"]) else {
            try fail("invalid_input")
        }
        let title = try string(input, "title", max: 200)!
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { try fail("invalid_input") }
        let start = try date(input, "start")
        let end = try date(input, "end")
        guard end > start, end.timeIntervalSince(start) <= maxEventDays else { try fail("invalid_range") }
        let calendarId = try string(input, "calendarId", max: 256, required: false)
        guard authorization() == "fullAccess" else { try fail("full_access_required") }
        let store = EKEventStore()
        let calendar = calendarId.flatMap { store.calendar(withIdentifier: $0) } ?? store.defaultCalendarForNewEvents
        guard let calendar = calendar, calendar.allowsContentModifications,
              calendar.allowedEntityTypes.contains(.event),
              calendarId == nil || calendar.calendarIdentifier == calendarId else {
            try fail("calendar_not_writable")
        }
        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = start
        event.endDate = end
        event.calendar = calendar
        do { try store.save(event, span: .thisEvent) }
        catch { try fail("event_save_failed") }
        return ["ok": true, "command": command, "event": eventJSON(event)]
    default:
        try fail("invalid_command")
    }
}

private func output(_ response: [String: Any]) {
    let fallback = Data("{\"ok\":false,\"code\":\"internal_error\"}".utf8)
    let data = (try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])) ?? fallback
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

do {
    let input = try readCommand()
    let response = try await run(input)
    output(response)
} catch HelperError.code(let code) {
    output(["ok": false, "code": code])
} catch {
    output(["ok": false, "code": "internal_error"])
}

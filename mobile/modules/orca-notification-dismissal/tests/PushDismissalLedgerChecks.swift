import Foundation
@main struct PushDismissalLedgerChecks {
 static func main() {
  let suite = "orca.qa.dismissal." + UUID().uuidString
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  func identity(_ seq: Int, _ host: String = "qa-host", _ epoch: String = "qa-epoch") -> PushDismissalIdentity {
   PushDismissalIdentity(["hostFingerprint": host, "notificationId": "qa-alert", "notificationEpoch": epoch, "notificationSeq": seq])!
  }
  let ledger = PushDismissalLedger(defaults: defaults)
  ledger.remember(identity(2), now: 100)
  ledger.remember(identity(1), now: 101)
  let restored = PushDismissalLedger(defaults: defaults)
  precondition(restored.contains(identity(1), now: 102))
  precondition(restored.contains(identity(2), now: 102))
  precondition(!restored.contains(identity(3), now: 102))
  precondition(!restored.contains(identity(1, "other"), now: 102))
  precondition(!restored.contains(identity(1, "qa-host", "other"), now: 102))
  precondition(!restored.contains(identity(1), now: 86501))
  precondition(PushDismissalIdentity(["hostFingerprint":"h", "notificationId":"n", "notificationEpoch":"e", "notificationSeq":true]) == nil)
  let first: [String: Any] = ["notificationId": "qa-alert", "notificationEpoch": "qa-epoch", "notificationSeq": 1]
  let second: [String: Any] = ["notificationId": "qa-second", "notificationEpoch": "qa-epoch", "notificationSeq": 2]
  let summary: [String: Any] = ["hostFingerprint": "qa-host", "coalescedCount": 2, "summaryMembers": [first, second]]
  precondition(!restored.containsNotification(summary, now: 102))
  var secondFence = second
  secondFence["hostFingerprint"] = "qa-host"
  restored.remember(PushDismissalIdentity(secondFence)!, now: 102)
  precondition(restored.containsNotification(summary, now: 103))
  var newer = second; newer["notificationSeq"] = 3
  precondition(!restored.containsNotification(["hostFingerprint": "qa-host", "coalescedCount": 2, "summaryMembers": [first, newer]], now: 103))
  precondition(!restored.containsNotification(["hostFingerprint": "other", "coalescedCount": 2, "summaryMembers": [first, second]], now: 103))
  precondition(!restored.containsNotification(["hostFingerprint": "qa-host", "coalescedCount": 2, "summaryMembers": [first]], now: 103))
  precondition(!restored.containsNotification(["hostFingerprint": "qa-host", "coalescedCount": 2, "notificationId": "qa-alert", "notificationEpoch": "qa-epoch", "notificationSeq": 1], now: 103))
  print("Native persisted fence: restart, ordering, identity isolation, expiry and invalid sequence checks passed")
 }
}

/// A step through the Tray, as Next and Previous Finding take it.
public enum TrayStep: Sendable {
    case next, previous
}

extension ReviewSession {
    /// The Finding one step from `current` in the Tray's display order,
    /// which is newest first: Next is the row below, Previous the row above.
    /// Filed and mid-ladder rows count, since they open like any other.
    /// Past either end the answer is nil rather than a wrap, so the disabled
    /// menu item marks the end as in Mail and Finder. With no current row,
    /// or one no longer in the tray, Next enters at the newest row and
    /// Previous at the oldest.
    public func finding(_ step: TrayStep, from current: TrayItem.ID?) -> TrayItem.ID? {
        let displayed = tray.reversed().map(\.id)
        guard let index = current.flatMap(displayed.firstIndex(of:)) else {
            return step == .next ? displayed.first : displayed.last
        }
        let target = step == .next ? index + 1 : index - 1
        return displayed.indices.contains(target) ? displayed[target] : nil
    }
}

extension EditorState {
    /// Next or Previous Finding, or nil when the step has nowhere to go or
    /// `selecting` refuses it, so the menu item and the step read one rule.
    public func stepping(_ step: TrayStep, in session: ReviewSession?) -> EditorState? {
        session?.finding(step, from: target).flatMap { selecting($0, in: session) }
    }
}

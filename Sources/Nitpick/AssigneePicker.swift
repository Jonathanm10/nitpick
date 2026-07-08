import NitpickCore
import SwiftUI

/// A searchable people-picker over the project's assignable users (glossary:
/// Assignee). Unassigned is a first-class choice. Shown only when the
/// session schema offered users; a click opens a filterable list so
/// choosing stays fast on a large team (PRD story 13).
struct AssigneePicker: View {
    let assignees: [FindingAssignee]
    @Binding var selection: FindingAssignee?
    var disabled: Bool

    @State private var showingList = false
    @State private var query = ""

    private var matches: [FindingAssignee] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return assignees }
        return assignees.filter {
            $0.fullName.localizedCaseInsensitiveContains(trimmed)
                || $0.login.localizedCaseInsensitiveContains(trimmed)
        }
    }

    var body: some View {
        Button {
            showingList = true
        } label: {
            HStack(spacing: 8) {
                Text(selection?.fullName ?? "Unassigned")
                    .foregroundStyle(selection == nil ? NitpickTheme.secondaryText : Color.primary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(NitpickTheme.secondaryText)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .nitpickField(minHeight: 34)
        .disabled(disabled)
        .motionPressFeedback()
        .popover(isPresented: $showingList, arrowEdge: .bottom) {
            VStack(spacing: 0) {
                TextField("Search people", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .padding(10)
                Divider()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        row(for: nil, label: "Unassigned")
                        ForEach(matches, id: \.self) { user in
                            row(for: user, label: user.fullName)
                        }
                    }
                }
                .frame(maxHeight: 260)
            }
            .frame(width: 300)
        }
    }

    private func row(for user: FindingAssignee?, label: String) -> some View {
        Button {
            selection = user
            query = ""
            showingList = false
        } label: {
            HStack {
                Text(label)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if user == selection {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

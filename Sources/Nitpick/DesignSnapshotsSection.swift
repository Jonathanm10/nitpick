import AppKit
import NitpickCore
import SwiftUI
import UniformTypeIdentifiers

struct DesignSnapshotsSection: View {
    @Bindable var model: AppModel
    @State private var choosingFile = false
    @State private var previewedSnapshot: DesignSnapshot?
    @State private var replacementTarget: DesignSnapshot.ID?
    @State private var pendingRemoval: DesignSnapshot?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Design Snapshots")
                    .nitpickSectionLabel()
                Spacer()
                Button {
                    replacementTarget = nil
                    choosingFile = true
                } label: {
                    Label("Add", systemImage: "plus")
                }
                .buttonStyle(.borderless)
                .disabled(model.isBusy)
                Button {
                    pasteImage()
                } label: {
                    Label("Paste", systemImage: "doc.on.clipboard")
                }
                .buttonStyle(.borderless)
                .disabled(model.isBusy)
            }

            if model.designSnapshots.isEmpty {
                Text("Add a PNG from the design.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(model.designSnapshots) { snapshot in
                            DesignSnapshotCard(
                                snapshot: snapshot,
                                disabled: model.isBusy,
                                preview: { previewedSnapshot = snapshot },
                                rename: { model.renameDesignSnapshot(snapshot.id, to: $0) },
                                replace: {
                                    replacementTarget = snapshot.id
                                    choosingFile = true
                                },
                                remove: { pendingRemoval = snapshot }
                            )
                        }
                    }
                }
                .scrollIndicators(.visible)
            }
            if let message = model.designSnapshotErrorMessage {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .fileImporter(
            isPresented: $choosingFile,
            allowedContentTypes: [.png, .jpeg],
            allowsMultipleSelection: replacementTarget == nil
        ) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                if let replacementTarget {
                    model.replaceDesignSnapshot(replacementTarget, from: url)
                } else {
                    model.addDesignSnapshots(from: urls)
                }
            case .failure(let error):
                model.reportDesignSnapshotError(error.localizedDescription)
            }
            replacementTarget = nil
        }
        .sheet(item: $previewedSnapshot) { snapshot in
            DesignSnapshotPreview(snapshot: snapshot)
        }
        .confirmationDialog(
            "Remove \(pendingRemoval?.name ?? "Design Snapshot")?",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            )
        ) {
            Button("Remove", role: .destructive) {
                if let pendingRemoval { model.removeDesignSnapshot(pendingRemoval.id) }
                pendingRemoval = nil
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: {
            Text("The image will no longer be filed with this Finding.")
        }
        .dropDestination(for: URL.self) { urls, _ in
            model.addDesignSnapshots(from: urls)
            return !urls.isEmpty
        }
    }

    private func pasteImage() {
        guard let image = NSImage(pasteboard: .general),
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:])
        else {
            model.reportDesignSnapshotError("The clipboard does not contain a readable image.")
            return
        }
        model.addPastedDesignSnapshot(png)
    }
}

private struct DesignSnapshotCard: View {
    let snapshot: DesignSnapshot
    let disabled: Bool
    let preview: () -> Void
    let rename: (String) -> Void
    let replace: () -> Void
    let remove: () -> Void
    @State private var name: String
    @State private var hovering = false
    @FocusState private var removeFocused: Bool

    init(
        snapshot: DesignSnapshot,
        disabled: Bool,
        preview: @escaping () -> Void,
        rename: @escaping (String) -> Void,
        replace: @escaping () -> Void,
        remove: @escaping () -> Void
    ) {
        self.snapshot = snapshot
        self.disabled = disabled
        self.preview = preview
        self.rename = rename
        self.replace = replace
        self.remove = remove
        _name = State(initialValue: snapshot.name)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ZStack(alignment: .topTrailing) {
                Button(action: preview) {
                    if let image = NSImage(data: snapshot.data) {
                        Image(nsImage: image)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 104, height: 72)
                            .clipped()
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
                .buttonStyle(.plain)
                DesignSnapshotRemoveButton(action: remove)
                    .focused($removeFocused)
                    .opacity(hovering || removeFocused ? 1 : 0)
                    .padding(4)
            }
            TextField("Snapshot name", text: $name)
                .font(.caption2)
                .textFieldStyle(.plain)
                .frame(width: 104)
                .onSubmit { rename(name) }
                .onChange(of: snapshot.name) { _, newName in name = newName }
            HStack(spacing: 8) {
                Button("Replace", action: replace)
            }
            .font(.caption2)
            .buttonStyle(.borderless)
        }
        .disabled(disabled)
        .onHover { hovering = $0 }
    }
}

private struct DesignSnapshotRemoveButton: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(NitpickTheme.secondaryText)
                .frame(width: 18, height: 18)
                .background(hovering ? NitpickTheme.hover : Color.white.opacity(0.8), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("Remove Design Snapshot")
        .accessibilityLabel("Remove Design Snapshot")
        .motionPressFeedback()
    }
}

private struct DesignSnapshotPreview: View {
    @Environment(\.dismiss) private var dismiss
    let snapshot: DesignSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(snapshot.name)
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            if let image = NSImage(data: snapshot.data) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding()
        .frame(minWidth: 600, minHeight: 480)
    }
}
